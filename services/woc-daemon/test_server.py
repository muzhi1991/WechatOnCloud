import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from server import Service, Failure, arguments, make_server


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'db').mkdir()
        (self.root / 'db' / 'a.db').write_bytes(b'fake-encrypted-test-data')
        (self.root / 'keys.json').write_text('{}')
        (self.root / 'token').write_text('t' * 48)
        (self.root / 'config.json').write_text(json.dumps({'db_dir': str(self.root / 'db'), 'keys_file': 'keys.json'}))
        self.calls = []
        self.s = Service('/bin/echo', self.root, self.root / 'token', self.root / 'exports', ttl=1)
        def run(args):
            self.calls.append(args)
            if 'extract' in args:
                output = Path(next(x.split('=', 1)[1] for x in args if x.startswith('--output=')))
                output.write_bytes(b'local-file')
                return {'exported': True, 'output': str(output)}
            return {'sessions': [{'unread': 2}, {'unread': 0}]}
        self.s.run_cli = run

    def tearDown(self):
        self.tmp.cleanup()

    def test_queries_are_fixed_and_unread_is_conversation_only(self):
        out = self.s.execute('sessions', {'limit': 5}, 'a' * 64)
        self.assertEqual([x['has_unread'] for x in out['sessions']], [True, False])
        self.assertEqual(self.calls, [['--with-meta', 'sessions', '--json', '--limit=5']])
        for op, body in [('init', {}), ('keys', {}), ('history', {'chat': '--help'}),
                         ('sessions', {'limit': True}), ('extract', {'attachment_id': 'abc', 'output': '/tmp/x'}),
                         ('history', {'chat': 'x', 'offset': -1}), ('unread', {'filter': ['bad']})]:
            with self.assertRaises(Failure): arguments(op, body)
        self.assertIn('--query=$(never-run)', arguments('contacts', {'query': '$(never-run)'}))
        self.assertIn('--in=--help', arguments('search', {'keyword': 'x', 'chats': ['--help']}))

    def test_exports_are_owner_bound_expire_and_do_not_return_paths(self):
        result = self.s.execute('extract', {'attachment_id': 'example'}, 'a' * 64)
        self.assertNotIn('output', result)
        with self.s.download(result['file_id'], 'a' * 64) as f: self.assertEqual(f.read(), b'local-file')
        with self.assertRaises(Failure): self.s.download(result['file_id'], 'b' * 64)
        with self.assertRaises(Failure): self.s.download('../../keys.json', 'a' * 64)
        self.assertEqual((self.root / 'exports' / result['file_id']).stat().st_mode & 0o777, 0o600)
        self.s.files[result['file_id']]['expires'] = 0
        with self.assertRaises(Failure): self.s.download(result['file_id'], 'a' * 64)
        self.assertEqual(list((self.root / 'exports').iterdir()), [])

    def test_missing_export_and_size_failure_clean_up(self):
        original = self.s.run_cli
        self.s.run_cli = lambda args: {'exported': False, 'local_status': 'not_downloaded'}
        self.assertFalse(self.s.execute('extract', {'attachment_id': 'example'}, 'a' * 64)['exported'])
        self.s.run_cli = original
        self.s.max_export = 1
        with self.assertRaises(Failure): self.s.execute('extract', {'attachment_id': 'example'}, 'a' * 64)
        self.assertEqual(list((self.root / 'exports').iterdir()), [])

    def test_busy_returns_immediately_and_revision_is_stat_only(self):
        self.s.gate.acquire()
        try:
            with self.assertRaises(Failure) as e: self.s.execute('sessions', {}, 'a' * 64)
            self.assertEqual(e.exception.status, 429)
            before = self.s.execute('revision', {}, 'a' * 64)
            self.assertEqual(before, self.s.execute('revision', {}, 'a' * 64))
            (self.root / 'db' / 'a.db').write_bytes(b'changed')
            self.assertNotEqual(before, self.s.execute('revision', {}, 'a' * 64))
            self.assertEqual(self.calls, [])
        finally: self.s.gate.release()

    def test_http_authentication_and_download(self):
        server = make_server(self.s)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        url = f'http://127.0.0.1:{server.server_port}'
        def request(route, body=None, token='t' * 48, principal='a' * 64):
            return urllib.request.urlopen(urllib.request.Request(url + route,
                data=json.dumps(body).encode() if body is not None else None,
                headers={'Authorization': 'Bearer ' + token, 'X-WOC-Principal': principal}), timeout=3)
        try:
            for token, principal in [('bad', 'a' * 64), ('t' * 48, '')]:
                with self.assertRaises(urllib.error.HTTPError) as e: request('/v1/health', {}, token, principal)
                self.assertEqual(e.exception.code, 401)
                e.exception.close()
            with request('/v1/extract', {'attachment_id': 'example'}) as r: data = json.load(r)
            with request('/v1/files/' + data['file_id']) as r: self.assertEqual(r.read(), b'local-file')
            with self.assertRaises(urllib.error.HTTPError) as e: request('/v1/files/' + data['file_id'], principal='b' * 64)
            self.assertEqual(e.exception.code, 404)
            e.exception.close()
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
