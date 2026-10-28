#!/usr/bin/env python3
"""Summarize health samples; does not equate process health to WeChat login."""
import argparse
from collections import Counter
import datetime as dt
import json
from pathlib import Path


def summarize(rows, interval=300):
    errors, states, identities, resources = Counter(), Counter(), {}, {}
    bad, gaps, previous = [], [], None
    for row in rows:
        at = dt.datetime.fromisoformat(row['at'])
        if previous is not None:
            elapsed = (at - previous).total_seconds()
            if elapsed > interval * 1.6 or elapsed <= 0:
                gaps.append({'at': row['at'], 'seconds': elapsed})
        previous = at
        c = row.get('checks', {})
        reasons = list(row.get('errors', {}))
        errors.update(reasons)
        if c.get('registration', {}).get('state') != 'ready':
            reasons.append('registration-not-ready')
        if not c.get('cuaHealth', {}).get('rpcOk'):
            reasons.append('health-rpc-unavailable')
        if not all(c.get('desktopProcesses', {}).get(p) for p in ('wechat', 'cua-spacesd', 'Xvnc')):
            reasons.append('desktop-process-missing')
        control_state = c.get('control', {}).get('state', 'unknown')
        states[control_state] += 1
        if control_state in ('faulted', 'maintenance', 'unknown'):
            reasons.append('control-needs-review:' + control_state)
        for resource in c.get('resources', []):
            ranges = resources.setdefault(resource['Name'], {})
            for field in ('CPUPerc', 'MemPerc', 'PIDs'):
                try:
                    value = float(resource[field].rstrip('%'))
                except (KeyError, ValueError):
                    continue
                values = ranges.setdefault(field, {'first': value, 'last': value, 'min': value, 'max': value})
                values.update(last=value, min=min(values['min'], value), max=max(values['max'], value))
        for container in c.get('containers', []):
            name = container['name']
            identities.setdefault(name, set()).add((container['id'], container['startedAt'], container['restartCount']))
            if container['status'] != 'running' or container['oomKilled']:
                reasons.append('container-unhealthy:' + name)
        if reasons:
            bad.append({'at': row['at'], 'reasons': sorted(set(reasons))})
    return {'samples': len(rows), 'firstAt': rows[0]['at'] if rows else None,
            'lastAt': rows[-1]['at'] if rows else None,
            'spanHours': (dt.datetime.fromisoformat(rows[-1]['at']) - dt.datetime.fromisoformat(rows[0]['at'])).total_seconds() / 3600 if rows else 0,
            'probeErrors': dict(errors), 'controlStates': dict(states), 'unhealthySamples': bad,
            'samplingGaps': gaps, 'resourceRanges': resources, 'containerIdentityCounts': {k: len(v) for k, v in identities.items()},
            'scope': 'Infrastructure sampling only; WeChat login and GUI usability need a fresh manual check.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('samples')
    parser.add_argument('--interval', type=int, default=300)
    args = parser.parse_args()
    rows, malformed = [], 0
    for line in Path(args.samples).read_text().splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            malformed += 1
    result = summarize(rows, args.interval)
    result['malformedLines'] = malformed
    print(json.dumps(result, indent=2))
