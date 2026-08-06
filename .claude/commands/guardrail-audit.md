---
description: Scan for guardrail violations - hardcoded IPs, magic thresholds, Lucide, hex in components, credentials, em-dashes, out of range ports.
---

Audit the working tree against [GUARDRAILS.md](../guardrails/GUARDRAILS.md). Report by rule with file
and line. Exclude `node_modules`, `dist`, `.git`, and the owner-supplied root docs (DATA_SOURCES.md,
COLOR_SCHEMES.md, app.py).

1. **IPv4 literals** in source or config. `127.0.0.1` and `0.0.0.0` are fine in healthchecks and
   bind addresses; anything else is a violation.
2. **Magic numbers** that belong to contracts, outside `shared/contracts/` and tests: `70.5`, `0.75`
   as a weight, `-0.02`, `-0.2`, `1500`, `28000`, `#d7191c`, `#fdae61`.
3. **Lucide**: any `lucide` occurrence.
4. **Icon root imports**: `from 'react-icons'` with no set suffix.
5. **Hex literals** in `frontend/src/components` or `frontend/src/features`.
6. **Credentials**: any env var or field matching key, token, secret, service account, oauth, or any
   reference to GeoServer or Earth Engine outside a comment stating the ban.
7. **Ports** outside 3090-3099, 4090-4099, 5545 in compose or env.
8. **Em-dashes** (U+2014) in files this project created.
9. **Direct `fetch(`** in `frontend/src` outside `lib/api.js`.
10. **Unparameterized SQL**: concatenation or f-strings building a query in `backend/app`.

For each finding give file, line, rule and the specific fix. State clean rules in one line rather
than omitting them. End with a count per rule.