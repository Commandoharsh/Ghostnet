---
inclusion: always
---
# Security Requirements

Use established cryptographic protocols and libraries; never invent encryption. Plan for authenticated sender identity, integrity protection, replay protection, secure key storage, and least-privilege device enrollment.

Validate message lengths, timestamps, hop counts, priorities, destinations, and packet framing. Do not trust sender-supplied identity or delivery acknowledgements without authentication. Minimize location collection and avoid logging message contents or secrets.

Emergency classifications are advisory. Do not silently discard a message based on an unvalidated model. This prototype is not security-audited or safety-certified.
