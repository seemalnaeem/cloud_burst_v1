---
description: Check the stack is up, healthy and reachable, and report the URLs that work right now.
---

1. `docker compose ps`, note anything not healthy.
2. Probe: `/health` on 3090 and 3091, `/index.json` on 3092, `/healthz` on 3093, `/` on 4090.
3. Confirm the arbitrary-origin path, the check people skip:
   `curl -s -H 'Origin: http://10.9.9.9:4090' -i http://localhost:3090/health | grep -i access-control`
4. Data readiness: `curl -s http://localhost:3091/integrity`.
5. Discover the machine's current IPv4 addresses and print the portal URL for each, since the address
   is DHCP assigned and moves.

Report a short table of service, status and problem. For anything failing, give the specific next
step from [troubleshooting.md](../playbooks/troubleshooting.md), not a generic suggestion.