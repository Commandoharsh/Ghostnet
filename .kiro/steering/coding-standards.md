---
inclusion: always
---
# Coding Standards

- TypeScript strict mode; avoid `any`.
- Validate all untrusted API and radio input.
- Use explicit interfaces and narrow module boundaries.
- Handle async failures and disconnected transports.
- Avoid unbounded retries, queues, and memory growth.
- Use stable message IDs and UTC timestamps.
- Keep transport-specific behavior inside adapters.
- Add tests for message validation, expiry, deduplication, queue persistence, routing, and adapter failures.
- Before edits, inspect existing code, preserve working features, type-check, test, and run a production build.
