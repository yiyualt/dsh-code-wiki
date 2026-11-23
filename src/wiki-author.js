import { randomUUID } from 'node:crypto'

function authorError(code) {
  return Object.assign(new Error(code), { code })
}

export async function openWikiAuthor(ctx, { tools, signal }) {
  signal.throwIfAborted()
  let handle
  try {
    handle = await ctx.agents.create({
      sessionId: 'code-wiki-' + randomUUID(),
      agentOptions: { ...ctx.agentDefaultModel.currentSelection(), maxTokens: 12_000 },
      signal,
      setup(agentCtx) {
        agentCtx.tools.restrict({ allow: [] })
        for (const tool of tools) agentCtx.tools.register(tool)
      },
    })
  } catch {
    signal.throwIfAborted()
    throw authorError('wiki-model-unavailable')
  }

  const { agent } = handle
  const abort = () => agent.cancel({ kind: 'user' })
  async function dispose() {
    signal.removeEventListener('abort', abort)
    await handle.dispose()
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    await dispose()
    signal.throwIfAborted()
  }
  const events = () => agent.session.snapshotEvents()

  return {
    async reply(prompt) {
      signal.throwIfAborted()
      const cursor = events().length
      try {
        agent.followup({
          id: randomUUID(), role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: prompt }],
        })
        await agent.whenIdle()
      } catch {
        signal.throwIfAborted()
        throw authorError('wiki-model-unavailable')
      }
      signal.throwIfAborted()
      const turn = events().slice(cursor)
      const end = turn.findLast(event => event.type === 'turn/end')?.data
      if (end?.reason?.error || end?.reason?.failure) throw authorError('wiki-model-unavailable')
      if (end?.reason?.kind !== 'completed') throw authorError('wiki-outline-invalid')
      const content = turn.findLast(event => event.type === 'assistant/message' && event.data?.turn === end.turn)
        ?.data?.message?.content
      if (!Array.isArray(content) || content.some(block => block.type === 'tool-call')) throw authorError('wiki-outline-invalid')
      return content.filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('\n\n')
    },
    dispose,
  }
}
