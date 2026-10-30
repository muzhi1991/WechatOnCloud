"""WeChat page adapter. No network, lock acquisition, or workflow orchestration.

Executed in a bounded child process. Qt's AT-SPI bridge must never receive GetAll.
Only the supervisor may supply operation and an observation-bound internal target.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


class UIError(Exception):
    def __init__(self, code, message, execution="not_started", **details):
        self.result = dict(ok=False, code=code, error=message, execution=execution, **details)


NAV = {"conversations": "微信", "contacts": "通讯录", "favorites": "收藏", "web_search": "搜一搜"}
SECTIONS = {"联系人": "contact", "群聊": "group", "功能": "function", "聊天记录": "history",
            "搜索网络结果": "network", "收藏": "favorite", "公众号": "official"}


def showing(n):
    return bool(n["bits"] & (1 << 25)) and not n["bits"] & (1 << 6) and n.get("rect", [0]*4)[2] > 0


def classify(nodes):
    """Pure page classification; output refs remain internal until supervisor binds them."""
    visible = [n for n in nodes if showing(n)]
    by_path = {n["path"]: n for n in nodes}
    lists = [n for n in visible if n["role"] == "list"]
    search = next((n for n in visible if n["role"] == "text" and n["name"] == "搜索"), None)
    conversations = next((n for n in lists if n["name"] == "会话"), None)
    contacts = next((n for n in lists if n["name"] == "通讯录"), None)
    messages = next((n for n in lists if n["name"] == "消息"), None)
    send = next((n for n in visible if n["role"] == "push button" and n["name"] == "发送"), None)
    nav = {}
    for page, label in NAV.items():
        matches = [n for n in visible if n["role"] == "push button" and n["name"] == label
                   and by_path.get(n["parent"], {}).get("name") == "导航"]
        if len(matches) == 1: nav[page] = matches[0]
    page = "contacts" if contacts else "conversations" if conversations else "unknown"
    if page=='unknown' and any(n['role']=='label' and n['name']=='全部收藏' for n in visible): page='favorites'
    editor = title = None
    if messages and send:
        candidates = [n for n in visible if n["role"] == "text" and n != search
                      and n["rect"][0] >= messages["rect"][0]
                      and n["rect"][1] >= messages["rect"][1] + messages["rect"][3] - 2]
        labels = [n["name"] for n in visible if n["role"] == "label" and n["name"]
                  and n["rect"][0] >= messages["rect"][0]
                  and n["rect"][1] < messages["rect"][1]]
        labels = list(dict.fromkeys(labels))
        if len(candidates) == 1:
            # Group headers expose both "name(count)", "name" and "(count)".
            # Cross-check the editor's chat label; do not strip arbitrary suffixes
            # from a real person's/group's name.
            editor_name=candidates[0]['name']
            matched=[label for label in labels if editor_name==label or editor_name.startswith(label+'按住鼠标')]
            if len(matched)==1: editor, title, page = candidates[0], matched[0], "chat"
    if conversations and not messages:
        cx,cy,cw,_=conversations['rect']
        headings={n['name'] for n in visible if n['role']=='label' and n['rect'][0]>=cx+cw and n['rect'][1]<cy}
        if headings & {'公众号','服务号'}: page='official_accounts'
    # A popup is a separate AT-SPI top-level. Search results are mixed: preserve
    # section identity and NEVER make network/history/favorite matches actionable.
    result_list = None
    for node in lists:
        children = [n for n in visible if n["parent"] == node["path"] and n["role"] == "list item"]
        if not node["name"] and any(n["name"] in SECTIONS for n in children):
            result_list = node; break
    items = []
    def item(n, kind, label, action):
        # A row may be only partially visible. Click its intersection with list.
        parent = by_path.get(n["parent"], {})
        if "rect" not in parent: return
        x,y,w,h=n["rect"]; px,py,pw,ph=parent["rect"]
        left,top,right,bottom=max(x,px),max(y,py),min(x+w,px+pw),min(y+h,py+ph)
        if right-left < 4 or bottom-top < 4: return
        items.append(dict(kind=kind, label=label, action=action,
                          _target=dict(path=n["path"], name=n["name"], role=n["role"],
                                       kind=kind, point=[(left+right)//2,(top+bottom)//2])))
    if result_list:
        page = "search_results"
        section = None
        for n in visible:
            if n["parent"] != result_list["path"] or n["role"] != "list item": continue
            if n["name"] in SECTIONS: section = SECTIONS[n["name"]]; continue
            if section == "function" and n["name"] == "文件传输助手":
                item(n, "system_chat", n["name"], "open_chat")
            if section in ("contact", "group", "official") and n["name"] and not n["name"].startswith("查看全部"):
                item(n, section, n["name"].split("\n")[0], "open_chat")
    else:
        listing = contacts or conversations
        if listing:
            for n in visible:
                if n["parent"] != listing["path"] or n["role"] != "list item" or not n["name"]: continue
                if contacts and (n["name"].startswith(("联系人", "公众号、服务号"))): continue
                label = n["name"].split("\n")[0]
                if conversations and label in ("公众号", "服务号"):
                    item(n, "official_list", label, "open_official_list")
                else: item(n, "contact" if contacts else "conversation", label,
                           "open_profile" if contacts else "open_chat")
    profile_send = [n for n in visible if n["role"] == "push button" and n["name"] == "发消息"]
    if profile_send and not result_list:
        page = "contact_profile"
        item(profile_send[0], "profile_action", "发消息", "open_chat")
    # Preserve truthful unknown pages; do not label favorites/moments just because
    # their permanent navigation button exists.
    search_scope='contacts' if contacts else 'conversations' if conversations else None
    data = dict(items=items, search={"query": search.get("text", ""), "available": True, "scope": search_scope} if search else None)
    if page=='favorites':
        data['visible_labels']=list(dict.fromkeys(n['name'] for n in visible if n['role'] in ('label','list item') and n['name']))[:40]
    if page=='official_accounts':data['content']={'coverage':'header_only','note':'Article content is not exposed by this provider; use Cua for unsupported content actions'}
    if editor:
        data.update(current_chat={"display_name": title, "identity": "display_only"},
                    composer={"text": editor.get("text", ""), "send_enabled": bool(send["bits"] & (1<<8))})
    if page == "unknown":
        data["visible_labels"] = list(dict.fromkeys(n["name"] for n in visible if n["role"] in ("label","list") and n["name"]))[:40]
    official_frames=[]
    for n in visible:
        if n['role']!='push button' or n['name']!='公众号主页':continue
        parent=n
        for _ in range(40):
            if parent['parent'].endswith('/root'):break
            parent=by_path.get(parent['parent'])
            if not parent:break
        if not parent or parent['role']!='frame' or not parent['name']:continue
        official_frames.append(parent['path'])
        if parent['bits'] & (1<<1):
            page='official_chat';items=[]
            item(n,'official_profile',parent['name'],'open_official_profile')
            data=dict(items=items,official_account=parent['name'])
    dialogs = [n["name"] for n in visible if n["role"] in ("dialog", "alert")]
    search_root=None
    if result_list:
        cursor=result_list
        for _ in range(80):
            if cursor['parent'].endswith('/root'): search_root=cursor['path']; break
            cursor=by_path.get(cursor['parent'])
            if not cursor:break
    for n in visible:
        if n['parent'].endswith('/root') and n['path']!=search_root and n['path'] not in official_frames and not (n['role']=='frame' and n['name']=='微信'):
            dialogs.append(n['name'] or 'unrecognized_overlay')
    return dict(app="wechat", page=page, dialog=dialogs or None, data=data,
                available_actions=["ui_state", *(["navigate"] if nav else []),
                                   *(["ui_search"] if search and search_scope and not dialogs and page in ('chat','conversations','contacts','contact_profile','search_results') else []),
                                   *(["open_item"] if items and not dialogs else []),
                                   *(["fill_text", "send_draft"] if editor and not result_list and not dialogs else [])],
                _controls=dict(nav=nav, search=search, editor=editor, send=send))


class Desktop:
    def __init__(self, config, browser=False):
        import dbus
        self.dbus = dbus
        self.started = time.monotonic()
        self.dispatched = False
        self.env = dict(os.environ, DISPLAY=config.get("display", ":1"))
        pids=[]
        for p in Path('/proc').iterdir():
            if not p.name.isdigit(): continue
            try:
                exe = str((p/'exe').resolve(strict=True))
                suffix='/opt/wechat/RadiumWMPF/runtime/WeChatAppEx' if browser else '/opt/wechat/wechat'
                if exe.endswith(suffix) and p.stat().st_uid == os.getuid():
                    if not browser or b'--type=' not in (p/'cmdline').read_bytes():pids.append(int(p.name))
            except OSError: pass
        if browser and not pids:
            self.service=None;return
        if len(pids) != 1: raise UIError("WOC_APP_UNAVAILABLE", "Expected exactly one running WeChat process", precondition={"app":"wechat","process_count":len(pids)})
        self.pid = pids[0]
        self.bus = dbus.bus.BusConnection(config.get("bus", "unix:path=/config/.XDG/at-spi/bus_1"))
        self.service = None
        roots = self.call('org.a11y.atspi.Registry','/org/a11y/atspi/accessible/root','org.a11y.atspi.Accessible','GetChildren')
        for service,path in roots:
            pid = self.call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID',service)
            if int(pid) == self.pid: self.service = str(service); break
        if not self.service: raise UIError("WOC_UI_UNAVAILABLE", "WeChat accessibility bridge is unavailable")

    def call(self, service, path, interface, method, *args):
        remaining=3.5-(time.monotonic()-self.started)
        if remaining <= 0: raise UIError("WOC_UI_TIMEOUT", "Observation budget exceeded")
        return self.bus.get_object(service,path,introspect=False).get_dbus_method(method,interface)(*args,timeout=min(.5,remaining))

    def observe(self):
        a='org.a11y.atspi.Accessible'; prop='org.freedesktop.DBus.Properties'
        root='/org/a11y/atspi/accessible/root'; queue=[(str(s),str(p),root) for s,p in self.call(self.service,root,a,'GetChildren')]
        nodes=[]; seen=set()
        for service,path,parent in queue:
            if (service,path) in seen or path.endswith('/null'): continue
            seen.add((service,path))
            if len(seen)>2500: raise UIError("WOC_UI_INCOMPLETE", "Accessibility tree exceeds budget")
            words=self.call(service,path,a,'GetState'); bits=sum(int(v)<<(32*i) for i,v in enumerate(words))
            # Hidden containers can have visible descendants; always walk children.
            queue.extend((str(s),str(p),path) for s,p in self.call(service,path,a,'GetChildren'))
            if not bits & (1<<25) or bits & (1<<6): continue
            role=str(self.call(service,path,a,'GetRoleName'))
            name=str(self.call(service,path,prop,'Get',a,'Name'))
            interfaces=self.call(service,path,a,'GetInterfaces')
            n=dict(path=path,parent=parent,role=role,name=name,bits=bits)
            if 'org.a11y.atspi.Component' in interfaces:
                n['rect']=[int(x) for x in self.call(service,path,'org.a11y.atspi.Component','GetExtents',self.dbus.UInt32(0))]
            if role=='text' and 'org.a11y.atspi.Text' in interfaces:
                count=int(self.call(service,path,prop,'Get','org.a11y.atspi.Text','CharacterCount'))
                if count>8192: raise UIError("WOC_DRAFT_TOO_LARGE","Text field exceeds observation budget")
                n['text']=str(self.call(service,path,'org.a11y.atspi.Text','GetText',self.dbus.Int32(0),self.dbus.Int32(count))) if count else ''
            nodes.append(n)
        value=classify(nodes)
        value['_identity']=dict(pid=self.pid,service=self.service)
        return value

    def cmd(self, argv, data=None):
        return subprocess.run(argv,input=data,stdout=subprocess.DEVNULL if argv[0]=='xclip' else subprocess.PIPE,stderr=subprocess.DEVNULL,
                              env=self.env,check=True,timeout=1).stdout

    def foreground(self):
        try:
            window=self.cmd(['xdotool','getactivewindow']).decode().strip()
            pid=int(self.cmd(['xdotool','getwindowpid',window]))
        except (ValueError,subprocess.SubprocessError): pid=None
        if pid != self.pid: raise UIError("WOC_APP_NOT_FOREGROUND","Bring WeChat to the foreground with Cua first",next_action={"kind":"cua_focus_app"})

    def click(self,n,point=None):
        self.foreground()
        x,y,w,h=n.get('rect',[0]*4)
        if w<4 or h<4: raise UIError("WOC_UI_TARGET_UNAVAILABLE","Target has no usable bounds")
        px,py=point or (x+w//2,y+h//2)
        self.dispatched=True
        # X requests are ordered. --sync can wait forever when the pointer
        # already occupies this position (no movement event is generated).
        self.cmd(['xdotool','mousemove',str(px),str(py),'click','1'])

    def paste(self,text,replace=False):
        self.foreground()
        self.dispatched=True
        mods=['Control_L','Control_R','Shift_L','Shift_R','Alt_L','Alt_R','Meta_L','Meta_R','Super_L','Super_R','ISO_Level3_Shift']
        self.cmd(['xdotool','keyup','--delay','0',*mods])
        if replace: self.cmd(['xdotool','key','ctrl+a'])
        # No shell interpolation, no delayed clipboard restoration.
        self.cmd(['xclip','-selection','clipboard','-i'],text.encode())
        self.cmd(['xdotool','key','ctrl+v'])

    def execute(self,op,body):
        state=self.observe(); controls=state['_controls']
        if op=='ui_state': return state
        if state['dialog']: raise UIError("WOC_DIALOG_OPEN","Resolve the current dialog before continuing",precondition={"dialog":state['dialog']})
        if op=='navigate':
            n=controls['nav'].get(body['page'])
            if not n: raise UIError("WOC_PAGE_UNSUPPORTED","Requested navigation entry is unavailable")
            if body['page'] in NAV:
                windows=self.cmd(['xdotool','search','--all','--onlyvisible','--pid',str(self.pid),'--name','^微信$']).decode().split()
                if len(windows)!=1:raise UIError('WOC_APP_UNAVAILABLE','Expected a unique main WeChat window')
                self.dispatched=True
                self.cmd(['xdotool','windowactivate','--sync',windows[0]])
            self.click(n)
        elif op=='ui_search':
            expected={'conversations':('chat','conversations','search_results'),'contacts':('contacts','contact_profile','search_results')}
            if state['page'] not in expected[body['scope']] or not controls['search'] or state['data']['search']['scope']!=body['scope']:
                raise UIError("WOC_WRONG_PAGE","Navigate to the requested search scope first",precondition={"page":body['scope']})
            self.click(controls['search']); self.paste(body['query'],replace=True)
        elif op=='open_item':
            target=body['_target']; identity=body['_identity']
            if identity != state['_identity']: raise UIError("WOC_UI_STALE","Application was replaced; observe again")
            matches=[x for x in state['data']['items'] if x['_target']==target]
            if len(matches)!=1: raise UIError("WOC_UI_STALE","Observed item changed; observe again")
            n=target.copy(); n['rect']=[target['point'][0]-2,target['point'][1]-2,4,4]
            self.click(n,target['point'])
        elif op in ('fill_text','send_draft'):
            if state['page']!='chat' or state['data'].get('current_chat',{}).get('display_name')!=body['expected_chat']:
                raise UIError("WOC_CHAT_MISMATCH","Open and verify the expected chat first",precondition={"chat":body['expected_chat']})
            current=state['data']['composer']['text']
            expected=body.get('expected_draft','') if op=='fill_text' else body['expected_text']
            if current!=expected: raise UIError("WOC_DRAFT_MISMATCH","Draft differs from expected text; no input was made",precondition={"inspect_draft":True})
            if op=='fill_text':
                self.click(controls['editor']); self.paste(body['text'],replace=bool(expected))
            else:
                if not state['data']['composer']['send_enabled']: raise UIError("WOC_SEND_DISABLED","Send button is disabled")
                self.click(controls['send'])
        else: raise UIError("WOC_OPERATION_UNSUPPORTED","Unknown application operation")
        return dict(ok=True,execution='completed',verification='input_dispatched',next_action={'kind':'ui_state'})


def main():
    desktop=None
    try:
        request=json.load(sys.stdin)
        if request['operation'].startswith('browser_'):
            from wechat_browser import Browser
            desktop=Browser(request.get('config',{}))
        else:desktop=Desktop(request.get('config',{}))
        result=desktop.execute(request['operation'],request['body'])
    except UIError as e:
        result=e.result
        if desktop and desktop.dispatched: result['execution']='partial'
    except Exception:
        result=dict(ok=False,code='WOC_UI_EXECUTION_FAILED',error='Local UI operation failed; inspect before retry',
                    execution='unknown' if desktop and desktop.dispatched else 'not_started')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    sys.modules['wechat_ui']=sys.modules[__name__]
    main()
