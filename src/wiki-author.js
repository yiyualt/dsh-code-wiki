import { randomUUID } from 'node:crypto'
import { invalidMarkdown } from '../skills/repo-design-wiki/scripts/markdown.mjs'
import { modelError } from './model-error.js'

function settledReply(events) {
  const end = events.findLast(event => event.type === 'turn/end')?.data
  const failure = end?.reason?.error ?? end?.reason?.failure
  if (failure) {
    const wrapped = failure.code === 'UNKNOWN' ? modelError({ code: failure.message }) : undefined
    throw wrapped?.providerCode ? wrapped : modelError(failure)
  }
  if (end?.reason?.kind === 'max-tokens') throw invalidMarkdown('本轮达到输出上限，请提交一个更短的完整片段。')
  if (end?.reason?.kind !== 'completed') throw invalidMarkdown('模型本轮没有返回完整的 Markdown。')
  const response = events.findLast(event => event.type === 'assistant/message' && event.data?.turn === end.turn)?.data?.message?.content
  if (!Array.isArray(response) || response.some(block => block.type === 'tool-call')) throw invalidMarkdown('本轮没有可保存的 Markdown 正文。')
  return response.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n\n')
}

export async function openWikiAuthor(ctx, selection, adapter, { tools, signal }) {
  const provider = adapter ? 'code-wiki-' + randomUUID() : selection.provider
  let handle, disposeAdapter
  const abort = () => handle.agent.cancel({ kind: 'user' })
  async function dispose() {
    signal.removeEventListener('abort', abort)
    try { await handle?.dispose() } finally { disposeAdapter?.() }
  }

  try {
    signal.throwIfAborted()
    if (adapter) disposeAdapter = ctx.llm.registerAdapter([provider], adapter)
    handle = await ctx.agents.create({
      sessionId: 'code-wiki-' + randomUUID(), agentOptions: { ...selection, provider, maxTokens: 24_000 }, signal,
      setup(agentCtx) {
        agentCtx.tools.restrict({ allow: [] })
        for (const definition of tools) agentCtx.tools.register(definition)
      },
    })
    signal.addEventListener('abort', abort, { once: true })
    signal.throwIfAborted()
  } catch (error) {
    await dispose()
    signal.throwIfAborted()
    throw modelError(error)
  }

  const { agent } = handle
  const events = () => agent.session?.snapshotEvents?.() ?? []
  return {
    async reply(prompt) {
      const cursor = events().length
      try {
        agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] })
        await agent.whenIdle()
      } catch (error) {
        signal.throwIfAborted()
        throw modelError(error)
      }
      signal.throwIfAborted()
      return settledReply(events().slice(cursor))
    },
    dispose,
  }
}
