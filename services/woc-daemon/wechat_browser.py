"""Bounded WeChatAppEx operations. No lock callbacks or workflow orchestration."""
from pathlib import Path
import re
from urllib.parse import urlsplit, parse_qs, urlencode
from wechat_ui import Desktop, UIError, showing


def validate_url(url):
    try:
        parsed=urlsplit(url)
        valid=(isinstance(url,str) and 0<len(url)<=8192 and parsed.scheme in ('https','http')
               and parsed.hostname and not parsed.username and not parsed.password
               and not any(c.isspace() or ord(c)<32 or ord(c)==127 for c in url) and '\\' not in url)
        parsed.port
    except (ValueError,TypeError): valid=False
    if not valid: raise UIError('WOC_INVALID_ARGUMENT','Expected an absolute HTTP(S) URL without credentials or whitespace')


def article_url(url):
    """Stable article identity; never retain login/session query parameters."""
    validate_url(url)
    u=urlsplit(url);q=parse_qs(u.query)
    if u.hostname!='mp.weixin.qq.com' or u.port not in (None,443):
        raise UIError('WOC_ARTICLE_UNSUPPORTED','Expected a WeChat public-account article URL')
    if u.path=='/s' and all(len(q.get(k,[]))==1 for k in ('__biz','mid','idx','sn')):
        return 'https://mp.weixin.qq.com/s?'+urlencode({k:q[k][0] for k in ('__biz','mid','idx','sn')})
    if re.fullmatch(r'/s/[A-Za-z0-9_-]+',u.path):return 'https://mp.weixin.qq.com'+u.path
    raise UIError('WOC_ARTICLE_UNSUPPORTED','Article identity is missing; inspect the loaded article URL')


def reaction_controls(nodes):
    """Known article toolbar only, never comment likes or arbitrary page buttons."""
    controls={}
    for kind,base,active,label in [('like','sns_praise_btn','praised','赞'),('wow','sns_love_btn','love_btn_loved','在看')]:
        matches=[n for n in nodes if n['role']=='push button' and base in n.get('attrs',{}).get('class','').split()
                 and 'sns_opr_btn' in n.get('attrs',{}).get('class','').split() and showing(n)
                 and re.fullmatch(label+r'(?:\s+[\d.万wW+]+)?',n['name'])]
        if len(matches)!=1:raise UIError('WOC_ARTICLE_UNSUPPORTED','Expected a unique visible article toolbar; inspect with Cua')
        n=matches[0]
        if kind=='wow' and n['attrs'].get('id')!='js_zaikan':raise UIError('WOC_ARTICLE_UNSUPPORTED','Unknown heart control')
        controls[kind]=dict(node=n,active=active in n['attrs']['class'].split(),label=n['name'])
    return controls


def browser_controls(nodes):
    """Only native chrome is walked: page-controlled nodes are below document web."""
    visible=[n for n in nodes if showing(n)]
    by_path={n['path']:n for n in nodes}
    frames=[n for n in visible if n['role']=='frame' and n['name']=='微信']
    entries=[n for n in nodes if n['role']=='entry' and n['bits']&(1<<25) and not n['bits']&(1<<6) and len(frames)==1
             and frames[0]['rect'][1]<=n['rect'][1]<frames[0]['rect'][1]+48]
    reloads=[n for n in visible if n['role']=='push button' and n['name'] in ('重新加载','停止加载')]
    documents=[n for n in visible if n['role']=='document web']
    entry=entries[0] if len(entries)==1 and len(reloads)==1 else None
    dialogs=[n for n in visible if n['role'] in ('dialog','menu')]
    for n in visible:
        if n['role']!='frame' or n in frames:continue
        x,y,w,h=n['rect'];ex,ey,ew,eh=entry['rect'] if entry else [0]*4
        # Native address suggestions are a small unnamed sibling frame below
        # the focused URL entry. Unknown extra frames remain prerequisites.
        suggestion=(entry and entry.get('text') and not n['name'] and abs(x-ex)<=64
                    and ey+eh-16<=y<=ey+eh+32 and ew<=w<=ew+128 and 0<h<=256)
        if not suggestion:dialogs.append(n)
    return dict(frame=frames[0] if len(frames)==1 else None,entry=entry,
                entry_parent=by_path.get(entry['parent']) if entry else None,
                documents=documents,dialogs=dialogs)


class Browser(Desktop):
    def __init__(self,config):
        super().__init__(config,browser=True)
        self.window=None

    def observe(self):
        if not self.service:return dict(app='wechat',surface='browser',open=False,windows=[])
        a='org.a11y.atspi.Accessible'; prop='org.freedesktop.DBus.Properties';root='/org/a11y/atspi/accessible/root'
        queue=[(str(s),str(p),root) for s,p in self.call(self.service,root,a,'GetChildren')]
        nodes=[];seen=set()
        for service,path,parent in queue:
            if (service,path) in seen or path.endswith('/null'):continue
            seen.add((service,path))
            if len(seen)>500:raise UIError('WOC_UI_INCOMPLETE','Browser chrome exceeds observation budget')
            role=str(self.call(service,path,a,'GetRoleName'))
            words=self.call(service,path,a,'GetState');bits=sum(int(v)<<(32*i) for i,v in enumerate(words))
            if role!='document web':queue.extend((str(s),str(p),path) for s,p in self.call(service,path,a,'GetChildren'))
            if not bits & (1<<25) or bits & (1<<6):continue
            name=str(self.call(service,path,prop,'Get',a,'Name'))
            interfaces=self.call(service,path,a,'GetInterfaces')
            n=dict(path=path,parent=parent,role=role,name=name,bits=bits)
            if 'org.a11y.atspi.Component' in interfaces:
                n['rect']=[int(x) for x in self.call(service,path,'org.a11y.atspi.Component','GetExtents',self.dbus.UInt32(0))]
            if role=='entry':
                n['text']=str(self.call(service,path,'org.a11y.atspi.Text','GetText',self.dbus.Int32(0),self.dbus.Int32(-1)))
            if role=='document web':
                try:n['url']=str(self.call(service,path,'org.a11y.atspi.Document','GetAttributeValue','URI'))
                except self.dbus.DBusException:n['url']=None
            nodes.append(n)
        c=browser_controls(nodes)
        frames=[n for n in nodes if n['role']=='frame' and n['name']=='微信' and showing(n)]
        if not frames:return dict(app='wechat',surface='browser',open=False,windows=[])
        if len(frames)!=1 or not c['entry']:
            raise UIError('WOC_BROWSER_UNSUPPORTED','Expected one browser window with native URL entry; inspect with Cua')
        frame=c['frame']
        windows=self.cmd(['xdotool','search','--all','--onlyvisible','--pid',str(self.pid),'--name','^微信$']).decode().split()
        if len(windows)!=1:raise UIError('WOC_BROWSER_AMBIGUOUS','Cannot identify a unique browser X11 window')
        self.window=windows[0]
        identity=dict(pid=self.pid,service=self.service,start=Path(f'/proc/{self.pid}/stat').read_text().split(') ')[1].split()[19],
                      window=self.window,path=frame['path'])
        docs=[dict(title=n['name'],url=n.get('url'),busy=bool(n['bits']&(1<<3)),document_id=n['path']) for n in c['documents']]
        return dict(app='wechat',surface='browser',open=True,documents=docs,dialog=bool(c['dialogs']),
                    _identity=identity,_controls=c)

    def foreground(self):
        super().foreground()
        if self.cmd(['xdotool','getactivewindow']).decode().strip()!=self.window:
            raise UIError('WOC_APP_NOT_FOREGROUND','Expected browser window is no longer foreground')

    def execute(self,op,body):
        if op in ('browser_article_state','browser_article_react'):
            return self.article_execute(op,body)
        state=self.observe()
        if op=='browser_state':return state
        if not state['open']:raise UIError('WOC_BROWSER_NOT_OPEN','Open WeChat 搜一搜 first',precondition={'operation':'navigate','page':'web_search'})
        if state['_identity']!=body['_identity']:raise UIError('WOC_UI_STALE','Browser window was replaced; observe again')
        if state['dialog']:raise UIError('WOC_DIALOG_OPEN','Resolve the browser dialog with Cua first')
        c=state['_controls'];entry=c['entry'];parent=c['entry_parent']
        if entry.get('text'):raise UIError('WOC_DRAFT_MISMATCH','URL input already contains text; inspect before replacing it')
        # Collapsed URL field retains an off-parent bounding box. Click its native
        # parent (magnifier), then re-observe; never click the page search box.
        if not parent:raise UIError('WOC_BROWSER_UNSUPPORTED','URL entry parent unavailable')
        self.dispatched=True
        self.cmd(['xdotool','windowactivate','--sync',self.window]);self.foreground()
        x,y,w,h=parent['rect'];ex,ey,ew,eh=entry['rect']
        if ew<4 or eh<4 or not (x<=ex and ex+ew<=x+w):
            self.click(parent)
            state=self.observe();c=state['_controls'];entry=c['entry']
            if not entry or state['_identity']!=body['_identity']:raise UIError('WOC_UI_STALE','Browser changed while opening URL input')
        if entry.get('text'):raise UIError('WOC_DRAFT_MISMATCH','URL input changed; inspect before replacing it')
        self.click(entry);self.paste(body['url'])
        state=self.observe();entry=state['_controls']['entry']
        if state['dialog'] or not entry or entry.get('text')!=body['url'] or state['_identity']!=body['_identity']:
            raise UIError('WOC_DRAFT_MISMATCH','URL input did not match; no Enter submitted')
        self.foreground();self.cmd(['xdotool','key','Return'])
        return dict(ok=True,execution='completed',verification='url_submitted',next_action={'kind':'browser_state'})

    def article_observe(self):
        state=self.observe()
        if not state['open']:raise UIError('WOC_BROWSER_NOT_OPEN','Open the article with the client open-url workflow first')
        if state['dialog']:raise UIError('WOC_DIALOG_OPEN','Resolve the browser dialog first')
        docs=[d for d in state['documents'] if not d['busy']]
        if len(docs)!=1:raise UIError('WOC_ARTICLE_UNSUPPORTED','Expected one loaded article document')
        doc=docs[0];url=article_url(doc.get('url') or '')
        a='org.a11y.atspi.Accessible';p='org.freedesktop.DBus.Properties'
        queue=[(self.service,doc['document_id'])];nodes=[];seen=set()
        for service,path in queue:
            if (service,path) in seen or path.endswith('/null'):continue
            seen.add((service,path))
            if len(seen)>1600:raise UIError('WOC_UI_INCOMPLETE','Article tree exceeds observation budget')
            role=str(self.call(service,path,a,'GetRoleName'))
            # Comments can contain their own likes; stop at the known toolbar's
            # buttons after collecting their attributes, never act on page text.
            if role in ('push button','dialog','alert'):
                bits=sum(int(v)<<(32*i) for i,v in enumerate(self.call(service,path,a,'GetState')))
                attrs=dict(self.call(service,path,a,'GetAttributes'))
                name=str(self.call(service,path,p,'Get',a,'Name'))
                rect=[int(v) for v in self.call(service,path,'org.a11y.atspi.Component','GetExtents',self.dbus.UInt32(0))]
                n=dict(path=path,service=service,role=role,name=name,attrs=attrs,bits=bits,rect=rect)
                if role in ('dialog','alert') and showing(n):raise UIError('WOC_DIALOG_OPEN','Resolve the article dialog first')
                nodes.append(n)
            queue.extend((str(s),str(r)) for s,r in self.call(service,path,a,'GetChildren'))
        controls=reaction_controls(nodes)
        frame=state['_controls']['frame']['rect']
        for control in controls.values():
            x,y,w,h=control['node']['rect'];fx,fy,fw,fh=frame
            if w<4 or h<4 or not (fx<=x and fy+40<=y and x+w<=fx+fw and y+h<=fy+fh):
                raise UIError('WOC_ARTICLE_UNSUPPORTED','Article reaction is outside the browser viewport; inspect with Cua')
        return dict(app='wechat',surface='article',title=doc['title'],url=url,
                    reactions={k:dict(active=v['active'],label=v['label']) for k,v in controls.items()},
                    _identity=dict(window=state['_identity'],document_id=doc['document_id'],url=url),_controls=controls)

    def article_execute(self,op,body):
        state=self.article_observe()
        if op=='browser_article_state':return state
        if state['_identity']!=body['_identity'] or state['url']!=article_url(body['expected_url']):
            raise UIError('WOC_UI_STALE','The article changed; observe and verify the intended article again')
        kind=body['reaction'];control=state['_controls'][kind]
        if control['active']:
            return dict(ok=True,execution='completed',verification='already_active',reaction=kind,changed=False)
        self.cmd(['xdotool','windowactivate','--sync',self.window]);self.foreground()
        # AT-SPI Action invokes this exact observed control, avoiding coordinate
        # races/occlusion. A timeout is uncertain and must not be replayed.
        n=control['node'];iface='org.a11y.atspi.Action'
        count=int(self.call(n['service'],n['path'],'org.freedesktop.DBus.Properties','Get',iface,'NActions'))
        actions=[i for i in range(count) if str(self.call(n['service'],n['path'],iface,'GetName',self.dbus.Int32(i))) in ('click','press')]
        if len(actions)!=1:raise UIError('WOC_ARTICLE_UNSUPPORTED','Expected a unique accessibility click action')
        self.dispatched=True
        accepted=bool(self.call(n['service'],n['path'],iface,'DoAction',self.dbus.Int32(actions[0])))
        return dict(ok=accepted,execution='completed' if accepted else 'unknown',verification='input_dispatched',
                    reaction=kind,changed=None,next_action={'kind':'browser_article_state'})
