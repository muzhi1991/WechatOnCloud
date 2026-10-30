#!/usr/bin/env python3
"""Read-only change handler. Default first run establishes a baseline; no GUI writes."""
import argparse, hashlib, json, os, sys, urllib.request
from pathlib import Path

def post(url, token, body):
    request = urllib.request.Request(url, json.dumps(body).encode(), {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=110) as response:
        return json.load(response)

def identity(machine, chat, message):
    # local_id alone is reused by WeChat. Include time, type and content identity.
    return hashlib.sha256(json.dumps([machine, chat, message.get("local_id"), message.get("timestamp"), message.get("local_type"), message.get("sender_username"), message.get("content")], ensure_ascii=False).encode()).hexdigest()

def select_new(machine, chat, messages, seen, group, sender):
    if group and not sender:
        raise ValueError("Group checks require --sender EXACT_USERNAME to prevent self-reply loops")
    result=[]
    for message in messages:
        if identity(machine,chat,message) in seen: continue
        if group:
            if message.get("sender_username") != sender: continue
        elif message.get("sender"):
            # Current wx-cli private-chat output labels outgoing messages only.
            continue
        result.append(message)
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--machine',required=True);parser.add_argument('--chat',required=True)
    parser.add_argument('--sender',help='Required exact sender username for group monitoring')
    parser.add_argument('--limit',type=int,default=50)
    args=parser.parse_args()
    if args.chat.endswith('@chatroom') and not args.sender: raise ValueError('Group checks require --sender')
    if not 1 <= args.limit <= 100: raise ValueError('limit must be 1..100')
    event=json.load(sys.stdin)
    config=json.loads(Path(os.environ['WOC_CLIENT_CONFIG']).read_text())
    token=Path(config['tokenFile']).read_text().strip()
    response=post(config['panelUrl'].rstrip('/')+'/api/integrations/wechat/'+args.machine+'/history',token,{'chat':args.chat,'limit':args.limit})
    if response.get('username') != args.chat: raise ValueError('Resolved chat identity differs from configured username')
    messages=response['messages']
    directory=Path(os.environ['WOC_TRIGGER_STATE_DIR']);directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    path=directory/('wechat-'+os.environ.get('WOC_STEP_ID','read')+'-progress.json')
    scope=hashlib.sha256(json.dumps([args.machine,args.chat,args.sender]).encode()).hexdigest()
    state=json.loads(path.read_text()) if path.exists() else {}
    # Commit progress only after the previous complete pipeline succeeded.
    # Failed/unknown/interrupted runs retain their pending batch and stop; never resend blindly.
    pending=state.get('pending') if state.get('scope')==scope else None
    if pending:
        token=Path(os.environ['WOC_TRIGGER_TOKEN_FILE']).read_text().strip()
        request=urllib.request.Request(os.environ['WOC_TRIGGER_URL']+'/runs/'+pending['run_id'],headers={'Authorization':'Bearer '+token})
        with urllib.request.urlopen(request,timeout=10) as response_run: receipt=json.load(response_run)
        if receipt.get('status')!='succeeded':
            raise ValueError('Pending batch requires review; inspect run '+pending['run_id']+' before retrying. Progress was not advanced.')
        state={'scope':scope,'seen':list(dict.fromkeys(state.get('seen',[])+pending['keys']))[-2000:]}
    seen=state.get('seen',[]) if state.get('scope')==scope else None
    keys=[identity(args.machine,args.chat,m) for m in messages]
    if seen is None:
        state={'scope':scope,'seen':keys}
        print('Baseline established: '+str(len(keys))+' messages. No task emitted.',file=sys.stderr)
    else:
        new=select_new(args.machine,args.chat,messages,set(seen),response.get('is_group'),args.sender)
        if len(messages)>=args.limit and not set(keys).intersection(seen):
            print('Recent window has no overlap; older messages may require manual backfill.',file=sys.stderr)
        if new:
            batch=hashlib.sha256((scope+''.join(identity(args.machine,args.chat,m) for m in new)).encode()).hexdigest()
            state.update(pending={'run_id':os.environ['WOC_RUN_ID'],'keys':keys,'batch_id':batch})
            payload={'batch_id':batch,'machine_id':args.machine,'chat':args.chat,'messages':[{'timestamp':m.get('timestamp'),'local_id':m.get('local_id'),'type':m.get('type'),'sender_username':m.get('sender_username'),'content':str(m.get('content',''))[:512]} for m in new]}
        else:
            state={'scope':scope,'seen':list(dict.fromkeys(seen+keys))[-2000:]}
            print('No new incoming messages.',file=sys.stderr)
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(state));os.chmod(temp,0o600);temp.replace(path)
    if seen is not None and new: print(json.dumps(payload,ensure_ascii=False))

if __name__=='__main__':
    try: main()
    except Exception as e: print(str(e),file=sys.stderr);sys.exit(1)
