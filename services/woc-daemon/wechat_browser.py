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


def classes(n):return set(n.get('attrs',{}).get('class','').split())


def intersect(a,b):
    x,y=max(a[0],b[0]),max(a[1],b[1]);r,t=min(a[0]+a[2],b[0]+b[2]),min(a[1]+a[3],b[1]+b[3])
    return [x,y,max(0,r-x),max(0,t-y)]


def article_layout(nodes,viewport,frame,pid,window):
    bodies=[n for n in nodes if n.get('attrs',{}).get('id')=='js_content']
    roots=[n for n in nodes if n.get('attrs',{}).get('id')=='js_article']
    authors=[n for n in nodes if n.get('attrs',{}).get('id')=='js_name']
    if len(bodies)!=1 or len(roots)!=1:return None,None
    body=bodies[0]['rect'];root=roots[0]['rect'];v=list(viewport)
    bars=[n['rect'][1] for n in nodes if 'sns_opr_btn' in classes(n) and showing(n)]
    if bars:v[3]=min(v[3],min(bars)-8-v[1])
    if v[2]<20 or v[3]<40:return None,None
    view=dict(pid=pid,window_id=int(window),frame=frame,viewport=v,body=body,
              at_top=root[1]>=v[1]-3,at_bottom=body[1]+body[3]<=v[1]+v[3]+3,
              position=max(0,v[1]-root[1]),remaining=max(0,body[1]+body[3]-v[1]-v[3]))
    return view,authors[0]['name'] if len(authors)==1 else None


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
        if op=='browser_profile_state':return self.profile_observe()
        if op=='browser_profile_open':
            state=self.profile_observe()
            if state['_identity']!=body['_identity']:raise UIError('WOC_UI_STALE','The account page changed')
            matches=[n for n in state['_items'] if n['_target']==body['_target']]
            if len(matches)!=1:raise UIError('WOC_UI_STALE','The observed article or tab changed; observe again')
            node=matches[0]['_target'];self.dispatched=True
            self.cmd(['xdotool','windowactivate','--sync',self.window]);self.foreground()
            self.click(dict(rect=node['rect']))
            return dict(ok=True,execution='completed',verification='input_dispatched')
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

    def document_nodes(self,state):
        docs=[d for d in state['documents'] if not d['busy']]
        if len(docs)!=1:raise UIError('WOC_ARTICLE_UNSUPPORTED','Expected one loaded document')
        doc=docs[0]
        a='org.a11y.atspi.Accessible';p='org.freedesktop.DBus.Properties'
        queue=[(self.service,doc['document_id'],'root')];nodes=[];seen=set()
        for service,path,parent in queue:
            if (service,path) in seen or path.endswith('/null'):continue
            seen.add((service,path))
            if len(seen)>1600:raise UIError('WOC_UI_INCOMPLETE','Page tree exceeds observation budget')
            role=str(self.call(service,path,a,'GetRoleName'))
            bits=sum(int(v)<<(32*i) for i,v in enumerate(self.call(service,path,a,'GetState')))
            attrs=dict(self.call(service,path,a,'GetAttributes')) if role!='static' else {}
            name=str(self.call(service,path,p,'Get',a,'Name'))
            rect=[int(v) for v in self.call(service,path,'org.a11y.atspi.Component','GetExtents',self.dbus.UInt32(0))]
            n=dict(path=path,parent=parent,service=service,role=role,name=name,attrs=attrs,bits=bits,rect=rect)
            if role in ('dialog','alert') and showing(n):raise UIError('WOC_DIALOG_OPEN','Resolve the page dialog first')
            nodes.append(n)
            queue.extend((str(s),str(r),path) for s,r in self.call(service,path,a,'GetChildren'))
        return doc,nodes

    def profile_observe(self):
        state=self.observe()
        if not state['open'] or state['dialog']:raise UIError('WOC_PROFILE_NOT_OPEN','Open the followed account profile first')
        docs=state['documents']
        if len(docs)!=1:raise UIError('WOC_PROFILE_UNSUPPORTED','Expected one account profile')
        if docs[0]['busy']:raise UIError('WOC_PROFILE_NOT_OPEN','Account profile is still loading')
        u=urlsplit(docs[0].get('url') or '');q=parse_qs(u.query)
        if (u.scheme,u.netloc,u.path)!=('weixin','resourceid','/SubscriptionProfile/profile.html'):
            raise UIError('WOC_PROFILE_NOT_OPEN','Open the followed account profile first')
        if q.get('subscribed')!=['1']:raise UIError('WOC_NOT_FOLLOWED','Only followed public accounts are supported')
        name=q.get('showName',[''])[0];username=q.get('userName',[''])[0]
        if not name or not username or docs[0]['title']!=name:raise UIError('WOC_PROFILE_UNSUPPORTED','Account identity is ambiguous')
        doc,nodes=self.document_nodes(state)
        viewport=next(n['rect'] for n in nodes if n['path']==doc['document_id'])
        header=next((n for n in nodes if 'profile_details__header' in classes(n)),None)
        tabs=[n for n in nodes if 'profile_details__tabs-item' in classes(n) and n['name']=='文章']
        lists=[n for n in nodes if 'profile_details__content_article_inner' in classes(n)]
        if not header or len(tabs)!=1:raise UIError('WOC_PROFILE_UNSUPPORTED','Account article list is unavailable')
        active='active' in classes(tabs[0]);items=[]
        def add(n,label,kind,rect=None):
            clip=intersect(rect or n['rect'],viewport)
            if clip[2]<4 or clip[3]<4 or not showing(n):return
            items.append(dict(title=label,kind=kind,_target=dict(path=n['path'],label=label,kind=kind,rect=clip)))
        if not active:add(tabs[0],'文章','articles_tab')
        if active and len(lists)==1:
            for n in nodes:
                if 'article-item' not in classes(n) or n['parent']!=lists[0]['path']:continue
                bodies=[b for b in nodes if b['parent']==n['path'] and 'article-item__body' in classes(b)]
                titles=[t for t in nodes if any(t['parent']==b['path'] for b in bodies) and t['role']=='static' and t['name']]
                if len(titles)!=1:continue
                title=' '.join(titles[0]['name'].split())
                add(n,title,'article',titles[0]['rect'])
        items.sort(key=lambda item:(item['_target']['rect'][1],item['_target']['rect'][0]))
        view=dict(pid=self.pid,window_id=int(self.window),frame=state['_controls']['frame']['rect'],viewport=viewport,
                  at_top=header['rect'][1]>=viewport[1]-3,position=max(0,viewport[1]-header['rect'][1]),
                  at_bottom=bool(lists) and lists[0]['rect'][1]+lists[0]['rect'][3]<=viewport[1]+viewport[3]+3)
        return dict(app='wechat',surface='profile',author=name,username=username,followed=True,articles_tab=active,view=view,
                    items=[dict(i) for i in items],_items=items,
                    _identity=dict(window=state['_identity'],document_id=doc['document_id'],username=username))

    def article_observe(self):
        state=self.observe()
        if not state['open']:raise UIError('WOC_BROWSER_NOT_OPEN','Open the article with the client open-url workflow first')
        if state['dialog']:raise UIError('WOC_DIALOG_OPEN','Resolve the browser dialog first')
        docs=[d for d in state['documents'] if not d['busy']]
        if len(docs)!=1:raise UIError('WOC_ARTICLE_UNSUPPORTED','Expected one loaded article document')
        doc=docs[0];url=article_url(doc.get('url') or '')
        doc,nodes=self.document_nodes(state)
        controls=reaction_controls(nodes)
        frame=state['_controls']['frame']['rect']
        for control in controls.values():
            x,y,w,h=control['node']['rect'];fx,fy,fw,fh=frame
            if w<4 or h<4 or not (fx<=x and fy+40<=y and x+w<=fx+fw and y+h<=fy+fh):
                raise UIError('WOC_ARTICLE_UNSUPPORTED','Article reaction is outside the browser viewport; inspect with Cua')
        viewport=next(n['rect'] for n in nodes if n['path']==doc['document_id'])
        view,author=article_layout(nodes,viewport,frame,self.pid,self.window)
        return dict(app='wechat',surface='article',title=doc['title'],url=url,view=view,author=author,
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
