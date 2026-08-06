// Structured logging with redaction.
//
// The redact list is the mechanism, so nobody has to remember at each call site
// not to log a connection string or an Authorization header.

import pino from 'pino'

import { config } from '../config.js'

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.DATABASE_URL',
      '*.databaseUrl',
      '*.token',
      '*.apiKey'
    ],
    censor: '***'
  },
  // Plain JSON to stdout. Docker collects it and `docker compose logs` reads
  // fine. No pretty printer transport, that would be a dependency whose only
  // job is to make development output nicer and whose absence crashes the
  // process at boot.
  timestamp: pino.stdTimeFunctions.isoTime
})
