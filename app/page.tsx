"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Bell, MessageSquare, Network, Radio, ShieldCheck, Wifi, Zap } from "lucide-react";

type Snapshot = { nodes: Array<{id:string;label:string;status:string;transport:string}>; links: Array<{source:string;target:string;quality:number}>; mode:string };
export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => { fetch("/api/network").then(r => r.json()).then(setSnapshot).catch(() => setSnapshot(null)); }, []);
  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Activity/></span><div><b>ghostnet<span>.</span></b><small>RESILIENT NETWORK</small></div></div>
      <div className="workspace"><b>Operations center</b><small>Local response zone</small></div>
      <p className="nav-label">WORKSPACE</p>
      <Link className="nav active" href="/"><Network size={17}/> Overview</Link>
      <Link className="nav" href="/messages"><MessageSquare size={17}/> Message center</Link>
      <div className="nav"><AlertTriangle size={17}/> Emergency feed</div>
      <p className="nav-label">NETWORK</p>
      <div className="nav"><Radio size={17}/> Transport adapters</div>
      <div className="nav"><Wifi size={17}/> Network status</div>
      <div className="nav"><ShieldCheck size={17}/> Security</div>
      <div className="side-note">Offline-first prototype <span>●</span></div>
    </aside>
    <section className="main-area">
      <header className="topbar"><span>Workspace / <b>Overview</b></span><span className="simulation">● SIMULATION ENVIRONMENT</span></header>
      <div className="content">
        <div className="page-heading"><div><small className="eyebrow">● LOCAL SERVICES READY</small><h1>Network overview</h1><p>Monitor the GhostNet development network.</p></div><Link className="primary-link" href="/messages">Open messages</Link></div>
        <div className="stat-grid">
          <article className="stat"><small>Virtual nodes</small><strong>{snapshot?.nodes.length ?? "—"}</strong><span>Simulator data</span></article>
          <article className="stat"><small>Simulated links</small><strong>{snapshot?.links.length ?? "—"}</strong><span>Not physical radio links</span></article>
          <article className="stat"><small>Network mode</small><strong className="stat-word">SIMULATED</strong><span>Local development</span></article>
          <article className="stat"><small>Message center</small><strong><MessageSquare size={23}/></strong><Link href="/messages">Compose and queue messages</Link></article>
        </div>
        <section className="panel">
          <div className="panel-heading"><div><h2>Virtual network topology</h2><p>Node inventory returned by the local simulator API.</p></div><span className="status-pill">SIMULATION</span></div>
          <div className="node-grid">{(snapshot?.nodes ?? []).map(node => <div className="node-card" key={node.id}><span className="node-icon"><Radio size={18}/></span><div><b>{node.label}</b><small>{node.id} · {node.transport}</small></div><span className={`node-state ${node.status}`}>{node.status}</span></div>)}</div>
          {!snapshot && <p className="empty">Network simulator unavailable. The dashboard remains available.</p>}
        </section>
        <section className="panel transport-panel"><div className="panel-heading"><div><h2>Transport abstraction</h2><p>Planned interchangeable adapters.</p></div></div><div className="transport-grid">{[["LoRa","Long-range, low-bandwidth"],["Wi-Fi / LAN","Local IP networking"],["Bluetooth LE","Nearby discovery"],["Ethernet","Wired gateway link"]].map(([name,desc])=><div className="transport-card" key={name}><Zap size={17}/><b>{name}</b><small>{desc}</small><label>ADAPTER PLANNED</label></div>)}</div></section>
        <footer>GHOSTNET v0.2.0 · Development prototype <span><Bell size={13}/> Simulation only</span></footer>
      </div>
    </section>
  </main>;
}
