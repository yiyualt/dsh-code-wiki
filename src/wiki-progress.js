const phases = new Set(['reading', 'planning', 'researching', 'writing', 'reviewing', 'saving'])
const steps = new Set(['repository', 'planning', 'researching', 'drafting', 'revising', 'validating',
  'submission-retry', 'agent-finishing', 'reviewing', 'review-reading', 'saving'])
const defaults = { reading: 'repository', planning: 'planning', researching: 'researching', writing: 'drafting', reviewing: 'reviewing', saving: 'saving' }
const counters = ['repair', 'attempt', 'attemptLimit', 'rejections']
const categories = new Set(['validation', 'review', 'missing-publication'])
const requestEvents = new Set(['request-start', 'request-receiving', 'request-retry', 'request-completed', 'request-failed'])
const retryCodes = new Set(['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'RATE_LIMIT', 'SERVER', 'AUTH', 'INVALID_REQUEST',
  'EMPTY_RESPONSE', 'MALFORMED_RESPONSE', 'MODEL_CONFIG', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'UNKNOWN'])
const reasons = new Set(['completed', 'timeout', 'cancelled', 'source-error', 'model-error', 'validation-error', 'storage-error', 'unexpected-error'])
const integer = (value, maximum = 1_000_000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum
const elapsed = (now, start) => Math.max(0, now - start)

// Keep diagnostics separate from research material and never log model or source content.
export function createWikiProgress(job) {
  let phaseStartedAt = Date.now(), stepStartedAt = phaseStartedAt, lastActivityAt = phaseStartedAt
  let details = { step: defaults[job.phase] ?? 'repository' }, finishedAt, heartbeat
  let lastRequest
  const requests = new Map()
  function transport(now) {
    const active = [...requests.values()]
    const current = active.findLast(item => item.event === 'request-retry' || item.attempt > 1) ?? active.at(-1) ?? lastRequest
    if (!current) return undefined
    const { receivedAt, ...value } = current
    if (requests.has(value.requestId)) {
      value.requestElapsedMs += elapsed(now, receivedAt)
      value.attemptElapsedMs += elapsed(now, receivedAt)
    }
    return value
  }
  function status() {
    const now = finishedAt ?? Date.now()
    const request = transport(now)
    return { ...details, phaseElapsedMs: elapsed(now, phaseStartedAt), stepElapsedMs: elapsed(now, stepStartedAt),
      activityElapsedMs: elapsed(now, lastActivityAt), ...(request && { transport: request }) }
  }
  function record(event, extra = {}) {
    const { retryMessage, transport: request, ...state } = status()
    const entry = { timestamp: new Date(finishedAt ?? Date.now()).toISOString(), event, jobId: job.id,
      phase: job.phase, elapsedMs: elapsed(finishedAt ?? Date.now(), job.startedAt), timeoutMs: 30 * 60_000,
      ...state, ...(integer(job.filesRead, 90) && { filesRead: job.filesRead }),
      ...(request && { transport: request }), ...extra }
    try { console.info('[dsh-code-wiki:wiki] ' + JSON.stringify(entry)) } catch { /* Diagnostics must not interrupt generation. */ }
  }
  function phase(next, metadata = {}) {
    if (finishedAt !== undefined || !phases.has(next)) return
    const now = Date.now(), changed = job.phase !== next
    const step = steps.has(metadata.step) ? metadata.step : changed ? defaults[next] : details.step
    if (changed) phaseStartedAt = now
    if (changed || details.step !== step) {
      stepStartedAt = now
      delete details.reasonCategory
      delete details.retryMessage
    }
    job.phase = next
    details.step = step
    for (const key of counters) if (integer(metadata[key], key === 'repair' ? 2 : 1000)) details[key] = metadata[key]
    if (categories.has(metadata.reasonCategory)) details.reasonCategory = metadata.reasonCategory
    if (typeof metadata.retryMessage === 'string') details.retryMessage = metadata.retryMessage.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 900)
    lastActivityAt = now
    record('progress')
  }
  function model(event) {
    if (finishedAt !== undefined || !requestEvents.has(event?.event) || !integer(event.requestId) || event.requestId < 1) return
    const now = Date.now()
    const value = { event: event.event, requestId: event.requestId,
      attempt: integer(event.attempt, 3) && event.attempt > 0 ? event.attempt : 1,
      attemptLimit: integer(event.attemptLimit, 3) && event.attemptLimit > 0 ? event.attemptLimit : 1,
      requestElapsedMs: integer(event.requestElapsedMs, 3_600_000) ? event.requestElapsedMs : 0,
      attemptElapsedMs: integer(event.attemptElapsedMs, 3_600_000) ? event.attemptElapsedMs : 0,
      ...(retryCodes.has(event.retryCode) && { retryCode: event.retryCode }),
      ...(integer(event.providerStatus, 599) && event.providerStatus >= 100 && { providerStatus: event.providerStatus }),
      ...(integer(event.retryInMs, 10_000) && { retryInMs: event.retryInMs }), receivedAt: now }
    if (['request-completed', 'request-failed'].includes(value.event)) { requests.delete(value.requestId); lastRequest = value }
    else requests.set(value.requestId, value)
    lastActivityAt = now
    const { receivedAt, ...snapshot } = value
    record(event.event, { transport: snapshot })
  }
  function activity(event, metadata) {
    if (finishedAt !== undefined || !['source-read', 'checkpoint'].includes(event)) return
    lastActivityAt = Date.now()
    const values = {}
    if (integer(metadata?.evidenceCount, 240)) values.evidenceCount = metadata.evidenceCount
    if (typeof metadata?.hasDraft === 'boolean') values.hasDraft = metadata.hasDraft
    record(event, values)
  }
  function finish(outcome, reason = 'unexpected-error') {
    if (finishedAt !== undefined) return
    finishedAt = Date.now()
    clearInterval(heartbeat)
    record('finish', { outcome: outcome === 'completed' ? 'completed' : 'failed', reason: reasons.has(reason) ? reason : 'unexpected-error' })
    requests.clear()
  }
  record('start')
  heartbeat = setInterval(() => record('heartbeat'), 30_000)
  heartbeat.unref?.()
  return { phase, model, status, activity, finish }
}
