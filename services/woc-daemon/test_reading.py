"""Behavioral boundaries for followed-account selection and paced browsing."""
import copy
import tempfile
import unittest
from unittest.mock import patch
from test_client_workflow import workflow
from test_ui import node
from wechat_ui import classify, UIError
from wechat_browser import Browser, article_layout
from ui_service import UIService


class Clock:
    now=0
    def monotonic(self):return self.now
    def sleep(self,seconds):self.now+=seconds


class Reader(workflow.Client):
    def __init__(self,length=1100):
        self.position=0;self.length=length;self.events=[];self.epoch='epoch';self.clock=Clock();self.takeover=False
    def query(self,op,**args):
        self.events.append(op)
        return dict(url='https://mp.weixin.qq.com/s/test',view=dict(position=self.position,at_top=self.position==0,
                    at_bottom=self.position>=self.length,remaining=max(0,self.length-self.position),viewport=[0,40,800,600]))
    def control(self,op,**args):
        self.events.append(op)
        return dict(mine=not self.takeover,lock_id='epoch')
    def scroll_page(self,state,direction,amount):
        self.check_control();self.events.append('scroll')
        self.position=max(0,min(self.length,self.position+(1 if direction=='down' else -1)*amount*120))


class Finder(workflow.Client):
    def __init__(self,local=True):self.page=0;self.local=local;self.events=[];self.native='search_results'
    def state(self):
        items=[dict(kind='network',label='作者',target_ref='never')]
        if self.local:items.append(dict(kind='official',label='作者',target_ref='account'))
        if self.native=='official_chat':items=[dict(kind='official_profile',label='作者',target_ref='profile')]
        return dict(page=self.native,data={'items':items,'search':{'scope':'contacts'}})
    def query(self,op,**args):
        self.events.append((op,args))
        if op=='open_item':
            assert args['target_ref']!='never'
            self.native='official_chat'
        if op=='browser_profile_state':
            return dict(username='gh_test',author='作者',articles_tab=True,
                        items=[dict(kind='article',title='第'+str(self.page)+'篇',target_ref='article')],
                        view=dict(at_top=self.page==0,at_bottom=False,position=self.page*600,viewport=[0,40,800,600]))
        if op=='browser_article_state':return dict(url='https://mp.weixin.qq.com/s/test',title='第'+str(self.page)+'篇',author='作者')
        return dict(ok=True)
    def scroll_page(self,*args):self.page+=1


class ReadingTests(unittest.TestCase):
    def test_body_geometry_stops_before_comments(self):
        ns=[dict(attrs={'id':'js_content'},rect=[10,-600,700,1000]),
            dict(attrs={'id':'js_article'},rect=[0,-700,800,5000]),
            dict(attrs={'id':'js_name'},name='作者',rect=[0,-650,100,20])]
        v,author=article_layout(ns,[0,40,800,600],[0,0,800,700],1,2)
        self.assertTrue(v['at_bottom']);self.assertFalse(v['at_top']);self.assertEqual(author,'作者')

    def test_read_pauses_to_duration_and_stops_scrolling_at_body_end(self):
        c=Reader()
        with patch.object(workflow.time,'sleep',c.clock.sleep),patch.object(workflow.time,'monotonic',c.clock.monotonic):
            r=c.read_article('https://mp.weixin.qq.com/s/test',75)
        self.assertEqual(r['duration_seconds'],75);self.assertTrue(r['reached_body_end'])
        self.assertEqual(r['scrolls'],3)
        self.assertNotIn('browser_article_react',c.events)

    def test_takeover_stops_and_never_reacquires(self):
        c=Reader();c.takeover=True
        with patch.object(workflow.time,'sleep',c.clock.sleep),patch.object(workflow.time,'monotonic',c.clock.monotonic):
            with self.assertRaises(workflow.Problem) as error:c.read_article('https://mp.weixin.qq.com/s/test',60)
        self.assertEqual(error.exception.result['code'],'WOC_LOCK_EXPIRED')
        self.assertNotIn('scroll',c.events);self.assertNotIn('acquire',c.events)

    def test_unfinished_read_does_not_react_and_releases(self):
        c=Reader(length=100000)
        with patch.object(workflow.time,'sleep',c.clock.sleep),patch.object(workflow.time,'monotonic',c.clock.monotonic):
            with self.assertRaises(workflow.Problem) as error:c.react_article('https://mp.weixin.qq.com/s/test','both','reading-test-0001',True,60)
        self.assertEqual(error.exception.result['code'],'WOC_ARTICLE_NOT_FINISHED')
        self.assertNotIn('browser_article_react',c.events)
        self.assertEqual(c.events.count('acquire'),1);self.assertEqual(c.events[-1],'release')

    @patch.object(workflow.time,'sleep')
    def test_latest_and_exact_title_search_limits(self,_):
        c=Finder();self.assertEqual(c.find_article('作者')['title'],'第0篇');self.assertEqual(c.page,0)
        c=Finder();self.assertEqual(c.find_article('作者','2')['scrolls'],2)
        c=Finder();r=c.find_article('作者','缺失文章');self.assertFalse(r['found']);self.assertEqual(c.page,3)
        self.assertFalse(any(op=='browser_profile_open' for op,args in c.events))

    @patch.object(workflow.time,'sleep')
    def test_multiple_keyword_matches_choose_topmost(self,_):
        c=Finder();original=c.query
        def query(op,**args):
            result=original(op,**args)
            if op=='browser_profile_state':result['items'].append(dict(kind='article',title='另一篇',target_ref='other'))
            return result
        c.query=query
        result=c.find_article('作者','篇')
        self.assertEqual(result['title'],'第0篇')
        self.assertEqual([args['target_ref'] for op,args in c.events if op=='browser_profile_open'],['article'])

    @patch.object(workflow.time,'sleep')
    def test_not_followed_does_not_click_network_result(self,_):
        c=Finder(local=False);r=c.find_article('作者')
        self.assertEqual(r['reason'],'followed_account_not_found')
        self.assertFalse(any(op=='open_item' for op,args in c.events))

    def test_local_search_classification_and_account_frame(self):
        listing=node('list','list','');listing['rect']=[0,0,200,500]
        ns=[listing]+[node(str(i),'list item',label,'list',i*40) for i,label in enumerate(['搜索网络结果','作者','公众号','作者'])]
        items=classify(ns)['data']['items']
        self.assertEqual([(i['kind'],i['label']) for i in items],[('official','作者')])
        frame=node('frame','frame','作者','/org/a11y/atspi/accessible/root');frame['bits']|=2
        state=classify([frame,node('profile','push button','公众号主页','frame')])
        self.assertEqual(state['page'],'official_chat');self.assertIsNone(state['dialog'])

    def test_unfollowed_native_profile_is_rejected_before_reading_cards(self):
        b=Browser.__new__(Browser)
        b.observe=lambda:dict(open=True,dialog=False,documents=[dict(busy=False,title='作者',
          url='weixin://resourceid/SubscriptionProfile/profile.html?subscribed=0&showName=作者&userName=gh_test')])
        b.document_nodes=lambda *_:self.fail('must not expose unfollowed account cards')
        with self.assertRaises(UIError) as error:b.profile_observe()
        self.assertEqual(error.exception.result['code'],'WOC_NOT_FOLLOWED')

    def test_changed_profile_target_never_clicks(self):
        b=Browser.__new__(Browser)
        b.profile_observe=lambda:dict(_identity={'doc':2},_items=[])
        b.click=lambda *_:self.fail('stale profile must not dispatch')
        with self.assertRaises(UIError):b.execute('browser_profile_open',dict(_identity={'doc':1},_target={}))

    def test_profile_reference_cannot_be_used_by_other_owner_or_native_api(self):
        target=dict(path='card',kind='article',label='title',rect=[0,100,100,20])
        raw=dict(surface='profile',_identity={'doc':1},_items=[],items=[dict(title='title',kind='article',_target=target)])
        with tempfile.TemporaryDirectory() as d:
            s=UIService({},d,lambda op,body:copy.deepcopy(raw) if op=='browser_profile_state' else {'ok':True})
            result=s.execute('browser_profile_state',{},'one');ref=result['items'][0]['target_ref']
            self.assertNotIn('_target',result['items'][0])
            with self.assertRaises(UIError):s.execute('browser_profile_open',{'target_ref':ref},'two')
            with self.assertRaises(UIError):s.execute('open_item',{'target_ref':ref},'one')
            self.assertTrue(s.execute('browser_profile_open',{'target_ref':ref},'one')['ok'])
            s.refs[ref]['expires']=0
            with self.assertRaises(UIError):s.execute('browser_profile_open',{'target_ref':ref},'one')

if __name__=='__main__':unittest.main()
