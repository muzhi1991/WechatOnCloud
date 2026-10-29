import copy
import unittest
from report import summarize


class ReportTest(unittest.TestCase):
    def test_desktop_profile_needs_its_shell_not_wechat(self):
        row = {'at': '2026-10-29T02:00:00+00:00', 'errors': {},
               'requiredProcesses': ['openbox', 'tint2', 'xsettingsd', 'cua-spacesd', 'Xvnc'],
               'checks': {'registration': {'state': 'ready'}, 'cuaHealth': {'rpcOk': True},
                          'control': {'state': 'idle'},
                          'desktopProcesses': dict.fromkeys(['openbox', 'tint2', 'xsettingsd', 'cua-spacesd', 'Xvnc'], True)}}
        self.assertEqual(summarize([row])['unhealthySamples'], [])
        row['checks']['desktopProcesses']['tint2'] = False
        self.assertIn('desktop-process-missing', summarize([row])['unhealthySamples'][0]['reasons'])

    def test_detects_gap_restart_and_failed_probe_without_calling_them_healthy(self):
        first = {'at': '2026-10-28T09:00:00+00:00', 'errors': {}, 'checks': {
            'registration': {'state': 'ready'}, 'cuaHealth': {'rpcOk': True},
            'desktopProcesses': dict.fromkeys(('wechat', 'cua-spacesd', 'Xvnc'), True),
            'control': {'state': 'idle'}, 'containers': [{'name': 'test', 'id': 'one',
            'startedAt': 'old', 'restartCount': 0, 'status': 'running', 'oomKilled': False}]}}
        second = copy.deepcopy(first)
        second['at'] = '2026-10-28T09:20:00+00:00'
        second['errors'] = {'cuaHealth': 'HTTPError'}
        del second['checks']['cuaHealth']
        second['checks']['containers'][0]['startedAt'] = 'new'
        second['checks']['containers'][0]['restartCount'] = 1
        result = summarize([first, second])
        self.assertEqual(result['containerIdentityCounts']['test'], 2)
        self.assertEqual(result['samplingGaps'][0]['seconds'], 1200)
        self.assertEqual(len(result['unhealthySamples']), 1)
        self.assertIn('health-rpc-unavailable', result['unhealthySamples'][0]['reasons'])


if __name__ == '__main__':
    unittest.main()
