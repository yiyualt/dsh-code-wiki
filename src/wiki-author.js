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
      agentOptions: ctx.agentDefaultModel.currentSelection(),
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

  async function run(prompt) {
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
      return { kind: 'agent-exception', text: null, modelFailed: true, pendingTool: false }
    }
    signal.throwIfAborted()
    const turn = events().slice(cursor)
    const end = turn.findLast(event => event.type === 'turn/end')?.data
    const content = end && turn.findLast(event => event.type === 'assistant/message' && event.data?.turn === end.turn)
      ?.data?.message?.content
    const blocks = Array.isArray(content) ? content : null
    return {
      kind: end?.reason?.kind ?? 'missing-end',
      text: blocks && blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('\n\n'),
      modelFailed: Boolean(end?.reason?.error || end?.reason?.failure),
      pendingTool: blocks?.some(block => block.type === 'tool-call') ?? false,
    }
  }

  return {
    run,
    async reply(prompt) {
      const result = await run(prompt)
      if (result.modelFailed) throw authorError('wiki-model-unavailable')
      if (result.kind !== 'completed' || result.text === null || result.pendingTool) throw authorError('wiki-author-invalid')
      return result.text
    },
    dispose,
  }
}
