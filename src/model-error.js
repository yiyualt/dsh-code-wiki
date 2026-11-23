const providerCodes = new Set([
  'MODEL_CONFIG', 'NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH',
  'INVALID_MODEL', 'INVALID_REQUEST', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_REASONING_EFFORT', 'CONTEXT_WINDOW_EXCEEDED',
  'RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE',
  'MALFORMED_RESPONSE', 'STREAM_CLOSED', 'PI_AI_ERROR', 'UNKNOWN',
])

export function modelError(failure) {
  const error = Object.assign(new Error('model-unavailable'), { code: 'model-unavailable' })
  if (providerCodes.has(failure?.code)) error.providerCode = failure.code
  if (Number.isInteger(failure?.status) && failure.status >= 400 && failure.status <= 599) {
    error.providerStatus = failure.status
  }
  return error
}
