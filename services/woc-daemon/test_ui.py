import copy
import tempfile
import unittest
from pathlib import Path
from ui_service import UIService, validate
from wechat_ui import classify, UIError, Desktop


def node(path,role,name,parent='root',y=0,text=''):
    return dict(path=path,parent=parent,role=role,name=name,bits=(1<<25)|(1<<8),rect=[0,y,200,30],text=text)


class UITests(unittest.TestCase):
    def test_search_categories_exclude_network_and_history(self):
        nodes=[node('q','text','搜索',text='Alice'),node('list','list','',y=0)]
        nodes[1]['rect']=[0,0,200,500]
        for i,(label,kind) in enumerate([('联系人',''),('Alice',''),('搜索网络结果',''),('Alice',''),('群聊',''),('Team',''),('聊天记录',''),('Alice','')]):
            nodes.append(node(str(i),'list item',label,'list',i*40))
        state=classify(nodes)
        self.assertEqual(state['page'],'search_results')
        self.assertEqual([(x['kind'],x['label']) for x in state['data']['items']],[('contact','Alice'),('group','Team')])

    def test_navigation_buttons_alone_do_not_identify_page(self):
        state=classify([node('nav','tool bar','导航'),node('f','push button','收藏','nav')])
        self.assertEqual(state['page'],'unknown')

    def test_filehelper_is_only_actionable_in_local_function_section(self):
        listing=node('l','list',''); listing['rect']=[0,0,200,500]
        labels=['功能','文件传输助手','其他功能','聊天记录','文件传输助手','搜索网络结果','文件传输助手']
        state=classify([listing,*[node(str(i),'list item',label,'l',i*40) for i,label in enumerate(labels)]])
        self.assertEqual([(x['kind'],x['label']) for x in state['data']['items']],[('system_chat','文件传输助手')])

    def test_group_title_uses_editor_to_distinguish_member_count(self):
        messages=node('m','list','消息');messages['rect']=[300,80,800,400]
        editor=node('e','text','Team');editor['rect']=[320,500,700,80]
        send=node('s','push button','发送');send['rect']=[900,590,50,30]
        labels=[]
        for i,name in enumerate(['Team(7)','Team','(7)']):
            n=node('l'+str(i),'label',name);n['rect']=[320+i*20,40,100,20];labels.append(n)
        state=classify([messages,editor,send,*labels])
        self.assertEqual(state['page'],'chat');self.assertEqual(state['data']['current_chat']['display_name'],'Team')

    def test_official_page_is_not_a_chat_and_unknown_overlay_blocks_actions(self):
        conv=node('c','list','会话');conv['rect']=[60,80,240,600]
        title=node('t','label','公众号');title['rect']=[320,40,100,20]
        state=classify([conv,title]);self.assertEqual(state['page'],'official_accounts')
        overlay=node('o','filler','','/org/a11y/atspi/accessible/root')
        self.assertEqual(classify([conv,title,overlay])['dialog'],['unrecognized_overlay'])

    def test_draft_and_chat_mismatch_dispatch_no_input(self):
        d=Desktop.__new__(Desktop)
        d.observe=lambda:dict(page='chat',dialog=None,data={'current_chat':{'display_name':'Alice'},'composer':{'text':'existing'}},_controls={})
        d.click=lambda *_:self.fail('must not click')
        for args in [dict(expected_chat='Bob',text='new'),dict(expected_chat='Alice',text='new')]:
            with self.assertRaises(UIError):d.execute('fill_text',args)

    def test_schema_rejects_arbitrary_inputs(self):
        for op,args in [('run_script',{}),('fill_text',{'expected_chat':'a','text':'b','shell':'oops'}),('navigate',{'page':'unknown'}),('send_draft',{'expected_chat':'a','expected_text':'b','request_id':'short'})]:
            with self.assertRaises(UIError):validate(op,args)
        validate('fill_text',{'expected_chat':'a','text':'中文\nnext'})

    def test_observation_handles_are_owner_bound_and_revalidated(self):
        with tempfile.TemporaryDirectory() as directory:
            target=dict(path='p',name='Alice',role='list item',kind='contact',point=[1,2])
            raw=dict(app='wechat',page='contacts',data={'items':[dict(kind='contact',label='Alice',_target=target)]},_identity={'pid':123,'service':':1.2'},_controls={})
            calls=[]
            def run(op,body):calls.append((op,body));return copy.deepcopy(raw) if op=='ui_state' else {'ok':True,'execution':'completed'}
            s=UIService({},directory,run);state=s.execute('ui_state',{},'owner');ref=state['data']['items'][0]['target_ref']
            self.assertNotIn('_target',state['data']['items'][0]); self.assertNotIn('_controls',state)
            with self.assertRaises(UIError):s.execute('open_item',{'target_ref':ref},'other')
            s.execute('open_item',{'target_ref':ref},'owner')
            self.assertEqual(calls[-1][1]['_identity']['pid'],123)
            s.refs[ref]['expires']=0
            with self.assertRaises(UIError):s.execute('open_item',{'target_ref':ref},'owner')

    def test_send_deduplicates_across_restart_and_rejects_changed_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]
            def run(op,body):calls.append(op);return {'ok':True,'execution':'completed'}
            args=dict(expected_chat='Alice',expected_text='hello',request_id='unique-send-000001')
            s=UIService({},directory,run);s.execute('send_draft',args,'owner')
            s=UIService({},directory,run)
            self.assertTrue(s.execute('send_draft',args,'owner')['replayed']);self.assertEqual(calls,['send_draft'])
            with self.assertRaises(UIError):s.execute('send_draft',dict(args,expected_text='changed'),'owner')
            self.assertFalse(s.execute('ui_request_status',{'request_id':args['request_id']},'other')['found'])

    def test_worker_crash_keeps_unknown_send_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            def crash(*_):raise RuntimeError('process died')
            args=dict(expected_chat='Alice',expected_text='hello',request_id='uncertain-send-01')
            s=UIService({},directory,crash)
            with self.assertRaises(RuntimeError):s.execute('send_draft',args,'owner')
            s.runner=lambda *_:self.fail('unknown send must not be replayed')
            self.assertEqual(s.execute('send_draft',args,'owner')['execution'],'unknown')

    def test_proven_precondition_failure_can_be_retried_after_fix(self):
        with tempfile.TemporaryDirectory() as directory:
            args=dict(expected_chat='Alice',expected_text='hello',request_id='precondition-0001')
            s=UIService({},directory,lambda *_:{'ok':False,'code':'WOC_DRAFT_MISMATCH','execution':'not_started'})
            s.execute('send_draft',args,'owner')
            self.assertFalse(s.execute('ui_request_status',{'request_id':args['request_id']},'owner')['found'])
            s.runner=lambda *_:{'ok':True,'execution':'completed'}
            self.assertTrue(s.execute('send_draft',args,'owner')['ok'])


if __name__=='__main__':unittest.main()
