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
import subprocess
import math
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

    def open_url(self,url):
        try:
            parsed=urllib.parse.urlsplit(url)
            valid=(0<len(url)<=8192 and parsed.scheme in ('http','https') and parsed.hostname
                   and not parsed.username and not parsed.password and '\\' not in url
                   and not any(c.isspace() or ord(c)<32 or ord(c)==127 for c in url))
            parsed.port
        except ValueError:valid=False
        if not valid:raise Problem({'code':'WOC_INVALID_ARGUMENT','error':'Expected an absolute HTTP(S) URL without credentials or whitespace'})
        lease=self.control('acquire')
        if not lease.get('mine'):raise Problem({'code':'WOC_LOCK_BUSY','error':'Control not acquired'})
        self.epoch=lease['lock_id'];release_error=None;failure=None;result=None
        try:
            before=self.query('browser_state');launched=False
            if not before['open']:
                self.query('navigate',page='web_search');launched=True
                for _ in range(12):
                    time.sleep(.25);before=self.query('browser_state')
                    if before['open']:break
                if not before['open']:raise Problem({'code':'WOC_BROWSER_NOT_OPEN','error':'搜一搜 did not expose a browser window; inspect with Cua'})
            submitted=self.query('browser_open_url',window_ref=before['window_ref'],url=url)
            previous={x['document_id'] for x in before.get('documents',[])}
            result={'ok':True,'submission':submitted,'browser_launched':launched,
                    'verification':'unconfirmed','requested_url':url,'article_access':'unknown'}
            # Bounded read-only settling. Never retry navigation after partial or
            # unknown input, and never interpret page text as instructions.
            for _ in range(16):
                time.sleep(.3);after=self.query('browser_state')
                result['browser']=after
                docs=[d for d in after.get('documents',[]) if d['document_id'] not in previous and not d.get('busy')]
                if docs:
                    doc=docs[0]
                    result.update(verification='new_document_observed',document=doc,
                                  requested_url_matches=urllib.parse.urldefrag(doc.get('url') or '')[0].rstrip('/')==urllib.parse.urldefrag(url)[0].rstrip('/'))
                    break
            result['verification_note']='URL submission and document navigation are observed separately. A document/title does not prove article access; inspect login, verification or error pages with Cua.'
        except Problem as e:failure=e
        finally:
            try:self.control('release',lock_id=self.epoch)
            except Problem as e:release_error=e.result
            self.epoch=None
        if failure:
            if release_error:failure.result['release_warning']=release_error
            raise failure
        if release_error:result['release_warning']=release_error
        return result

    def check_control(self):
        state=self.control('status')
        if not state.get('mine') or state.get('lock_id')!=self.epoch:
            raise Problem({'code':'WOC_LOCK_EXPIRED','error':'Control changed or expired; workflow stopped without reacquiring'})

    def cua(self,name,args):
        if not getattr(self,'cua_endpoint',None):
            rows=self.control('machines')['machines'];matches=[m for m in rows if m['id']==self.machine]
            if len(matches)!=1:raise Problem({'code':'WOC_MACHINE_NOT_FOUND','error':'No managed Cua endpoint'})
            self.cua_endpoint=matches[0]['endpoint']
        env=dict(os.environ,CUA_ENV_TOKEN=Path(self.config['tokenFile']).read_text().strip())
        if self.config.get('cuaHome'):env['CUA_HOME']=self.config['cuaHome']
        args=dict(args,session='woc-wechat-reading-'+self.machine)
        try:
            p=subprocess.run(['cua','spacesd','call',self.cua_endpoint,'DriverService/CallTool',
                              json.dumps({'name':name,'argumentsJson':json.dumps(args)})],env=env,
                             capture_output=True,text=True,timeout=15)
            if p.returncode:raise ValueError('RPC failed')
            r=json.loads(p.stdout);data=json.loads(r.get('structuredJson','{}'))
        except (OSError,ValueError,subprocess.TimeoutExpired):
            raise Problem({'code':'WOC_CUA_RESULT_UNKNOWN','error':'Cua result unavailable; inspect before retry','execution':'unknown'})
        if r.get('isError') or data.get('effect')=='refused' or data.get('code'):
            raise Problem({'code':'WOC_CUA_REFUSED','error':'Cua refused the operation','detail':data})
        return data

    def scroll_page(self,state,direction,amount):
        view=state.get('view')
        if not view:raise Problem({'code':'WOC_READING_UNSUPPORTED','error':'Page layout is not available'})
        self.check_control()
        shot=self.cua('get_window_state',dict(pid=view['pid'],window_id=view['window_id'],include_accessibility_tree=False))
        bounds=shot.get('window_bounds',{})
        frame=view['frame'];viewport=view['viewport']
        if not shot.get('screenshot_frame_valid') or any(abs(bounds.get(k,-9999)-v)>2 for k,v in zip(('x','y','width','height'),frame)):
            raise Problem({'code':'WOC_UI_STALE','error':'Cua screenshot geometry differs from the observed page'})
        self.check_control()
        target=dict(kind='window',pid=view['pid'],window_id=view['window_id'])
        self.cua('scroll',dict(target=target,x=viewport[0]-frame[0]+viewport[2]/2,
                              y=viewport[1]-frame[1]+viewport[3]/2,direction=direction,
                              by='line',amount=amount,delivery_mode='foreground'))
        time.sleep(.2)

    def page_top(self,op,identity):
        for _ in range(8):
            state=self.query(op)
            if identity(state)!=self.page_identity:raise Problem({'code':'WOC_UI_STALE','error':'Page changed while returning to top'})
            if state['view']['at_top']:return state
            before=state['view']['position'];self.scroll_page(state,'up',50)
            after=self.query(op)
            if identity(after)!=self.page_identity:raise Problem({'code':'WOC_UI_STALE','error':'Page changed after scrolling'})
            if after['view']['position']>=before and not after['view']['at_top']:
                raise Problem({'code':'WOC_SCROLL_UNCONFIRMED','error':'Content did not move toward the top'})
        raise Problem({'code':'WOC_TOP_NOT_REACHED','error':'Top navigation budget exhausted'})

    def find_article(self,author,title=None):
        # Only the local Official Accounts section is actionable; native search
        # may show network suggestions but we never select them.
        self.query('navigate',page='contacts')
        for _ in range(8):
            time.sleep(.25);state=self.state()
            if (state['page'] in ('contacts','contact_profile','search_results') and
                    (state['data'].get('search') or {}).get('scope')=='contacts' and not state.get('dialog')):break
        else:raise Problem({'code':'WOC_WRONG_PAGE','error':'Contacts page has not settled; no search submitted'})
        self.query('ui_search',scope='contacts',query=author)
        for _ in range(8):
            time.sleep(.25);state=self.state()
            matches=[i for i in state['data'].get('items',[]) if i['kind']=='official' and i['label']==author]
            if matches:break
        if len(matches)>1:raise Problem({'code':'WOC_TARGET_AMBIGUOUS','error':'Several followed accounts have this name'})
        if not matches:return dict(found=False,reason='followed_account_not_found',author=author,scrolls=0)
        self.query('open_item',target_ref=matches[0]['target_ref'])
        for _ in range(8):
            time.sleep(.25);state=self.state()
            choices=[i for i in state['data'].get('items',[]) if i['kind']=='official_profile' and i['label']==author]
            if state['page']=='official_chat' and len(choices)==1:break
        else:raise Problem({'code':'WOC_PROFILE_NOT_OPEN','error':'Followed-account conversation is not ready'})
        self.query('open_item',target_ref=choices[0]['target_ref'])
        for _ in range(10):
            time.sleep(.3)
            try:profile=self.query('browser_profile_state')
            except Problem as e:
                if e.result.get('code') not in ('WOC_PROFILE_NOT_OPEN','WOC_PROFILE_UNSUPPORTED'):raise
                continue
            if profile['author']==author:break
        else:raise Problem({'code':'WOC_PROFILE_NOT_OPEN','error':'Expected followed-account profile did not open'})
        self.page_identity=profile['username']
        profile=self.page_top('browser_profile_state',lambda s:s['username'])
        if not profile['articles_tab']:
            tabs=[i for i in profile['items'] if i['kind']=='articles_tab']
            if len(tabs)!=1:raise Problem({'code':'WOC_PROFILE_UNSUPPORTED','error':'Articles tab is unavailable'})
            self.query('browser_profile_open',target_ref=tabs[0]['target_ref']);time.sleep(.3)
        wanted=' '.join(title.split()) if title else None;seen=[]
        for page in range(4):
            profile=self.query('browser_profile_state')
            if profile['username']!=self.page_identity:raise Problem({'code':'WOC_UI_STALE','error':'Account changed during search'})
            entries=[i for i in profile['items'] if i['kind']=='article']
            seen.extend(i['title'] for i in entries if i['title'] not in seen)
            found=[i for i in entries if wanted in i['title']] if wanted else entries[:1]
            if found:
                chosen=found[0];self.query('browser_profile_open',target_ref=chosen['target_ref'])
                for _ in range(12):
                    time.sleep(.3)
                    try:article=self.query('browser_article_state')
                    except Problem as e:
                        if e.result.get('code') in ('WOC_ARTICLE_UNSUPPORTED','WOC_BROWSER_NOT_OPEN'):continue
                        raise
                    if ' '.join(article['title'].split())==chosen['title'] and article.get('author')==author:
                        return dict(found=True,author=author,title=article['title'],url=article['url'],scrolls=page,
                                    selection='title_contains' if wanted else 'latest_in_profile_order')
                raise Problem({'code':'WOC_ARTICLE_MISMATCH','error':'Opened article title/author did not match'})
            if not wanted or page==3 or profile['view']['at_bottom']:break
            before=profile['view']['position']
            self.scroll_page(profile,'down',max(1,min(6,int(profile['view']['viewport'][3]/120))))
            after=self.query('browser_profile_state')
            if after['view']['position']<=before:break
        return dict(found=False,reason='article_not_found',author=author,title=title,scrolls=page,visible_titles=seen)

    def read_article(self,url,duration):
        state=self.query('browser_article_state')
        if state['url']!=url:raise Problem({'code':'WOC_ARTICLE_MISMATCH','error':'Use the verified stable article URL before reading'})
        if not state.get('view'):raise Problem({'code':'WOC_READING_UNSUPPORTED','error':'Article body bounds are unavailable'})
        self.page_identity=url;state=self.page_top('browser_article_state',lambda s:s['url'])
        start=time.monotonic();deadline=start+duration;scrolls=0
        height=state['view']['viewport'][3];step=max(1,min(5,int(height*.8/120)))
        operation_cost=3.0
        while time.monotonic()<deadline:
            remaining_steps=max(1,math.ceil(state['view']['remaining']/(step*120)))
            pause=10 if state['view']['at_bottom'] else max(1,min(10,(deadline-time.monotonic())/(remaining_steps+1)-operation_cost))
            until=min(deadline,time.monotonic()+pause)
            while time.monotonic()<until:
                time.sleep(max(0,min(2,until-time.monotonic())));self.check_control()
            operation_start=time.monotonic()
            after=self.query('browser_article_state')
            if after['url']!=url or not after.get('view') or abs(after['view']['position']-state['view']['position'])>3:
                raise Problem({'code':'WOC_UI_STALE','error':'Article or scroll position changed during the pause; stopped'})
            state=after
            if time.monotonic()>=deadline:break
            if state['view']['at_bottom']:continue
            before=state['view']['position'];self.scroll_page(state,'down',step);scrolls+=1
            after=self.query('browser_article_state')
            if after['url']!=url or not after.get('view'):raise Problem({'code':'WOC_UI_STALE','error':'Article changed after scrolling'})
            delta=after['view']['position']-before
            if delta<=0 or delta>height*.95:
                raise Problem({'code':'WOC_SCROLL_UNCONFIRMED','error':'Reading scroll did not move by a bounded overlapping segment'})
            state=after;operation_cost=max(1,time.monotonic()-operation_start)
        return dict(duration_seconds=round(time.monotonic()-start,1),scrolls=scrolls,
                    reached_body_end=state['view']['at_bottom'],verification='viewport_browsing_only')

    def react_article(self,url,reaction,request_id,read_first=False,duration=75,author=None,title=None):
        if reaction and not re.fullmatch(r'[a-zA-Z0-9_-]{16,120}',request_id):
            raise Problem({'code':'WOC_INVALID_ARGUMENT','error':'Use a unique 16..120 character request ID'})
        if read_first and (type(duration)!=int or not 60<=duration<=90):raise Problem({'code':'WOC_INVALID_ARGUMENT','error':'Reading duration must be 60..90 seconds'})
        lease=self.control('acquire')
        if not lease.get('mine'):raise Problem({'code':'WOC_LOCK_BUSY','error':'Control not acquired'})
        self.epoch=lease['lock_id'];failure=None;release_error=None;steps=[]
        try:
            selection=self.find_article(author,title) if author else dict(found=True,url=url)
            reading=None
            if selection['found']:
                url=selection['url']
                if read_first:
                    reading=self.read_article(url,duration)
                    if reaction and not reading['reached_body_end']:
                        raise Problem({'code':'WOC_ARTICLE_NOT_FINISHED','error':'Time budget ended before the article body ended; no reaction submitted','reading':reading})
            for kind in ((['like','wow'] if reaction=='both' else [reaction]) if reaction and selection['found'] else []):
                before=self.query('browser_article_state')
                action=self.query('browser_article_react',article_ref=before['article_ref'],expected_url=url,
                                  reaction=kind,request_id=request_id+'-'+kind)
                step={'reaction':kind,'action':action,'verified_active':False};steps.append(step)
                # Read-only verification; never repeat the toggle on a timeout.
                for _ in range(4):
                    time.sleep(.2);after=self.query('browser_article_state')
                    if after['url']!=before['url']:
                        raise Problem({'code':'WOC_UI_STALE','error':'Article changed during verification','execution':'partial'})
                    if after['reactions'][kind]['active']:
                        step['verified_active']=True;break
                if not step['verified_active']:
                    raise Problem({'code':'WOC_REACTION_UNCONFIRMED','error':'Reaction input was submitted but active state is unconfirmed; inspect, do not repeat','execution':'unknown'})
            result=dict(ok=True,selection=selection,reading=reading,steps=steps,
                        verification='ui_active_observed' if steps else 'not_found' if not selection['found'] else 'browsed' if reading else 'article_opened')
            if steps:result['article']={'title':after['title'],'url':after['url']}
        except Problem as e:
            failure=e;failure.result['steps']=steps
        finally:
            try:self.control('release',lock_id=self.epoch)
            except Problem as e:release_error=e.result
            self.epoch=None
        if failure:
            if release_error:failure.result['release_warning']=release_error
            raise failure
        if release_error:result['release_warning']=release_error
        return result

    def workflow(self,args):
        if args.operation=='state':return self.state()
        if args.operation=='article-state':return self.query('browser_article_state')
        if args.operation in ('react-article','read-article','open-article'):
            return self.react_article(getattr(args,'url',None),getattr(args,'reaction',None),getattr(args,'request_id',None),
                                      read_first=args.operation=='read-article' or getattr(args,'read_first',False),
                                      duration=getattr(args,'duration',75),author=getattr(args,'author',None),title=getattr(args,'title',None))
        if args.operation=='open-url':return self.open_url(args.url)
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
    sub.add_parser('article-state',help='Read the current article and toolbar reaction states without a lock')
    r=sub.add_parser('react-article',help='Enable authorized article reactions; never cancel or blindly retry')
    target=r.add_mutually_exclusive_group(required=True)
    target.add_argument('--url',help='Verified stable URL of the currently open article')
    target.add_argument('--author',help='Exact name of a followed public account; defaults to its latest article')
    r.add_argument('--title',help='Article title keyword (substring); search the first screen and at most three downward screens')
    r.add_argument('--read-first',action='store_true');r.add_argument('--duration',type=int,default=75)
    r.add_argument('--reaction',required=True,choices=['like','wow','both'],help='like=赞; wow=爱心/在看 (visible to friends); both=both')
    r.add_argument('--request-id',required=True,help='Unique 16..120 character action ID; reuse after an interrupted attempt')
    read=sub.add_parser('read-article',help='Browse the article from top to body end for 60..90 seconds without reacting')
    target=read.add_mutually_exclusive_group(required=True);target.add_argument('--url');target.add_argument('--author')
    read.add_argument('--title');read.add_argument('--duration',type=int,default=75)
    find=sub.add_parser('open-article',help='Find a followed account and open its latest or keyword-matched article')
    find.add_argument('--author',required=True);find.add_argument('--title')
    u=sub.add_parser('open-url');u.add_argument('--url',required=True)
    for op in ('open-chat','send-text'):
        s=sub.add_parser(op);s.add_argument('--chat',required=True);s.add_argument('--source',choices=['sessions','contacts','groups'],default='sessions')
        if op=='send-text':s.add_argument('--text-file',required=True);s.add_argument('--request-id',required=True)
    args=p.parse_args()
    if getattr(args,'title',None) and not getattr(args,'author',None):p.error('--title requires --author')
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
