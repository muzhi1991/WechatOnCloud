import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).resolve().parents[2]/'integrations/skills/woc-wechat/scripts/wechat.py'
spec=importlib.util.spec_from_file_location('workflow',path)
workflow=importlib.util.module_from_spec(spec)
if path.exists():spec.loader.exec_module(workflow)


@unittest.skipUnless(path.exists(),'Client script is tested in the repository checkout')
class WorkflowTests(unittest.TestCase):
    def client(self,initial):
        class Fake(workflow.Client):
            def __init__(self):self.current=initial;self.calls=[];self.navigation_path=None
            def state(self):return self.current
            def settled(self):return self.current
            def query(self,op,**args):
                self.calls.append((op,args))
                if op=='navigate':self.current={'page':args['page'],'data':{'items':[]}}
                elif op=='ui_search':self.current={'page':'search_results','data':{'search':{'scope':args['scope']},'items':[{'kind':'network','label':'Alice','target_ref':'bad'},{'kind':'contact','label':'Alice','target_ref':'good'}]}}
                elif op=='open_item':
                    assert args['target_ref']=='good'
                    self.current={'page':'chat','data':{'current_chat':{'display_name':'Alice'}}}
                return {'ok':True}
        return Fake()

    def test_visible_match_does_not_search(self):
        c=self.client({'page':'conversations','data':{'items':[{'kind':'conversation','label':'Alice','target_ref':'good'}]}})
        c.open_chat({'label':'Alice','kind':'contact','source':'contacts'})
        self.assertEqual([x[0] for x in c.calls],['open_item'])

    def test_missing_item_searches_correct_scope_without_scrolling(self):
        for source,scope in [('contacts','contacts'),('sessions','conversations')]:
            c=self.client({'page':'favorites','data':{'items':[]}})
            c.open_chat({'label':'Alice','kind':'contact','source':source})
            self.assertEqual([x[0] for x in c.calls],['navigate','ui_search','open_item'])
            self.assertEqual(c.calls[1][1]['scope'],scope)
            self.assertEqual(c.navigation_path,'search_'+scope)

    def test_ambiguous_visible_rows_stop_without_input(self):
        c=self.client({'page':'conversations','data':{'items':[{'kind':'conversation','label':'Alice','target_ref':'good'}]*2}})
        with self.assertRaises(workflow.Problem):c.open_chat({'label':'Alice','kind':'contact','source':'sessions'})
        self.assertEqual(c.calls,[])
