import { useEffect, useState, type RefObject } from 'react';
import { ToolbarMenu } from './ToolbarMenu';
import { useUI } from './ui';

// Full-desktop-only UI. The application viewer keeps its existing toolbar.
export function DesktopControls({ id, frameRef, stageRef, frameGen, readOnly, epoch, pressKey }: {
  id: string; frameRef: RefObject<HTMLIFrameElement>; stageRef: RefObject<HTMLDivElement>;
  frameGen: number; readOnly: boolean; epoch?: string; pressKey: (key: string) => Promise<void>;
}) {
  const { toast } = useUI();
  const [pointerLocked, setPointerLocked] = useState(false);
  // Desktop viewers scale locally: opening another page never resizes the remote X session.
  // Use the packaged Kasm control to preserve its absolute-pointer handling (not game mode).
  const releasePointer = () => {
    const doc = frameRef.current?.contentDocument;
    if (doc?.pointerLockElement) doc.exitPointerLock();
  };
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    const win = frameRef.current?.contentWindow;
    if (!doc) return;
    const changed = () => setPointerLocked(!!doc.pointerLockElement);
    const failed = () => toast('鼠标捕获未成功，请再次点击；浏览器可能限制此功能', 'error');
    const lostFocus = () => { if (!document.hasFocus()) releasePointer(); };
    const hidden = () => { if (document.hidden) releasePointer(); };
    const disconnected = new MutationObserver(() => { if (!doc.documentElement.classList.contains('noVNC_connected')) releasePointer(); });
    disconnected.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
    doc.addEventListener('pointerlockchange', changed);
    doc.addEventListener('pointerlockerror', failed);
    win?.addEventListener('blur', lostFocus);
    window.addEventListener('blur', lostFocus);
    document.addEventListener('visibilitychange', hidden);
    changed();
    return () => { if (doc.pointerLockElement) doc.exitPointerLock(); disconnected.disconnect(); doc.removeEventListener('pointerlockchange', changed); doc.removeEventListener('pointerlockerror', failed); win?.removeEventListener('blur', lostFocus); window.removeEventListener('blur', lostFocus); document.removeEventListener('visibilitychange', hidden); };
  }, [frameGen, id]);
  useEffect(() => { if (readOnly) releasePointer(); }, [readOnly, epoch]);
  const togglePointer = async () => {
    if (readOnly) return;
    const doc = frameRef.current?.contentDocument;
    if (doc?.pointerLockElement) { releasePointer(); return; }
    const canvas = doc?.querySelector('canvas');
    if (!canvas?.requestPointerLock) { toast('当前连接不支持鼠标捕获', 'error'); return; }
    // Kasm's pointerlockchange listener updates RFB/cursor state. Request directly so
    // a rejected browser promise is handled rather than triggering Kasm's fatal overlay.
    try { frameRef.current?.contentWindow?.focus(); await canvas.requestPointerLock(); }
    catch { toast('浏览器未允许鼠标捕获，请激活此页面后再试', 'error'); }

  };
  const fullScreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await stageRef.current?.requestFullscreen(); }
    catch { toast('当前浏览器不允许全屏，请使用浏览器全屏功能', 'error'); }
  };
  return <>
    <button className="ws-action" onClick={() => void fullScreen()}>全屏</button>
    <ToolbarMenu label="桌面操作">
    <span className="toolbar-group-label">窗口</span>
    <button className="ws-action" disabled={readOnly} onClick={() => void pressKey('super+space')}>应用菜单</button>
    <button className="ws-action" disabled={readOnly} onClick={() => void pressKey('super+d')}>显示桌面</button>
    <button className="ws-action" disabled={readOnly} onClick={() => void pressKey('alt+Tab')}>切换窗口</button>
    <span className="toolbar-group-label">鼠标</span>
    <button className={'ws-action' + (pointerLocked ? ' on' : '')} disabled={readOnly} onClick={() => void togglePointer()} title="捕获鼠标到远程桌面；按 Esc 释放">{pointerLocked ? '释放鼠标' : '捕获鼠标'}</button>
    </ToolbarMenu>
  </>;
}
