import { readFile } from 'node:fs/promises'

function failure(code) {
  return Object.assign(new Error(code), { code })
}

function wireMessage(message) {
  const content = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content }
  if (message.role !== 'assistant') return { role: message.role === 'developer' ? 'system' : message.role, content }
  const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({
    id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments },
  }))
  return { role: 'assistant', content: content || null, ...(calls.length && { tool_calls: calls }) }
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
  if (!headers.has('user-agent')) headers.set('user-agent', 'DSH Code Wiki')

  let calls = 0
  const adapter = {
    model: config.model,
    providerInfo: provider => ({ id: provider, name: 'Code Wiki GPT' }),
    providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: config.model, name: config.model }],
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: model }, stream: options => adapter.stream(options) }
    },
    async *stream({ system, messages, maxTokens, tools, signal }) {
      if (tools?.length && ++calls > 28) throw failure('INVALID_REQUEST')
      const reasoning = config.extra_body?.reasoning_effort
      const request = {
        model: config.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...messages.map(wireMessage),
        ],
        max_tokens: Number.isInteger(config.max_tokens) && config.max_tokens > 0
          ? Math.min(maxTokens, config.max_tokens) : maxTokens,
        ...(typeof reasoning === 'string' && reasoning !== 'none' ? { reasoning_effort: reasoning } : {}),
        ...(tools?.length && { tools: tools.map(({ name, description, parameters }) => ({
          type: 'function', function: { name, description, parameters },
        })) }),
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
      const content = choice?.message?.content
      const toolCalls = choice?.message?.tool_calls ?? []
      if ((typeof content !== 'string' || !content.trim()) && !toolCalls.length) throw failure('EMPTY_RESPONSE')
      let index = 0
      if (typeof content === 'string' && content.trim()) {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: content }
        yield { type: 'block-end', index: index++, block: { type: 'text', text: content } }
      }
      for (const call of toolCalls) {
        const name = call?.function?.name
        const args = call?.function?.arguments
        if (!tools?.some(tool => tool.name === name) || !['wiki_list', 'wiki_read', 'wiki_read_batch', 'wiki_find', 'wiki_publish'].includes(name)
          || typeof call.id !== 'string' || typeof args !== 'string') throw failure('MALFORMED_RESPONSE')
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: call.id, name, argumentsDelta: args }
        yield { type: 'block-end', index: index++, block: { type: 'tool-call', id: call.id, name, arguments: args } }
      }
      const kind = toolCalls.length ? 'tool-calls' : choice.finish_reason === 'stop' ? 'stop' : 'max-tokens'
      yield { type: 'finish', reason: { kind } }
    },
  }
  return adapter
}
