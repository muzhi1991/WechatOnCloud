import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
export default function AgentFrame({
  machineId,
  agentId,
  onAgent,
  onReady,
}: {
  machineId?: string;
  agentId?: string;
  onAgent?: (id: string) => void;
  onReady?: (url: string) => void;
}) {
  const [endpoint, setEndpoint] = useState(""),
    [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const c = new AbortController();
    fetch("/api/agent", { signal: c.signal })
      .then(async (r) => {
        const x = await r.json();
        if (!r.ok) throw Error(x.error);
        setEndpoint(x.url);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, []);
  const src = useMemo(() => {
    if (!endpoint) return "";
    const u = new URL(endpoint);
    if (machineId) u.searchParams.set("woc_machine", machineId);
    if (agentId) u.searchParams.set("woc_agent", agentId);
    return u.href;
  }, [endpoint, machineId, agentId]);
  useEffect(() => {
    if (src) onReady?.(src);
  }, [src, onReady]);
  useEffect(() => {
    if (!endpoint) return;
    const receive = (e: MessageEvent) => {
      if (e.origin !== new URL(endpoint).origin || e.source !== frame.current?.contentWindow)
        return;
      const d = e.data;
      if (
        d?.type === "woc-agent-selected" &&
        typeof d.agentId === "string" &&
        /^[a-f0-9-]{36}$/.test(d.agentId)
      )
        onAgent?.(d.agentId);
      if (
        d?.type === "woc-open-machine" &&
        typeof d.machineId === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(d.machineId)
      )
        navigate("/i/" + encodeURIComponent(d.machineId));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [endpoint, navigate, onAgent]);
  return error ? (
    <p role="alert">{error}</p>
  ) : src ? (
    <iframe
      ref={frame}
      title="WOC AI 助手"
      src={src}
      className="agent-frame"
      allow="clipboard-read; clipboard-write"
    />
  ) : (
    <div className="center-screen">
      <div className="spinner" />
    </div>
  );
}
