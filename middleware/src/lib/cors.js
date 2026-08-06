// CORS.
//
// The browser origin here is http://<whatever-address-the-host-has-today>:4090.
// It moves with DHCP, so an allowlist written in advance cannot cover it. The
// default mode reads the Origin header and echoes it back.
//
// That is the right trade for a LAN portal. For a fixed public deployment set
// CORS_ORIGINS to an explicit comma separated list and this switches to
// allowlist mode. Do not combine reflected origins with cookie credentials,
// and this stack does not use cookies for auth.
//
// Full reasoning in .claude/guardrails/ports-and-networking.md.

import { config } from '../config.js'

const ALLOWED_HEADERS = 'Content-Type, Accept, X-Request-Id, Cache-Control'
const ALLOWED_METHODS = 'GET, POST, OPTIONS'
const EXPOSED_HEADERS = 'X-Request-Id, Content-Encoding, Cache-Control'

const parseList = (raw) =>
  raw.split(',').map((s) => s.trim()).filter(Boolean)

export function cors () {
  const mode = config.corsOrigins === 'reflect' ? 'reflect' : 'allowlist'
  const allowed = mode === 'allowlist' ? new Set(parseList(config.corsOrigins)) : null

  return (req, res, next) => {
    const origin = req.headers.origin

    if (origin) {
      if (mode === 'reflect') {
        res.setHeader('Access-Control-Allow-Origin', origin)
      } else if (allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
      }
      // Vary is required whenever the response depends on the request Origin,
      // otherwise a shared cache serves one origin's headers to another.
      res.setHeader('Vary', 'Origin')
    } else {
      // Same origin or a non browser client such as curl.
      res.setHeader('Access-Control-Allow-Origin', '*')
    }

    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS)
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS)
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS)
    res.setHeader('Access-Control-Max-Age', '86400')

    if (req.method === 'OPTIONS') {
      return res.status(204).end()
    }

    next()
  }
}
