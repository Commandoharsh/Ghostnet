# Core Requirements

1. Dashboard starts locally without requiring a remote service.
2. Messages receive stable IDs and timestamps.
3. Browser outbox persists queued messages across reloads using IndexedDB.
4. Messages can be retried when connectivity returns.
5. Duplicate IDs are not inserted twice by the API.
6. Expired messages are excluded from active message listings.
7. Transport adapters share one interface and can be registered independently.
8. Simulator is clearly labelled as simulation.
9. Tests cover validation, expiry, deduplication, queue retry, and transport failure.
10. Physical radio operation is not claimed until hardware integration is implemented and tested.
