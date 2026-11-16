import { readFile } from 'node:fs/promises'

function failure(code) {
  return Object.assign(new Error(code), { code })
}

export async function readConfiguredModel(configFile, signal) {
  let config
  let endpoint
  try {
    config = JSON.parse(await readFile(configFile, { encoding: 'utf8', signal })).judge
    endpoint = new URL(config.url)
  } catch {
    throw failure('MODEL_CONFIG')
  }

  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith('/chat/completions')
    || typeof config.model !== 'string' || !config.model.trim()) throw failure('MODEL_CONFIG')

  const envKey = typeof config.api_key_env === 'string' ? process.env[config.api_key_env] : undefined
  const key = envKey?.trim() || (typeof config.api_key === 'string' && config.api_key.trim())
  if (!key) throw failure('MISSING_CREDENTIAL')
  const headers = new Headers(config.headers ?? {})
  headers.set('content-type', 'application/json')
  headers.set('authorization', `Bearer ${key}`)

  return {
    model: config.model,
    async *stream({ system, messages, maxTokens, signal }) {
      const reasoning = config.extra_body?.reasoning_effort
      const request = {
        model: config.model,
        messages: [
          { role: 'system', content: system },
          ...messages.map(message => ({
            role: message.role,
            content: message.content.map(block => block.text).join('\n'),
          })),
        ],
        max_tokens: Number.isInteger(config.max_tokens) && config.max_tokens > 0
          ? Math.min(maxTokens, config.max_tokens) : maxTokens,
        ...(typeof reasoning === 'string' && reasoning !== 'none' ? { reasoning_effort: reasoning } : {}),
      }
      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          redirect: 'error',
          signal,
        })
      } catch {
        throw failure('TRANSPORT')
      }
      if (!response.ok) {
        await response.body?.cancel()
        const status = response.status
        const code = status >= 500 ? 'SERVER' : status === 429 ? 'RATE_LIMIT'
          : status === 401 || status === 403 ? 'AUTH' : 'INVALID_REQUEST'
        throw Object.assign(failure(code), { status })
      }
      const data = await response.json().catch(() => undefined)
      const choice = data?.choices?.[0]
      if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw failure('EMPTY_RESPONSE')
      yield { type: 'text-delta', text: choice.message.content }
      yield { type: 'finish', reason: { kind: choice.finish_reason === 'stop' ? 'stop' : 'max-tokens' } }
    },
  }
}
