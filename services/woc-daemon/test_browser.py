import tempfile
import unittest
from unittest.mock import patch
from ui_service import UIService, validate
from wechat_ui import UIError
from wechat_browser import validate_url, browser_controls, Browser
from test_client_workflow import workflow


class BrowserTests(unittest.TestCase):
    def test_url_validation_rejects_non_web_and_command_payloads(self):
        for url in ['file:///etc/passwd','javascript:alert(1)','https://u:p@example.org','https://example.org\nhello','https://example.org\\bad','https://example.org:bad']:
            with self.subTest(url=url),self.assertRaises(UIError):validate_url(url)
        validate('browser_open_url',{'url':'https://mp.weixin.qq.com/s?x='+('a'*4000),'window_ref':'a'*32})
        validate('navigate',{'page':'web_search'})

    def test_browser_references_are_private_typed_owner_bound_and_expire(self):
        with tempfile.TemporaryDirectory() as d:
            calls=[]
            def run(op,body):
                calls.append((op,body))
                if op=='browser_state':return dict(app='wechat',open=True,_identity={'pid':1},_controls={'secret':'internal'})
                return dict(ok=True)
            s=UIService({},d,run);state=s.execute('browser_state',{},'owner');ref=state['window_ref']
            self.assertNotIn('_identity',state);self.assertNotIn('_controls',state)
            args={'url':'https://linux.weixin.qq.com','window_ref':ref}
            with self.assertRaises(UIError):s.execute('browser_open_url',args,'other')
            with self.assertRaises(UIError):s.execute('open_item',{'target_ref':ref},'owner')
            s.execute('browser_open_url',args,'owner');self.assertEqual(calls[-1][1]['_identity'],{'pid':1})
            s.refs[ref]['expires']=0
            with self.assertRaises(UIError):s.execute('browser_open_url',args,'owner')

    def test_collapsed_entry_and_native_suggestions_are_not_extra_browsers(self):
        def node(path,role,name,rect,parent='root',text=''):
            return dict(path=path,role=role,name=name,rect=rect,parent=parent,text=text,bits=1<<25)
        frame=node('main','frame','微信',[0,0,1228,702])
        parent=node('parent','panel','',[321,4,32,33],'main')
        entry=node('entry','entry','',[321,4,0,0],'parent')
        reload=node('reload','push button','重新加载',[64,8,25,25],'main')
        nodes=[frame,parent,entry,reload]
        self.assertEqual(browser_controls(nodes)['entry'],entry)
        entry.update(rect=[574,9,280,23],text='https://example.org')
        suggestion=node('popup','frame','',[527,26,348,118])
        self.assertFalse(browser_controls(nodes+[suggestion])['dialogs'])
        unknown=node('other','frame','Login',[200,200,400,300])
        self.assertEqual(browser_controls(nodes+[unknown])['dialogs'],[unknown])
        self.assertIsNone(browser_controls(nodes+[dict(frame,path='second')])['entry'])

    def test_existing_url_draft_is_rejected_before_any_input(self):
        b=Browser.__new__(Browser);b.dispatched=False
        b.observe=lambda:dict(open=True,dialog=False,_identity={'pid':1},_controls={'entry':{'text':'unfinished'},'entry_parent':{}})
        b.cmd=lambda *_:self.fail('existing draft must not dispatch input')
        with self.assertRaises(UIError) as e:b.execute('browser_open_url',{'_identity':{'pid':1},'url':'https://example.org'})
        self.assertEqual(e.exception.result['code'],'WOC_DRAFT_MISMATCH');self.assertFalse(b.dispatched)

    def client(self,opened=False,fail=False,unchanged=False):
        class Fake(workflow.Client):
            def __init__(self):self.calls=[];self.opened=opened;self.sent=False;self.epoch=None
            def control(self,op,**args):self.calls.append(op);return {'mine':True,'lock_id':'epoch'}
            def query(self,op,**args):
                self.calls.append(op)
                if op=='navigate':self.opened=True;return {}
                if op=='browser_open_url':
                    if fail:raise workflow.Problem({'code':'WOC_ACTION_UNCERTAIN','execution':'unknown'})
                    self.sent=True;return {'verification':'url_submitted'}
                return {'open':self.opened,'window_ref':'ref','documents':[{'document_id':'new' if self.sent and not unchanged else 'old','title':'Document','url':'https://example.org','busy':False}]}
        return Fake()

    @patch.object(workflow.time,'sleep')
    def test_workflow_launches_only_when_missing_and_releases(self,_):
        for opened in (True,False):
            c=self.client(opened);r=c.open_url('https://example.org')
            self.assertEqual(r['verification'],'new_document_observed');self.assertTrue(r['requested_url_matches'])
            self.assertEqual(c.calls.count('navigate'),0 if opened else 1)
            self.assertEqual(c.calls.count('browser_open_url'),1);self.assertEqual(c.calls[-1],'release')

    @patch.object(workflow.time,'sleep')
    def test_unknown_input_is_not_replayed_and_always_releases(self,_):
        c=self.client(True,True)
        with self.assertRaises(workflow.Problem):c.open_url('https://example.org')
        self.assertEqual(c.calls.count('browser_open_url'),1);self.assertEqual(c.calls[-1],'release')

    @patch.object(workflow.time,'sleep')
    def test_existing_document_is_not_reported_as_successful_navigation(self,_):
        c=self.client(True,unchanged=True);r=c.open_url('https://example.org')
        self.assertEqual(r['verification'],'unconfirmed');self.assertEqual(c.calls.count('browser_open_url'),1)
        self.assertEqual(c.calls[-1],'release')

if __name__=='__main__':unittest.main()
