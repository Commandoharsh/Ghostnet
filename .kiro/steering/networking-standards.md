---
inclusion: always
---
# Networking Standards

GhostNet must be transport-independent. Initial/future adapters may include LoRa, Wi-Fi/LAN, Wi-Fi Direct, Bluetooth LE, Ethernet, and a simulator.

All adapters implement the shared contract. Expose capabilities such as maximum payload size, bandwidth estimate, unicast/broadcast support, and acknowledgement support. Do not assume all transports share the same MTU or reliability.

Messages require unique IDs, creation/expiry times, bounded hop counts, duplicate suppression, and explicit delivery state. Store-and-forward must use bounded retries, expiry, and congestion-aware scheduling. Fragmentation/reassembly must be bounded and integrity checked.

A transport failure must not crash other adapters. Clearly distinguish simulation from physical connectivity. Validate regional radio regulations and hardware capabilities before deployment.
