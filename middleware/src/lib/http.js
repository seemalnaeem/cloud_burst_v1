// Outbound HTTP.
//
// Two things every outbound call gets, without exception:
//
//   Timeout. A hung upstream otherwise holds a connection open until the
//   process runs out of them, and the symptom looks like the gateway being
//   broken rather than the upstream.
//
//   A User-Agent. Several public weather services reject a default client
//   agent outright.

import { request } from 'undici'

import { config } from '../config.js'
import { AppError } from './errors.js'
import { logger } from './logger.js'

async function call (url, { method = 'GET', headers = {}, timeoutMs, body } = {}) {
  const timeout = timeoutMs ?? config.upstreamTimeoutMs
  const started = Date.now()

  try {
    const res = await request(url, {
      method,
      body,
      headers: { 'user-agent': config.external.userAgent, ...headers },
      headersTimeout: timeout,
      bodyTimeout: timeout
    })

    logger.debug({ url, status: res.statusCode, ms: Date.now() - started }, 'upstream call')
    return res
  } catch (err) {
    if (err.name === 'AbortError' || err.code === 'UND_ERR_HEADERS_TIMEOUT' || err.code === 'UND_ERR_BODY_TIMEOUT') {
      throw new AppError('UPSTREAM_TIMEOUT', `Upstream did not answer within ${timeout} ms.`, { url })
    }
    throw new AppError('UPSTREAM_ERROR', `Upstream request failed: ${err.message}`, { url })
  }
}

export async function getJson (url, options = {}) {
  const res = await call(url, options)

  if (res.statusCode >= 400) {
    // Log the body, do not forward it. An upstream error page can contain
    // internal hostnames and stack traces.
    const text = await res.body.text().catch(() => '')
    logger.warn({ url, status: res.statusCode, body: text.slice(0, 500) }, 'upstream error')
    throw new AppError('UPSTREAM_ERROR', `Upstream returned ${res.statusCode}.`, { url })
  }

  const contentType = res.headers['content-type'] || ''
  if (!contentType.includes('json')) {
    await res.body.dump()
    throw new AppError('UPSTREAM_ERROR', `Expected JSON, upstream sent ${contentType}.`, { url })
  }

  return res.body.json()
}

export async function stream (url, options = {}) {
  const res = await call(url, options)
  if (res.statusCode >= 400) {
    await res.body.dump()
    throw new AppError('UPSTREAM_ERROR', `Upstream returned ${res.statusCode}.`, { url })
  }
  return res
}

export const http = { getJson, stream }
