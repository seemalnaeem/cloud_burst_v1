---
name: auto-ip-requirement
description: The host address is DHCP assigned and changes, so nothing may hard-code a host or IP anywhere in the stack.
metadata:
  type: project
---

When the machine's address changes, the owner types the new address into a browser and everything
works: no rebuild, no config edit, no restart. Stated explicitly at project start.

**Why:** the old system hard-coded `172.18.1.132` for GeoServer. That is a Docker bridge address, and
another project on this machine owns that range today. It was never stable.

**How to apply:**

- Containers resolve each other by Compose service name. No `ipv4_address`, no reserved subnet.
- Published ports bind all interfaces; processes inside listen on `0.0.0.0`, not loopback.
- The browser derives every API URL from `window.location.hostname` at page load, via
  `frontend/src/lib/api.js`. Evaluated at runtime, not substituted at build time.
- CORS reflects the request origin, since an allowlist cannot cover a moving address.
- Vite needs `allowedHosts: true` and `hmr.clientPort: 4090`.

Related: [[port-allocation]], [[self-contained-project]]