#!/usr/bin/env python3
"""Run on the Docker host. Add only the read service; never restart the desktop.

Requires an existing verified account vault. No scans or key output. Configuration
and generated service credentials are private; the public source contains neither.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument('--container', required=True)
    p.add_argument('--machine-id', required=True)
    p.add_argument('--account-root', required=True, help='Absolute account directory inside /config')
    p.add_argument('--vault', required=True, help='Host path to the existing verified keys file')
    p.add_argument('--binary', required=True, help='Host path to the verified Linux wx binary')
    p.add_argument('--image-kvcomm', help='Optional private directory of previously saved kvcomm filenames')
    p.add_argument('--secrets-dir', required=True, help='Host directory mounted read-only into the panel')
    args = p.parse_args()
    assert re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', args.machine_id), 'Invalid machine ID'
    repository = Path(__file__).resolve().parents[2]
    def docker(*argv): return subprocess.check_output(['docker', *argv])
    info = json.loads(docker('inspect', args.container))[0]
    assert info['State']['Running'], 'Desktop must already be running'
    config_mount = next(m for m in info['Mounts'] if m['Destination'] == '/config')
    host_config = Path(config_mount['Source'])
    account = Path(args.account_root)
    assert account.is_absolute() and '..' not in account.parts
    relative = account.relative_to('/config')
    assert (host_config / relative / 'db_storage').is_dir(), 'Account database directory absent'
    target = host_config / 'woc-read'
    assert not target.exists(), 'Read service already provisioned; use the documented upgrade procedure'
    assert (repository / 'services/woc-daemon/server.py').is_file()
    uid = int(docker('exec', args.container, 'id', '-u', 'abc'))
    gid = int(docker('exec', args.container, 'id', '-g', 'abc'))
    docker('exec', '-u', str(uid), args.container, 'python3', '-c',
           'import os,sys; assert os.access(sys.argv[1], os.R_OK|os.X_OK), "Account directory is not readable by desktop user"',
           str(account / 'db_storage'))
    credentials = Path(args.secrets_dir); credentials.mkdir(parents=True, exist_ok=True, mode=0o700)
    token_file = credentials / (args.machine_id + '.token')
    assert not token_file.exists(), 'Refusing to replace service identity'
    token = secrets.token_hex(32)
    token_file.write_text(token)
    for subdir in ['bin', 'private', 'private/image-kvcomm', 'wx-home', 'exports']:
        (target / subdir).mkdir(parents=True, mode=0o700)
    # WeChat may remove these transient filenames. Keep names only, not file contents;
    # wx-cli still independently validates every derived candidate against local data.
    image_sources = [host_config / '.xwechat/net/kvcomm']
    if args.image_kvcomm: image_sources.append(Path(args.image_kvcomm))
    for source in image_sources:
        for item in list(source.glob('key_*.statistic'))[:4096]:
            (target / 'private/image-kvcomm' / item.name).touch(mode=0o600)
    shutil.copyfile(args.binary, target / 'bin/wx'); (target / 'bin/wx').chmod(0o700)
    shutil.copyfile(args.vault, target / 'private/keys.json')
    (target / 'private/service.token').write_text(token)
    shutil.copyfile(repository / 'services/woc-daemon/server.py', target / 'server.py')
    for module in ['ui_service.py', 'wechat_ui.py', 'wechat_browser.py']:
        shutil.copyfile(repository / 'services/woc-daemon' / module, target / module)
    config = json.loads((repository / 'deploy/read-daemon/config.example.json').read_text())
    (target / 'config.json').write_text(json.dumps(config))
    (target / 'wx-home/config.json').write_text(json.dumps({
        'db_dir': str(account / 'db_storage'), 'keys_file': '/config/woc-read/private/keys.json',
        'decrypted_dir': '/config/woc-read/wx-home/decrypted',
    }))
    for path in [target, *target.rglob('*')]:
        os.chown(path, uid, gid)
        if path.is_file() and path.name != 'wx': path.chmod(0o600)
    # Verify the copied vault without process-memory access before starting a service.
    result = json.loads(docker('exec', '-u', str(uid), '-e', 'WX_CLI_HOME=/config/woc-read/wx-home',
                               args.container, '/config/woc-read/bin/wx', 'keys', 'status', '--json'))
    assert not result['missing'] and not result['invalid'], 'Vault does not cover the selected local databases'
    assert hashlib.sha256(Path(args.vault).read_bytes()).digest() == hashlib.sha256((target / 'private/keys.json').read_bytes()).digest()
    docker('cp', str(repository / 'deploy/read-daemon/init'), args.container + ':/custom-cont-init.d/09-woc-read')
    # The initial install uses the persistent copy; later image layers ship /opt/woc-read.
    docker('exec', args.container, 'mkdir', '-p', '/opt/woc-read')
    docker('cp', str(repository / 'services/woc-daemon/server.py'), args.container + ':/opt/woc-read/server.py')
    for module in ['ui_service.py', 'wechat_ui.py', 'wechat_browser.py']:
        docker('cp', str(repository / 'services/woc-daemon' / module), args.container + ':/opt/woc-read/' + module)
    docker('exec', args.container, 'bash', '/custom-cont-init.d/09-woc-read')
    targets_file = credentials / 'targets.json'
    targets = json.loads(targets_file.read_text()) if targets_file.exists() else {}
    targets[args.machine_id] = {'url': f'http://{args.container}:3212', 'tokenFile': '/run/secrets/woc-read/' + token_file.name}
    with tempfile.NamedTemporaryFile(mode='w', dir=credentials, delete=False) as f:
        json.dump(targets, f); f.flush(); os.fsync(f.fileno()); temporary = f.name
    os.replace(temporary, targets_file)
    after = json.loads(docker('inspect', args.container))[0]
    assert (info['Id'], info['State']['StartedAt']) == (after['Id'], after['State']['StartedAt'])
    print(json.dumps({'installed': True, 'databases_verified': result['valid'], 'container_restarted': False}))


if __name__ == '__main__': main()
