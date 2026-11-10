# GhostNet — latest portable source bundle

This archive is a portable reconstruction of the latest GhostNet implementation described in this conversation: Next.js dashboard, message center, API routes, browser IndexedDB outbox, transport abstraction, registry/manager, and simulator.

**Important provenance note:** this ZIP is generated from source that is available in this chat. It is not a direct export of the live ProductOS repository or your laptop folder, so changes made only in those environments may not be included. Compare/merge with your local project before replacing files.

## Requirements

- Node.js 20.9+
- npm
- Kiro or another TypeScript-capable editor

## Install and run

```powershell
# Extract ZIP, then enter the project directory
cd GhostNet-latest
npm install
npm run dev
```

Open http://localhost:3000. Message center: http://localhost:3000/messages.

Type-check with `npm run typecheck`; production build with `npm run build`.

## What is implemented

- Responsive operations dashboard and message center.
- `GET` and `POST /api/messages` endpoints.
- In-memory server message store with ID deduplication and expiry filtering.
- IndexedDB browser outbox that saves messages locally before attempting API delivery.
- Retry of pending messages when the browser comes online or the user requests sync.
- Common transport adapter contract, registry, manager, and virtual simulator adapter.
- Network snapshot API and simulated topology.

## Limitations

- API message storage is in process memory and is lost when the server restarts.
- Browser outbox is local to one browser profile/device.
- Simulator links/nodes are simulated only.
- No physical LoRa, Bluetooth, Wi-Fi Direct, ESP32, or Raspberry Pi integration is included.
- Emergency classification is a simple advisory keyword heuristic, not a validated AI model.
- This is a development foundation, not a safety-certified emergency system.

## Kiro guidance

See `.kiro/steering/` and `.kiro/specs/`. Inspect existing files before applying changes to another GhostNet checkout.
