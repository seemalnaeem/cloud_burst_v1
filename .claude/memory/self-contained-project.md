---
name: self-contained-project
description: Nothing from any other project on this machine may be imported into cloud-burst-dev, including code, config and conventions.
metadata:
  type: feedback
---

Do not bring code, configuration, conventions or context from any other project on this machine.

**Why:** stated explicitly. An inherited convention arrives without the reasoning that justified it,
and then nobody can say why it is there or whether it still applies. Everything here should be
explainable from files in this repository.

**How to apply:** rewrite from first principles rather than copying. Do not reference another
repository's paths, service names, ports or env vars. Do not assume a tool is installed because
another project uses it; verify inside this stack.

Two exceptions. Conflict avoidance (which host ports and Docker subnets neighbouring stacks occupy)
is operational fact, not an imported convention: see [[port-allocation]]. And DATA_SOURCES.md,
COLOR_SCHEMES.md and `app.py` at the root were supplied for this build.

Related: [[auto-ip-requirement]], [[no-authenticated-sources]]