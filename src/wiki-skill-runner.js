import { randomUUID } from 'node:crypto'
import { modelError } from './model-error.js'
import { repositoryTools } from './repository-tools.js'
import { normalizeWikiChapter, renderWikiDocument, restoreWikiDraft, wikiInvalid } from './wiki-document.js'
import { maxWikiMarkdownLength, readMarkdownReply, resolveMarkdownCitations, savedWikiHeadings } from './wiki-markdown.js'

const recoverable = new Set(['MALFORMED_RESPONSE', 'EMPTY_RESPONSE', 'STREAM_CLOSED'])

function previousMarkdown(checkpoint, source, evidence, plan) {
  if (!plan || !checkpoint.chapters?.length) return ''
  const byId = new Map(checkpoint.chapters.map(chapter => [chapter.id, chapter]))
  const chapters = plan.chapters.filter(chapter => byId.has(chapter.id))
    .map(chapter => normalizeWikiChapter(byId.get(chapter.id), source, evidence, plan))
  // Legacy local URLs belonged to the previous job. Preserve their original evidence index.
  return renderWikiDocument({ chapters, graph: { layers: [], edges: [] } }, source).markdown.trim()
    .replace(/\[\d+\]\(https:\/\/dsh-code-wiki\.invalid\/source\?key=[a-f0-9-]+&file=(\d+)&start=(\d+)&end=(\d+)\)/g,
      (_match, id, start, end) => `[E${id}:${start}-${end}]`)
}

function savedEvidenceTool(evidence) {
  return {
    name: 'wiki_read_saved', description: 'Read original numbered text for up to four saved evidence IDs from the current commit.',
    parameters: { type: 'object', properties: { ids: { type: 'array', minItems: 1, maxItems: 4,
      items: { type: 'integer', minimum: 1 } } }, required: ['ids'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] },
      render: (_args, result) => [{ type: 'text', text: result.data }] },
    execute({ ids } = {}, options) {
      options?.signal?.throwIfAborted()
      if (!Array.isArray(ids) || !ids.length || ids.length > 4
        || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > evidence.length)) {
        return { data: JSON.stringify({ error: 'Use one to four existing evidence IDs.' }) }
      }
      const results = [...new Set(ids)].map(id => {
        const { path, start, end, kind, text } = evidence[id - 1]
        return { evidence: id, path, start, end, kind,
          lines: text.split('\n').map((line, index) => `${start + index} | ${line}`).join('\n') }
      })
      return { data: JSON.stringify({ results }) }
    },
  }
}

function settledReply(events) {
  const end = events.findLast(event => event.type === 'turn/end')?.data
  const failure = end?.reason?.error ?? end?.reason?.failure
  if (failure) {
    const wrapped = failure.code === 'UNKNOWN' ? modelError({ code: failure.message }) : undefined
    throw wrapped?.providerCode ? wrapped : modelError(failure)
  }
  if (end?.reason?.kind === 'max-tokens') throw wikiInvalid('本轮达到输出上限，请提交一个更短的完整片段。')
  if (end?.reason?.kind !== 'completed') throw wikiInvalid('模型本轮没有返回完整的 Markdown。')
  const response = events.findLast(event => event.type === 'assistant/message' && event.data?.turn === end.turn)?.data?.message?.content
  if (!Array.isArray(response) || response.some(block => block.type === 'tool-call')) throw wikiInvalid('本轮没有可保存的 Markdown 正文。')
  return readMarkdownReply(response.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n\n'))
}

export async function runWikiSkill(ctx, source, selection, adapter, signal, onRead, onPhase, { checkpoint, loadSkill, onCheckpoint }) {
  const { definitions, evidence } = repositoryTools(source, signal, onRead, checkpoint?.evidence)
  const legacy = checkpoint && !checkpoint.textDraft ? restoreWikiDraft(checkpoint, source, evidence) : undefined
  if (legacy?.draft) return { ...renderWikiDocument(legacy.draft, source), files: evidence }
  let textDraft = checkpoint?.textDraft ?? { markdown: previousMarkdown(checkpoint ?? {}, source, evidence, legacy?.plan), complete: false }
  let handle, disposeAdapter, lastSnapshot
  let writes = Promise.resolve()
  const abort = () => handle?.agent.cancel({ kind: 'user' })
  const result = () => ({ markdown: resolveMarkdownCitations(textDraft.markdown, source, evidence), format: 'skill-markdown', files: evidence })
  async function save(snapshot = textDraft) {
    const copy = structuredClone({ textDraft: snapshot, evidence })
    const serialized = JSON.stringify(copy)
    if (serialized === lastSnapshot) return writes
    lastSnapshot = serialized
    const writing = writes.catch(() => {}).then(() => onCheckpoint(copy))
    writes = writing
    try { await writing }
    catch (error) {
      if (lastSnapshot === serialized) lastSnapshot = undefined
      throw error
    }
  }

  try {
    if (textDraft.complete) return result()
    const skill = await loadSkill()
    if (checkpoint) {
      await save()
      onRead?.(new Set(evidence.map(file => file.path)).size, evidence.at(-1)?.path)
    }
    let activeReads = 0
    for (const definition of definitions) {
      const execute = definition.execute
      definition.execute = async (...args) => {
        if (++activeReads === 1) onPhase('researching', { step: 'researching' })
        const before = evidence.length
        try {
          const value = await execute(...args)
          if (evidence.length !== before) await save()
          return value
        } finally {
          if (--activeReads === 0 && !signal.aborted) onPhase('writing', { step: 'drafting' })
        }
      }
    }
    const provider = adapter ? 'code-wiki-' + randomUUID() : selection.provider
    if (adapter) disposeAdapter = ctx.llm.registerAdapter([provider], adapter)
    handle = await ctx.agents.create({
      sessionId: 'code-wiki-' + randomUUID(), agentOptions: { ...selection, provider, maxTokens: 24_000 }, signal,
      setup(agentCtx) {
        agentCtx.tools.restrict({ allow: [] })
        for (const definition of [...definitions, savedEvidenceTool(evidence)]) agentCtx.tools.register(definition)
      },
    })
    signal.addEventListener('abort', abort, { once: true })
    const { agent } = handle
    const events = () => agent.session?.snapshotEvents?.() ?? []
    const repository = source.owner ? `${source.owner}/${source.repo}` : source.repo
    const headings = () => savedWikiHeadings(textDraft.markdown)
    let prompt = `[${skill.name} · SKILL.md]\n${skill.content}\n\n[${skill.name} · references/diagrams.md]\n${skill.guide}`
      + `\n\n代码百科 Markdown 存档模式。仓库 ${repository}，固定提交 ${source.commit}。`
      + '\n仓库工具仅提供读取。Markdown 通过助手普通回复交付，插件保存回复。'
    if (checkpoint) {
      const saved = evidence.map(({ path, start, end, kind }, index) => `${index + 1} ${path}:${start}-${end} (${kind})`).join('\n')
      if (saved) prompt += '\n已读证据索引，可用 wiki_read_saved 按 ID 查看：\n' + saved
      if (headings()) prompt += '\n已保存的标题：\n' + headings()
    }
    let stalled = 0, rejections = 0
    for (let turn = 0; turn < 24; turn++) {
      signal.throwIfAborted()
      const cursor = events().length
      onPhase('writing', { step: stalled ? 'submission-retry' : 'drafting', attempt: stalled + 1, attemptLimit: 3, rejections })
      agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] })
      await agent.whenIdle()
      signal.throwIfAborted()
      let part, markdown
      try {
        part = settledReply(events().slice(cursor))
        markdown = [textDraft.markdown, part.markdown].filter(Boolean).join('\n\n')
        if (markdown.length > maxWikiMarkdownLength) throw wikiInvalid('文档达到长度上限，请提交更短的片段。')
        resolveMarkdownCitations(part.markdown, source, evidence)
      } catch (error) {
        if (error?.code !== 'model-output-invalid' && !recoverable.has(error?.providerCode)) throw error
        if (++stalled >= 3) throw error
        rejections++
        const reason = error.code === 'model-output-invalid' ? error.message : '模型本轮响应未能完整接收。'
        prompt = `上一轮尚未保存。${reason}\n按 Skill 的 Markdown 存档模式继续，提交一个较短的完整片段。已保存标题：\n${headings()}`
        onPhase('writing', { step: 'submission-retry', attempt: stalled + 1, attemptLimit: 3, rejections,
          reasonCategory: 'model-response', retryMessage: reason })
        continue
      }
      const next = { markdown, complete: part.complete }
      const resolved = next.complete ? resolveMarkdownCitations(next.markdown, source, evidence) : undefined
      await save(next)
      textDraft = next
      if (next.complete) return { markdown: resolved, format: 'skill-markdown', files: evidence }
      stalled = 0
      prompt = `已保存这一部分。继续 Skill 的 Markdown 存档模式。已保存标题：\n${headings()}`
    }
    throw wikiInvalid('文档已保存进度，但尚未收到完成标记。')
  } catch (error) {
    if (signal.aborted || ['model-output-invalid', 'model-unavailable', 'wiki-skill-invalid'].includes(error?.code)) throw error
    throw modelError(error)
  } finally {
    signal.removeEventListener('abort', abort)
    try { await handle?.dispose() } finally { disposeAdapter?.() }
  }
}
