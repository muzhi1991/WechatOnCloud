import copy
import tempfile
import unittest
from unittest.mock import patch
from wechat_ui import UIError
from wechat_browser import Browser, article_url, reaction_controls
from ui_service import UIService
from test_client_workflow import workflow

URL='https://mp.weixin.qq.com/s?__biz=test&mid=123&idx=1&sn=abc'


def nodes(active=False):
    return [dict(role='push button',name=name,bits=1<<25,rect=[100,100,40,24],
                 attrs={'class':cls+(' '+on if active else ''),'id':ident})
            for name,cls,on,ident in [('赞 23','sns_opr_btn sns_praise_btn','praised',''),
                                    ('在看 13','sns_opr_btn sns_love_btn','love_btn_loved','js_zaikan')]]


class ArticleTests(unittest.TestCase):
    def test_identity_ignores_session_but_not_article(self):
        self.assertEqual(article_url(URL+'&key=private&pass_ticket=private'),article_url(URL))
        self.assertNotEqual(article_url(URL),article_url(URL.replace('123','124')))
        for u in ['https://example.org/s/a','https://mp.weixin.qq.com/','https://mp.weixin.qq.com/s?__biz=t&mid=1&mid=2&idx=1&sn=x']:
            with self.assertRaises(UIError):article_url(u)

    def test_toolbar_not_comment_like_and_active_markers(self):
        ns=nodes(True)+[dict(nodes()[0],attrs={'class':'sns_praise_btn'},name='赞')]
        self.assertTrue(all(c['active'] for c in reaction_controls(ns).values()))
        self.assertFalse(any(c['active'] for c in reaction_controls(nodes()).values()))
        with self.assertRaises(UIError):reaction_controls(nodes()+[nodes()[0]])
        with self.assertRaises(UIError):reaction_controls([dict(n,bits=0) for n in nodes()])

    def browser(self,active=False):
        b=Browser.__new__(Browser);b.dispatched=False;b.window='1';b.events=[]
        b.article_observe=lambda:dict(url=article_url(URL),_identity={'doc':1},_controls=reaction_controls(nodes(active)))
        b.cmd=lambda *args:b.events.append('activate')
        b.foreground=lambda:None
        class D: Int32=int
        b.dbus=D()
        def call(s,p,i,m,*args):
            if m=='Get':return 2
            if m=='GetName':return ['press','showContextMenu'][args[0]]
            if m=='DoAction':b.events.append('press');return True
        b.call=call
        original=b.article_observe
        def observe():
            st=original()
            for c in st['_controls'].values():c['node'].update(service='app',path='node')
            return st
        b.article_observe=observe
        return b

    def test_already_active_never_toggles_and_changed_article_never_acts(self):
        b=self.browser(True);body=dict(_identity={'doc':1},expected_url=URL,reaction='like')
        self.assertEqual(b.article_execute('browser_article_react',body)['verification'],'already_active')
        self.assertEqual(b.events,[])
        for bad in [dict(body,_identity={'doc':2}),dict(body,expected_url=URL.replace('123','124'))]:
            with self.assertRaises(UIError):b.article_execute('browser_article_react',bad)
        self.assertEqual(b.events,[])

    def test_inactive_dispatches_one_semantic_press(self):
        b=self.browser();b.article_execute('browser_article_react',dict(_identity={'doc':1},expected_url=URL,reaction='wow'))
        self.assertEqual(b.events,['activate','press']);self.assertTrue(b.dispatched)

    def test_reference_ownership_and_uncertain_receipt_prevent_replay(self):
        with tempfile.TemporaryDirectory() as d:
            calls=[]
            def run(op,body):
                if op=='browser_article_state':return dict(surface='article',_identity={'doc':1},_controls={})
                calls.append(op);return dict(ok=False,execution='unknown',code='WOC_ACTION_UNCERTAIN')
            s=UIService({},d,run)
            st=s.execute('browser_article_state',{},'owner');self.assertNotIn('_identity',st)
            body=dict(article_ref=st['article_ref'],expected_url=URL,reaction='like',request_id='article-request-001')
            with self.assertRaises(UIError):s.execute('browser_article_react',body,'other')
            with self.assertRaises(UIError):s.execute('open_item',{'target_ref':body['article_ref']},'owner')
            s.execute('browser_article_react',body,'owner')
            s.refs.clear()
            result=s.execute('browser_article_react',dict(body,article_ref='0'*32),'owner')
            self.assertTrue(result['replayed']);self.assertEqual(calls,['browser_article_react'])
            with self.assertRaises(UIError):s.execute('browser_article_react',dict(body,reaction='wow'),'owner')

    @patch.object(workflow.time,'sleep')
    def test_client_releases_on_uncertain_and_stops_before_second_reaction(self,_):
        class C(workflow.Client):
            def __init__(self):self.calls=[];self.epoch=None
            def control(self,op,**kw):self.calls.append(op);return {'mine':True,'lock_id':'epoch'}
            def query(self,op,**kw):
                self.calls.append(op)
                if op=='browser_article_react':raise workflow.Problem({'execution':'unknown'})
                return dict(article_ref='a'*32,url=URL,reactions={'like':{'active':False},'wow':{'active':False}})
        c=C()
        with self.assertRaises(workflow.Problem):c.react_article(URL,'both','test-article-req-01')
        self.assertEqual(c.calls.count('browser_article_react'),1);self.assertEqual(c.calls[-1],'release')

    @patch.object(workflow.time,'sleep')
    def test_client_both_verifies_each_and_releases(self,_):
        class C(workflow.Client):
            def __init__(self):self.calls=[];self.epoch=None;self.active={'like':False,'wow':False}
            def control(self,op,**kw):self.calls.append(op);return {'mine':True,'lock_id':'epoch'}
            def query(self,op,**kw):
                self.calls.append(op)
                if op=='browser_article_react':self.active[kw['reaction']]=True;return {'ok':True}
                return dict(article_ref='a'*32,url=URL,title='Test',reactions={k:{'active':v} for k,v in self.active.items()})
        c=C();r=c.react_article(URL,'both','test-article-req-01')
        self.assertTrue(r['ok']);self.assertTrue(all(s['verified_active'] for s in r['steps']))
        self.assertEqual(c.calls.count('browser_article_react'),2);self.assertEqual(c.calls[-1],'release')


if __name__=='__main__':unittest.main()
