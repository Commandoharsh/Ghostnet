import { NextRequest, NextResponse } from "next/server";

type Priority = "critical" | "high" | "normal";
type ServerMessage = { id: string; senderId: string; destinationId: string; body: string; priority: Priority; createdAt: string; expiresAt: string; state: "accepted"; classification: string; humanReviewRequired: boolean };
const store = globalThis as typeof globalThis & { ghostnetMessages?: Map<string, ServerMessage> };
const messages = store.ghostnetMessages ?? (store.ghostnetMessages = new Map());

function purgeExpired() {
  const now = Date.now();
  for (const [id, message] of messages) if (Date.parse(message.expiresAt) <= now) messages.delete(id);
}
function classify(text: string) {
  const value = text.toLowerCase();
  if (/heart attack|not breathing|bleeding|medical|injured|ambulance|sos/.test(value)) return "medical";
  if (/fire|smoke|burning/.test(value)) return "fire";
  if (/collapse|trapped|rescue|earthquake/.test(value)) return "rescue";
  return "unclassified";
}

export async function GET() {
  purgeExpired();
  return NextResponse.json({ messages: [...messages.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)), storage: "process-memory", simulation: true });
}
export async function POST(request: NextRequest) {
  let input: unknown;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (!input || typeof input !== "object") return NextResponse.json({ error: "Expected a message object" }, { status: 400 });
  const value = input as Record<string, unknown>;
  const { id, senderId, destinationId, body, priority, createdAt, expiresAt } = value;
  if (typeof id !== "string" || id.length < 8 || id.length > 100) return NextResponse.json({ error: "Invalid message ID" }, { status: 400 });
  if (typeof senderId !== "string" || senderId.length > 100 || typeof destinationId !== "string" || destinationId.length > 100) return NextResponse.json({ error: "Invalid sender or destination" }, { status: 400 });
  if (typeof body !== "string" || !body.trim() || body.length > 2000) return NextResponse.json({ error: "Message body must contain 1–2000 characters" }, { status: 400 });
  if (!["critical","high","normal"].includes(String(priority))) return NextResponse.json({ error: "Invalid priority" }, { status: 400 });
  const created = Date.parse(String(createdAt)); const expiry = Date.parse(String(expiresAt));
  if (!Number.isFinite(created) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry <= created || expiry-created > 7*24*60*60*1000) return NextResponse.json({ error: "Invalid or expired message timestamps" }, { status: 400 });
  purgeExpired();
  const existing = messages.get(id);
  if (existing) return NextResponse.json({ message: existing, duplicate: true }, { status: 200 });
  const classification = classify(body);
  const message: ServerMessage = { id, senderId, destinationId, body: body.trim(), priority: priority as Priority, createdAt: new Date(created).toISOString(), expiresAt: new Date(expiry).toISOString(), state: "accepted", classification, humanReviewRequired: priority === "critical" || classification !== "unclassified" };
  messages.set(id, message);
  return NextResponse.json({ message, duplicate: false }, { status: 201 });
}
