import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Keep children mounted so opening a dialog survives menu dismissal.
export function ToolbarMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpen(false);
    };
    popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const focusOutside = (e: FocusEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('focusin', focusOutside);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    window.addEventListener('resize', close); window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('focusin', focusOutside);
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key);
      window.removeEventListener('resize', close); window.removeEventListener('blur', close);
    };
  }, [open]);
  return <>
    <button ref={trigger} className={'ws-action' + (open ? ' on' : '')} aria-expanded={open} aria-controls={id}
      onClick={() => {
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) }); setOpen(!open);
      }}>{label}<span className="toolbar-chevron" aria-hidden="true">⌄</span></button>
    {createPortal(<div ref={popup} id={id} hidden={!open} className="toolbar-popup" style={position} role="group" aria-label={label}
      onClick={e => { if ((e.target as HTMLElement).closest('button:not(:disabled)')) setOpen(false); }}>
      {children}
    </div>, document.body)}
  </>;
}
