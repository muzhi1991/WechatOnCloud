#!/usr/bin/env python3
"""Bounded, read-only deployment health sampling. Never reads chat DB/UI content."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=25).stdout


def request(url, token, payload=None, grpc=False):
    data = b'\0' * 5 if grpc else (json.dumps(payload).encode() if payload is not None else None)
    req = urllib.request.Request(url, data=data, headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/grpc-web+proto' if grpc else 'application/json',
        **({'x-grpc-web': '1'} if grpc else {}),
    })
    with urllib.request.urlopen(req, timeout=15) as response:
        body = response.read(2 * 1024 * 1024)
    if not grpc:
        return json.loads(body)
    i, trailers = 0, []
    while i + 5 <= len(body):
        flag, size = body[i], int.from_bytes(body[i+1:i+5], 'big')
        i += 5
        if i + size > len(body):
            raise ValueError('truncated grpc frame')
        if flag == 128:
            trailers.append(body[i:i+size].decode())
        i += size
    if i != len(body) or len(trailers) != 1 or not re.search(r'(?:^|\r?\n)grpc-status:\s*0(?:\r?\n|$)', trailers[0]):
        raise ValueError('grpc health not successful')
    return {'rpcOk': True}  # Successful health RPC, not evidence of WeChat login.


def sample(config):
    result = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'checks': {}, 'errors': {}}
    expected = config.get('requiredProcesses', ['wechat', 'cua-spacesd', 'Xvnc'])
    result['requiredProcesses'] = expected
    def check(name, fn):
        try:
            value = fn()
            result['checks'][name] = value
            return value
        except Exception as error:
            # No exception body, URLs, argv, response payload, or credentials in logs.
            result['errors'][name] = type(error).__name__
            return None
    def containers():
        rows = json.loads(command(['docker', 'inspect', *config['containers']]))
        return [{'name': r['Name'].lstrip('/'), 'id': r['Id'], 'image': r['Image'],
                 'status': r['State']['Status'], 'startedAt': r['State']['StartedAt'],
                 'restartCount': r['RestartCount'], 'oomKilled': r['State']['OOMKilled'],
                 'health': r['State'].get('Health', {}).get('Status')} for r in rows]
    check('containers', containers)
    check('resources', lambda: [json.loads(line) for line in command([
        'docker', 'stats', '--no-stream', '--format', '{{json .}}', *config['containers']]).splitlines()])
    def processes():
        names = {line.split()[-1] for line in command(['docker', 'top', config['desktopContainer'], '-eo', 'pid,comm']).splitlines() if line.split()}
        return {name: name in names for name in expected}
    check('desktopProcesses', processes)
    def snapshot():
        s = request(config['panelUrl'] + '/api/integrations/cua/snapshot', Path(config['syncTokenFile']).read_text().strip())
        if s['deploymentId'] != config['deploymentId']:
            raise ValueError('deployment changed')
        row = next(r for r in s['records'] if r['id'] == config['instance'])
        result['checks']['registration'] = {k: row[k] for k in ('id', 'generation', 'state')}
        if row['endpoint'] != config['endpoint'] or not row.get('token'):
            raise ValueError('unexpected or unavailable endpoint')
        return row['token']
    # Keep secret-bearing snapshot only in memory; never attach it to result.
    try:
        token = snapshot()
        check('cuaHealth', lambda: request(config['endpoint'] + '/cua.env.v1.SystemService/Health', token, grpc=True))
    except Exception as error:
        result['errors']['registration'] = type(error).__name__
    def control():
        c = request(config['panelUrl'] + '/api/integrations/control/' + config['instance'] + '/status',
                    Path(config['agentTokenFile']).read_text().strip(),
                    {'clientId': '2a6f2d04-35e9-4d24-b970-26dd5de8ea88', 'label': 'P5 read-only soak'})
        return {k: c.get(k) for k in ('state', 'generation', 'inflight', 'pending')}
    check('control', control)
    check('hostUptimeSeconds', lambda: float(Path('/proc/uptime').read_text().split()[0]))
    check('diskFreeBytes', lambda: os.statvfs(config['outputDir']).f_bavail * os.statvfs(config['outputDir']).f_frsize)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    out = Path(config['outputDir'])
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    duration = min(max(config.get('durationHours', 36), 0.1), 48) * 3600
    interval = max(config.get('intervalSeconds', 300), 60)
    deadline = time.monotonic() + duration
    meta = {'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'durationSeconds': duration,
            'intervalSeconds': interval, 'instance': config['instance'], 'mode': 'once' if args.once else 'watch'}
    (out / 'run.json').write_text(json.dumps(meta, indent=2))
    while True:
        started = time.monotonic()
        result = sample(config)
        line = json.dumps(result, separators=(',', ':'))
        with (out / 'samples.jsonl').open('a') as target:
            target.write(line + '\n')
        (out / 'latest.tmp').write_text(line)
        if (out / 'latest.json').exists():
            (out / 'latest.json').replace(out / 'previous.json')
        (out / 'latest.tmp').replace(out / 'latest.json')
        print(json.dumps({'at': result['at'], 'errors': result['errors']}), flush=True)
        if args.once or time.monotonic() >= deadline:
            break
        time.sleep(max(0, min(interval - (time.monotonic() - started), deadline - time.monotonic())))
    (out / 'finished.json').write_text(json.dumps({'finishedAt': dt.datetime.now(dt.timezone.utc).isoformat()}))


if __name__ == '__main__':
    main()
