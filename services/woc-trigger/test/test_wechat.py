import importlib.util, unittest, tempfile, json, os, sys, io
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('check',Path(__file__).parent.parent/'examples/wechat-check.py');check=importlib.util.module_from_spec(spec);spec.loader.exec_module(check)
class WechatTest(unittest.TestCase):
 def test_filters(self):
  rows=[{'local_id':1,'timestamp':1,'content':'in','sender':''},{'local_id':2,'timestamp':2,'content':'out','sender':'Me'}]
  self.assertEqual(check.select_new('m','c',rows,set(),False,None),rows[:1])
  self.assertNotEqual(check.identity('m','c',rows[0]),check.identity('m','c',{**rows[0],'timestamp':2}))
  with self.assertRaises(ValueError):check.select_new('m','c',rows,set(),True,None)
  group=[{'sender_username':'one'},{'sender_username':'two'}];self.assertEqual(check.select_new('m','c',group,set(),True,'one'),group[:1])
 def test_baseline_pending_and_dedupe(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'token').write_text('test');(root/'config').write_text(json.dumps({'panelUrl':'http://fixture','tokenFile':str(root/'token')}));responses=[];rows=[{'local_id':1,'timestamp':1,'content':'a','sender':''}]
   def post(url,token,body):
    if url.endswith('/history'):return {'username':'c','messages':rows,'is_group':False}
    responses.append(body);return {'run_id':'run','status':'queued'}
   env={'WOC_CLIENT_CONFIG':str(root/'config'),'WOC_TRIGGER_STATE_DIR':d,'WOC_TRIGGER_URL':'http://fixture','WOC_TRIGGER_TOKEN_FILE':str(root/'token')}
   def run():
    with patch.object(sys,'stdin',io.StringIO('{}')),patch.object(sys,'stdout',io.StringIO()):check.main()
   with patch.dict(os.environ,env),patch.object(sys,'argv',['check','--machine','m','--chat','c','--agent','a','--instruction','summarize']),patch.object(check,'post',post):
    run();self.assertEqual(responses,[])
    rows.append({'local_id':2,'timestamp':2,'content':'b','sender':''});run();run();self.assertEqual(len(responses),1)
    state=json.loads((root/'wechat-progress.json').read_text());state['pending']={'key':'pending','task':'already computed','keys':state['seen']};(root/'wechat-progress.json').write_text(json.dumps(state));run();self.assertEqual(len(responses),2);self.assertEqual(responses[-1]['idempotency_key'],'pending')
if __name__=='__main__':unittest.main()
