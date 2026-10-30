"""Bounded application dispatch, observation handles and send deduplication.

The gateway is the authority for control. This module never acquires/releases locks
or makes network callbacks. The file fence only drains dispatched local input.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from wechat_ui import UIError

FIELDS={
    'browser_state':set(), 'browser_open_url':{'window_ref','url'},
    'ui_state':set(), 'navigate':{'page'}, 'ui_search':{'scope','query'},
    'open_item':{'target_ref'}, 'fill_text':{'expected_chat','text','expected_draft'},
    'send_draft':{'expected_chat','expected_text','request_id'}, 'ui_request_status':{'request_id'},
}
READS={'ui_state','ui_request_status','browser_state'}


def validate(op,body):
    if op not in FIELDS or not isinstance(body,dict) or body.keys()-FIELDS[op]:
        raise UIError('WOC_INVALID_ARGUMENT','Unknown application operation or argument')
    required=FIELDS[op]-({'expected_draft'} if op=='fill_text' else set())
    if required-body.keys(): raise UIError('WOC_INVALID_ARGUMENT','Missing required argument')
    for k,v in body.items():
        if not isinstance(v,str) or '\0' in v or len(v)> (8192 if k=='url' else 2000 if k in ('text','expected_text','expected_draft') else 256):
            raise UIError('WOC_INVALID_ARGUMENT','Invalid string argument')
        if not v and k!='expected_draft': raise UIError('WOC_INVALID_ARGUMENT','Empty argument')
    if op=='navigate' and body['page'] not in ('conversations','contacts','favorites','web_search'):
        raise UIError('WOC_PAGE_UNSUPPORTED','Unsupported navigation page')
    if op=='ui_search' and body['scope'] not in ('conversations','contacts'):
        raise UIError('WOC_INVALID_ARGUMENT','Unsupported search scope')
    if op=='browser_open_url':
        from wechat_browser import validate_url
        validate_url(body['url'])
    if 'request_id' in body and not re.fullmatch(r'[a-zA-Z0-9_-]{16,128}',body['request_id']):
        raise UIError('WOC_INVALID_ARGUMENT','request_id must be a unique 16..128 character identifier')


class UIService:
    def __init__(self,config,home,runner=None):
        self.config=config
        self.home=Path(home); self.home.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.gate=threading.Lock(); self.refs={}
        self.runner=runner or self.run
        self.database=self.home/'requests.sqlite'
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS requests (owner TEXT,id TEXT,hash TEXT,result TEXT,created REAL,PRIMARY KEY(owner,id))')
        self.database.chmod(0o600)

    def db(self): return sqlite3.connect(self.database,timeout=1)

    def run(self,op,body):
        args=[sys.executable,str(Path(__file__).with_name('wechat_ui.py'))]
        if op not in READS:
            # No waiting queue: a pre-existing input process returns busy.
            args=['flock','--close','-n','/run/woc-control/http-input.lock',*args]
        p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            raw,_=p.communicate(json.dumps(dict(operation=op,body=body,config=self.config)).encode(),timeout=5)
            if p.returncode or not raw:
                return dict(ok=False,code='WOC_UI_WORKER_FAILED',error='UI worker unavailable; inspect control state',execution='not_started' if p.returncode==1 and not raw else 'unknown')
            return json.loads(raw)
        except (subprocess.TimeoutExpired,ValueError):
            try: os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            p.communicate()
            return dict(ok=False,code='WOC_UI_TIMEOUT',error='UI execution timed out; do not replay input',execution='unknown')

    def execute(self,op,body,owner):
        validate(op,body)
        if not self.gate.acquire(blocking=False): raise UIError('WOC_UI_BUSY','A local UI operation is running; retry later')
        try:
            now=time.time()
            self.refs={k:v for k,v in self.refs.items() if v['expires']>now}
            if op=='ui_request_status':
                with self.db() as db: row=db.execute('SELECT result,hash FROM requests WHERE owner=? AND id=?',(owner,body['request_id'])).fetchone()
                return dict(found=bool(row),result=json.loads(row[0]) if row else None,request_hash=row[1] if row else None)
            digest=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest()
            if op=='send_draft':
                with self.db() as db:
                    db.execute('DELETE FROM requests WHERE created<?',(now-7*86400,))
                    row=db.execute('SELECT hash,result FROM requests WHERE owner=? AND id=?',(owner,body['request_id'])).fetchone()
                    if row:
                        if row[0]!=digest: raise UIError('WOC_REQUEST_CONFLICT','request_id already used for different send arguments')
                        return dict(json.loads(row[1]),replayed=True)
                    if db.execute('SELECT count(*) FROM requests').fetchone()[0]>=1024:
                        raise UIError('WOC_REQUEST_LIMIT','Send receipt retention limit reached')
                    pending=dict(ok=False,code='WOC_ACTION_UNCERTAIN',error='Send may have started; inspect before retry',execution='unknown')
                    db.execute('INSERT INTO requests VALUES(?,?,?,?,?)',(owner,body['request_id'],digest,json.dumps(pending),now))
            payload=dict(body)
            if op=='open_item':
                ref=self.refs.get(body['target_ref'])
                if not ref or ref['owner']!=owner or ref.get('kind')=='browser': raise UIError('WOC_UI_STALE','Item reference expired or belongs to another caller; observe again')
                payload={'_target':ref['target'],'_identity':ref['identity']}
            if op=='browser_open_url':
                ref=self.refs.get(body['window_ref'])
                if not ref or ref['owner']!=owner or ref.get('kind')!='browser':raise UIError('WOC_UI_STALE','Browser reference expired or belongs to another caller; observe again')
                payload={'_identity':ref['identity'],'url':body['url']}
            result=self.runner(op,payload)
            if op=='browser_state' and result.get('open'):
                identity=result.pop('_identity');result.pop('_controls',None)
                if len(self.refs)>12800:self.refs.clear()
                ref=secrets.token_hex(16)
                self.refs[ref]=dict(owner=owner,kind='browser',identity=identity,expires=now+60)
                result.update(window_ref=ref,reference_ttl_seconds=60)
            if op=='send_draft':
                with self.db() as db:
                    if result.get('execution')=='not_started':
                        # A proven prerequisite failure may be retried after the
                        # caller fixes it. Never clear partial/unknown receipts.
                        db.execute('DELETE FROM requests WHERE owner=? AND id=?',(owner,body['request_id']))
                    else:
                        db.execute('UPDATE requests SET result=? WHERE owner=? AND id=?',(json.dumps(result),owner,body['request_id']))
            if op=='ui_state' and result.get('app')=='wechat':
                identity=result.pop('_identity'); result.pop('_controls',None)
                # Retain at most 64 observations, each at most 200 actionable rows.
                if len(self.refs)>12800: self.refs.clear()
                for item in result['data'].get('items',[])[:200]:
                    target=item.pop('_target'); ref=secrets.token_hex(16)
                    self.refs[ref]=dict(owner=owner,target=target,identity=identity,expires=now+60)
                    item['target_ref']=ref
                result['data']['items']=result['data'].get('items',[])[:200]
                result['reference_ttl_seconds']=60
            return result
        finally: self.gate.release()
