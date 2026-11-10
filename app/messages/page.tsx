"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, MessageSquare, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { enqueueMessage, getQueuedMessages, syncOutbox, type QueuedMessage } from "../../src/lib/offline/outbox";

type Message = QueuedMessage & { status?: string; classification?: string };
export default function MessagesPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<"critical"|"high"|"normal">("normal");
  const [status, setStatus] = useState("Loading local message store…");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const local = await getQueuedMessages();
    let remote: Message[] = [];
    try {
      const response = await fetch("/api/messages", { cache: "no-store" });
      if (response.ok) { const data = await response.json(); remote = data.messages ?? []; }
      setStatus(navigator.onLine ? "Server reachable · local outbox retained" : "Offline · messages remain on this device");
    } catch { setStatus("Offline or server unavailable · local outbox active"); }
    const byId = new Map<string, Message>();
    [...remote, ...local].forEach(m => byId.set(m.id, m));
    setMessages([...byId.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)));
  }
  useEffect(() => { refresh(); const onOnline = () => { void runSync(); }; window.addEventListener("online", onOnline); return () => window.removeEventListener("online", onOnline); }, []);
  async function sendMessage() {
    if (!body.trim()) return;
    const message: QueuedMessage = { id: crypto.randomUUID(), senderId: "GN-LOCAL-001", destinationId: "broadcast", body: body.trim(), priority, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+24*60*60*1000).toISOString(), state: "queued" };
    await enqueueMessage(message);
    setBody("");
    setStatus("Saved to this device before network transmission.");
    await refresh();
    if (navigator.onLine) await runSync();
  }
  async function runSync() {
    if (busy || !navigator.onLine) return;
    setBusy(true);
    try { const result = await syncOutbox(); setStatus(`Sync complete · ${result.sent} sent · ${result.pending} pending · ${result.failed} failed`); }
    finally { setBusy(false); await refresh(); }
  }
  const pending = useMemo(() => messages.filter(m => m.state === "queued" || m.state === "failed").length, [messages]);
  return <main className="message-page">
    <header className="message-top"><Link href="/" className="back-link"><ArrowLeft size={16}/> Dashboard</Link><span className="simulation">OFFLINE-FIRST MESSAGE CENTER</span></header>
    <section className="message-wrap">
      <div className="page-heading"><div><small className="eyebrow">MESSAGING</small><h1>Message center</h1><p>Messages are written to this browser's outbox before transmission.</p></div><button className="secondary-button" onClick={runSync} disabled={busy || !navigator.onLine}><RefreshCw size={15} className={busy ? "spin" : ""}/> Sync outbox</button></div>
      <div className="notice"><ShieldAlert size={17}/><span><b>Prototype limitation:</b> Sync currently posts to this application's API. It does not transmit through physical radio hardware.</span></div>
      <section className="compose-panel"><h2>Compose message</h2><textarea value={body} onChange={e=>setBody(e.target.value)} placeholder="Enter an emergency or network message…" maxLength={2000}/><div className="compose-actions"><select value={priority} onChange={e=>setPriority(e.target.value as typeof priority)}><option value="critical">Critical</option><option value="high">High</option><option value="normal">Normal</option></select><button className="primary-button" onClick={sendMessage} disabled={!body.trim()}><Send size={15}/> Save and send</button></div></section>
      <section className="message-list-panel"><div className="list-heading"><div><h2>Message history</h2><p>{status}</p></div><span className="pending-count">{pending} pending</span></div>
        {messages.length ? messages.map(m=><article className="message-row" key={m.id}><span className="message-symbol"><MessageSquare size={17}/></span><div className="message-copy"><div><b>{m.senderId}</b><time>{new Date(m.createdAt).toLocaleString()}</time></div><p>{m.body}</p><small>{m.destinationId} · expires {new Date(m.expiresAt).toLocaleString()}</small></div><span className={`priority ${m.priority}`}>{m.priority}</span><span className="delivery-state">{m.state}</span></article>) : <p className="empty">No messages yet. Compose a message to start the local outbox.</p>}
      </section>
    </section>
  </main>;
}
