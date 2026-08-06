// One error shape for the whole gateway.
//
//   { "error": { "code": "...", "message": "...", "requestId": "..." } }
//
// Codes are defined here so the client can switch on them. Adding a case means
// adding it to this table, not inventing a string at a call site.

export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  DISTRICT_NOT_FOUND: 404,
  LEAD_UNAVAILABLE: 404,
  NOT_FOUND: 404,
  NOT_CONFIGURED: 501,
  UPSTREAM_ERROR: 502,
  BUSY: 503,
  UPSTREAM_TIMEOUT: 504,
  INTERNAL: 500
}

export class AppError extends Error {
  constructor (code, message, detail = null) {
    super(message)
    this.name = 'AppError'
    this.code = code in ERROR_CODES ? code : 'INTERNAL'
    this.status = ERROR_CODES[this.code]
    this.detail = detail
  }

  envelope (requestId) {
    const body = { error: { code: this.code, message: this.message, requestId } }
    if (this.detail) body.error.detail = this.detail
    return body
  }
}

// An upstream that has not been supplied yet. Returned instead of guessing a
// URL or serving sample data, because the data sources arrive incrementally and
// a plausible fake is worse than an honest gap.
export const notConfigured = (setting, what) =>
  new AppError('NOT_CONFIGURED', `${setting} is not set, so ${what} is unavailable.`, { setting })

export const errorHandler = (logger) => (err, req, res, _next) => {
  const requestId = req.id || 'unknown'

  if (err instanceof AppError) {
    logger.warn({ code: err.code, requestId, path: req.path }, err.message)
    return res.status(err.status).json(err.envelope(requestId))
  }

  if (err?.name === 'AbortError' || err?.code === 'UND_ERR_HEADERS_TIMEOUT') {
    const timeout = new AppError('UPSTREAM_TIMEOUT', 'The upstream did not answer in time.')
    return res.status(timeout.status).json(timeout.envelope(requestId))
  }

  // Full detail to the log, generic message to the caller. An exception message
  // can carry a connection string.
  logger.error({ err, requestId, path: req.path }, 'unhandled error')
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something failed on the gateway, the request id is in the log.',
      requestId
    }
  })
}

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      requestId: req.id || 'unknown'
    }
  })
}
