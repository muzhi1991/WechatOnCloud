#!/usr/bin/env python3
"""Client-owned WeChat workflows over the existing authenticated WOC HTTP API."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class Problem(Exception):
    def __init__(self,result): self.result=result


class Client:
    def __init__(self,config,machine):
        self.config=config; self.machine=machine; self.epoch=None; self.navigation_path=None
        self.base=config['panelUrl'].rstrip('/')
        u=urllib.parse.urlsplit(self.base)
        if u.scheme not in ('http','https') or u.username or u.password or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}',machine):
            raise ValueError('Invalid endpoint or machine ID')
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args): return None
        self.http=urllib.request.build_opener(NoRedirect())

    def call(self,path,body):
        headers={'Authorization':'Bearer '+Path(self.config['tokenFile']).read_text().strip(),'Content-Type':'application/json'}
        if self.epoch: headers['X-WOC-Expected-Epoch']=self.epoch
        request=urllib.request.Request(self.base+path,data=json.dumps(body).encode(),headers=headers,method='POST')
        try:
            with self.http.open(request,timeout=115) as r: result=json.load(r)
        except urllib.error.HTTPError as e:
            try: result=json.load(e)
            except ValueError: result={'code':'WOC_HTTP_ERROR','error':'Unexpected HTTP error','status':e.code}
            raise Problem(result)
        except (OSError,ValueError):
            raise Problem({'code':'WOC_TRANSPORT_UNKNOWN','error':'Request result unavailable; inspect before retry','execution':'unknown'})
        if isinstance(result,dict) and result.get('ok') is False: raise Problem(result)
        return result

    def query(self,op,**args): return self.call(f'/api/integrations/wechat/{self.machine}/{op}',args)
    def control(self,op,**args): return self.call(f'/api/integrations/woc/{op}',dict(machine_id=self.machine,**args))

    def resolve(self,username,source):
        if source=='sessions':
            rows=self.query('sessions',limit=500)['sessions']
            found=[x for x in rows if x['username']==username]
        elif source=='groups':
            rows=self.query('groups',limit=500)['groups']; found=[x for x in rows if x['username']==username]
        else:
            rows=self.query('contacts',query=username,limit=500); found=[x for x in rows if x['username']==username]
        if len(found)!=1: raise Problem({'code':'WOC_TARGET_NOT_FOUND','error':'Resolve an exact username from the selected inventory first'})
        target=found[0]; label=target.get('display') or target.get('chat') or target.get('name') or target.get('nickname')
        if not label: raise Problem({'code':'WOC_TARGET_LABEL_UNKNOWN','error':'No searchable display name is available'})
        kind='system_chat' if username=='filehelper' else 'group' if username.endswith('@chatroom') else 'contact'
        # Reject same-category name collisions rather than silently accepting a
        # database id as proof that a same-named UI row belongs to that id.
        candidates=self.query('groups',query=label,limit=500)['groups'] if kind=='group' else self.query('contacts',query=label,limit=500)
        equal=[x for x in candidates if (x.get('display') or x.get('name') or x.get('nickname'))==label]
        if len(equal)>1: raise Problem({'code':'WOC_TARGET_AMBIGUOUS','error':'Several database entries share the display name; use Agent identity verification'})
        return {'username':username,'label':label,'kind':kind,'source':source}

    def state(self): return self.query('ui_state')

    def settled(self):
        # Reads do not renew control. Bounded UI settling only; no scroll/retry input.
        time.sleep(.15)
        return self.state()

    def is_chat(self,state,target):
        return state['page']=='chat' and state['data'].get('current_chat',{}).get('display_name')==target['label']

    def open_chat(self,target):
        state=self.state()
        if self.is_chat(state,target): self.navigation_path='already_open'; return state
        if state.get('dialog'): raise Problem({'code':'WOC_DIALOG_OPEN','error':'Agent must inspect current dialog','state':state})
        def select(state,search=False):
            kinds={target['kind']} if search else {'conversation',target['kind']}
            matches=[x for x in state['data'].get('items',[]) if x['label']==target['label'] and x['kind'] in kinds]
            if len(matches)>1: raise Problem({'code':'WOC_TARGET_AMBIGUOUS','error':'Multiple matching UI items; Agent must verify identity'})
            if not matches: return None
            self.query('open_item',target_ref=matches[0]['target_ref'])
            out=self.settled()
            if out['page']=='contact_profile':
                actions=[x for x in out['data'].get('items',[]) if x['kind']=='profile_action' and x['action']=='open_chat']
                if len(actions)!=1: raise Problem({'code':'WOC_PROFILE_UNSUPPORTED','error':'Cannot identify contact chat entry','state':out})
                self.query('open_item',target_ref=actions[0]['target_ref']); out=self.settled()
            for _ in range(3):
                if self.is_chat(out,target):break
                out=self.settled()
            if not self.is_chat(out,target): raise Problem({'code':'WOC_CHAT_MISMATCH','error':'Opened page does not prove the expected chat','state':out})
            self.navigation_path='search_'+str(state['data'].get('search',{}).get('scope')) if search else 'visible_item'
            return out
        opened=select(state,state['page']=='search_results')
        if opened: return opened
        scope='contacts' if target['source']=='contacts' else 'conversations'
        self.query('navigate',page=scope); state=self.settled()
        # One observation of visible items; never enumerate pages by scrolling.
        opened=select(state)
        if opened: return opened
        self.query('ui_search',scope=scope,query=target['label'])
        for _ in range(3):
            state=self.settled()
            if state['page']=='search_results':
                opened=select(state,True)
                if opened:return opened
        raise Problem({'code':'WOC_TARGET_NOT_VISIBLE','error':'No exact local search result; use Agent/Cua, do not scroll lists','state':state})

    def workflow(self,args):
        if args.operation=='state':return self.state()
        target=self.resolve(args.chat,args.source)
        if args.operation=='send-text':
            text=Path(args.text_file).read_text()
            if not text or len(text)>2000:raise Problem({'code':'WOC_INVALID_ARGUMENT','error':'Text must contain 1..2000 characters'})
            receipt=self.query('ui_request_status',request_id=args.request_id)
            if receipt['found']:
                body=dict(expected_chat=target['label'],expected_text=text,request_id=args.request_id)
                digest=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest()
                if receipt.get('request_hash')!=digest:raise Problem({'code':'WOC_REQUEST_CONFLICT','error':'Existing request ID does not match these send arguments'})
                return {'replayed':True,'receipt':receipt['result'],'instruction':'Do not repeat send or refill draft; inspect this receipt'}
        lease=self.control('acquire')
        if not lease.get('mine'):raise Problem({'code':'WOC_LOCK_BUSY','error':'Control not acquired'})
        self.epoch=lease['lock_id']; release_error=None
        try:
            state=self.open_chat(target)
            if args.operation=='open-chat':result={'ok':True,'chat':target['username'],'identity':'unique_display_match','page':state['page'],'navigation':self.navigation_path}
            else:
                self.query('fill_text',expected_chat=target['label'],text=text)
                draft=self.state()
                if not self.is_chat(draft,target) or draft['data'].get('composer',{}).get('text')!=text:
                    raise Problem({'code':'WOC_DRAFT_MISMATCH','error':'Draft verification failed; no send requested'})
                sent=self.query('send_draft',expected_chat=target['label'],expected_text=text,request_id=args.request_id)
                after=self.settled()
                result={'ok':True,'send':sent,'ui_draft_cleared':self.is_chat(after,target) and not after['data'].get('composer',{}).get('text'),
                        'request_id':args.request_id,'chat':target['username'],'identity':'unique_display_match','navigation':self.navigation_path}
        finally:
            try:self.control('release',lock_id=self.epoch)
            except Problem as e:release_error=e.result
            self.epoch=None
        if release_error:result['release_warning']=release_error
        if args.operation=='send-text':
            history=self.query('history',chat=target['username'],limit=10)
            result['database_text_present']=any(x.get('content')==text for x in history.get('messages',[]))
            result['snapshot']=history.get('snapshot')
            result['verification_note']='Text presence is supporting evidence, not a unique delivery receipt. A missing checkpoint record does not authorize a resend.'
        return result


def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',default=os.environ.get('WOC_CLIENT_CONFIG'));p.add_argument('--machine',required=True)
    sub=p.add_subparsers(dest='operation',required=True);sub.add_parser('state')
    for op in ('open-chat','send-text'):
        s=sub.add_parser(op);s.add_argument('--chat',required=True);s.add_argument('--source',choices=['sessions','contacts','groups'],default='sessions')
        if op=='send-text':s.add_argument('--text-file',required=True);s.add_argument('--request-id',required=True)
    args=p.parse_args()
    if not args.config:p.error('--config or WOC_CLIENT_CONFIG is required')
    try:
        config=json.loads(Path(args.config).read_text());c=Client(config,args.machine)
        directory=Path.home()/'.local/share/woc-wechat-workflows';directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        key=hashlib.sha256((c.base+'/'+args.machine).encode()).hexdigest()
        with (directory/(key+'.lock')).open('a') as f:
            try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise Problem({'code':'WOC_LOCAL_WORKFLOW_BUSY','error':'Another local workflow is using this machine'})
            print(json.dumps(c.workflow(args),ensure_ascii=False))
    except Problem as e:
            print(json.dumps({**e.result,'ok':False},ensure_ascii=False));sys.exit(2)


if __name__=='__main__':main()
