import { randomUUID } from 'node:crypto'
import { modelError } from './generate-wiki.js'
import { repositoryTools } from './repository-tools.js'
import { normalizeWikiPlan, normalizeWikiDraft, renderWikiDocument, reviseWikiDraft, wikiReviewMaterial, wikiInvalid } from './wiki-document.js'
import { wikiPublicationSchema, wikiResearchInstructions, reviewWikiDraft } from './wiki-editor.js'

export async function exploreArchitecture(ctx, source, selection, adapter, signal, onRead, onPhase = () => {}, { checkpoint, onCheckpoint } = {}) {
  const { definitions, evidence } = repositoryTools(source, signal, onRead, checkpoint?.evidence)
  const provider = adapter ? 'code-wiki-' + randomUUID() : selection.provider
  let disposeAdapter, handle, publication, plan, phase = 'planning', plans = 0
  let lastRejection = '', submissions = 0
  let repair = 0, roundAttempt = 1, rejections = 0, lastRetry
  const progress = (phase, step, details = {}) => onPhase(phase, {
    step, repair, attempt: roundAttempt, attemptLimit: 3, rejections, ...lastRetry, ...details,
  })
  let currentRaw = checkpoint?.draft
  let checkpointWrites = Promise.resolve(), lastCheckpoint
  async function saveCheckpoint(draft = currentRaw) {
    if (!plan || !onCheckpoint) return
    const material = structuredClone({ plan, ...(draft !== undefined && { draft }), evidence })
    const serialized = JSON.stringify(material)
    if (serialized === lastCheckpoint) return checkpointWrites
    lastCheckpoint = serialized
    const writing = checkpointWrites.catch(() => {}).then(() => onCheckpoint(material))
    checkpointWrites = writing
    try { await writing }
    catch (error) {
      if (lastCheckpoint === serialized) lastCheckpoint = undefined
      throw error
    }
  }
  for (const definition of definitions) {
    const execute = definition.execute
    definition.execute = async (...args) => {
      if (plan && phase !== 'reviewing') progress('researching', repair ? 'review-reading' : 'researching', { plan })
      const before = evidence.length
      const result = await execute(...args)
      if (evidence.length !== before) await saveCheckpoint()
      return result
    }
  }
  const abort = () => handle?.agent.cancel({ kind: 'user' })
  const publish = {
    name: 'wiki_publish', description: 'Submit a research plan first, then a draft. A draft is reviewed independently before it can become the published Wiki.',
    parameters: wikiPublicationSchema,
    output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
      render: (_args, result) => [{ type: 'text', text: result.status }] },
    async execute(args) {
      try {
        submissions++
        signal.throwIfAborted()
        if (phase === 'reviewing') throw wikiInvalid('草稿已收到，请停止并等待独立审核。')
        if (args?.kind === 'plan') {
          if (currentRaw !== undefined) throw wikiInvalid('已有草稿后保留已接受的研究计划，请按审核意见定向修订草稿。')
          if (plans >= 3) throw wikiInvalid('研究计划最多修订三次，请按当前计划完成研究。')
          const next = normalizeWikiPlan(args.plan, source)
          plan = next; plans++; phase = 'researching'
          await saveCheckpoint()
          lastRetry = undefined
          lastRejection = ''
          progress('researching', 'researching', { plan })
          return { status: '研究计划已接受。现在按领域读取实际证据，完成覆盖记录后提交 kind=draft；这还不是最终发布。' }
        }
        if (!['draft', 'revise'].includes(args?.kind)) throw wikiInvalid('wiki_publish 需要 kind=plan、kind=draft 或 kind=revise。')
        // A shared tool schema can produce unused payloads; only the selected kind participates.
        progress('writing', 'validating', { plan })
        const candidate = args.kind === 'revise' ? reviseWikiDraft(currentRaw, args.revisions) : args.draft
        const draft = normalizeWikiDraft(candidate, source, evidence, plan)
        const previousRaw = currentRaw, previousPhase = phase
        currentRaw = structuredClone(candidate)
        phase = 'reviewing'
        try { await saveCheckpoint() }
        catch (error) { currentRaw = previousRaw; phase = previousPhase; throw error }
        lastRetry = undefined
        lastRejection = ''
        progress('writing', 'agent-finishing', { plan })
        publication.draft = draft
        publication.resolve(draft)
        return { status: '草稿已收到。请停止并等待事实审核与编辑审核，不要宣称文档已经发布。' }
      } catch (error) {
        if (signal.aborted) throw error
        lastRejection = error.code === 'model-output-invalid' ? error.message : '请检查字段类型和已读取的证据。'
        rejections++
        lastRetry = { reasonCategory: 'validation', retryMessage: lastRejection }
        progress('writing', 'submission-retry', { plan })
        return { status: '提交未通过。' + lastRejection }
      }
    },
  }
  progress('planning', 'planning')
  try {
    let resumedDraft
    if (checkpoint) {
      plan = normalizeWikiPlan(checkpoint.plan, source)
      if (checkpoint.draft !== undefined) resumedDraft = normalizeWikiDraft(checkpoint.draft, source, evidence, plan)
      phase = resumedDraft ? 'reviewing' : 'researching'; plans = 1
      await saveCheckpoint()
      progress(phase, resumedDraft ? 'reviewing' : 'researching')
      onRead?.(new Set(evidence.map(item => item.path)).size, evidence.at(-1)?.path)
    }
    if (adapter) disposeAdapter = ctx.llm.registerAdapter([provider], adapter)
    handle = await ctx.agents.create({
      sessionId: 'code-wiki-' + randomUUID(), agentOptions: { ...selection, provider, maxTokens: 20_000 }, signal,
      setup(agentCtx) {
        agentCtx.tools.restrict({ allow: [] })
        for (const definition of [...definitions, publish]) agentCtx.tools.register(definition)
      },
    })
    signal.addEventListener('abort', abort, { once: true })
    signal.throwIfAborted()
    const { agent } = handle
    async function draftRound(prompt) {
      const requestedKind = currentRaw === undefined ? 'draft' : 'revise'
      for (let attempt = 0; attempt < 3; attempt++) {
        roundAttempt = attempt + 1
        if (lastRetry) progress('writing', 'submission-retry', { plan })
        else progress(plan ? 'writing' : 'planning', plan ? repair ? 'revising' : 'drafting' : 'planning',
          { plan, ...(repair && { reasonCategory: 'review' }) })
        publication = Promise.withResolvers()
        agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] })
        await Promise.race([publication.promise, agent.whenIdle()])
        signal.throwIfAborted()
        await agent.whenIdle()
        signal.throwIfAborted()
        if (publication.draft) return publication.draft
        const turn = agent.session?.snapshotEvents?.().findLast(event => event.type === 'turn/end')
        const failure = turn?.data?.reason?.error ?? turn?.data?.reason?.failure
        if (failure) {
          const wrapped = failure.code === 'UNKNOWN' ? modelError({ code: failure.message }) : null
          throw wrapped?.providerCode ? wrapped : modelError(failure)
        }
        const reason = turn?.data?.reason?.kind
        const detail = lastRejection || (submissions ? `尚未收到完整、有效的 kind=${requestedKind} 提交。` : '研究代理结束前没有调用 wiki_publish。')
        lastRetry = { reasonCategory: lastRejection ? 'validation' : 'missing-publication', retryMessage: detail }
        progress('writing', 'submission-retry', { plan })
        if (attempt === 2) throw wikiInvalid('研究代理三次尝试后尚未提交有效草稿：' + detail.slice(0, 900)
          + (reason === 'max-tokens' ? '模型输出达到长度上限。' : '') + '本次没有保存不完整文档。')
        prompt = `研究尚未完成，也没有保存任何文档。继续当前任务，必须调用 wiki_publish(kind=${requestedKind}) 提交有效${requestedKind === 'revise' ? '定向修订' : '草稿'}，不能只在聊天中回复。`
          + (plan ? '已接受研究计划，不需要重复提交计划。' : '先提交 kind=plan 的有效计划。')
          + '\n最近校验反馈：' + detail + '\n复用已读取的证据，按工具 schema '
          + (requestedKind === 'revise' ? '仅提交 revisions 中必要的改动，不重新输出整篇草稿。' : '精简完整草稿。')
          + '只补读确实缺少的实现证据。'
          + (reason === 'max-tokens' ? requestedKind === 'revise'
            ? '\n上次输出达到长度上限，请精简必要改动并保留所需引用，重新提交完整 revisions JSON。'
            : '\n上次输出达到长度上限，请缩短各段，保留主要论述、所选视图及引用，重新提交完整 JSON。' : '')
      }
    }
    const repository = source.owner ? `${source.owner}/${source.repo}` : source.repo
    const researchPrompt = checkpoint && !resumedDraft
      ? '\n已恢复同一提交的研究计划和已读证据，plan已被接受，但尚无草稿。证据编号保持不变，以下原文可以直接引用，不要重复读取。只补读确实缺少的依据，然后调用 wiki_publish(kind=draft) 提交新草稿，不能用 kind=revise。草稿仍须通过完整结构检查、事实审核与编辑审核才能发布。\n'
        + JSON.stringify({ repository, commit: source.commit, plan,
          evidence: evidence.map((file, index) => ({ id: index + 1, ...file })) })
      : '\n先列目录并读取项目介绍。工具请求预算有限，优先批量读取和有目标的搜索；通常在40轮模型请求内提交初稿，预留后续审核修订所需请求。覆盖主要架构问题后及时写作，不穷举整个代码仓。'
    let draft = resumedDraft ?? await draftRound(wikiResearchInstructions + '\n\n仓库：' + repository + '\n固定提交：' + source.commit + researchPrompt)
    for (let reviewRound = 0; reviewRound <= 2; reviewRound++) {
      repair = reviewRound
      roundAttempt = 1
      progress('reviewing', 'reviewing', { plan, draft, attemptLimit: 2 })
      const review = await reviewWikiDraft(adapter ?? ctx.llm, { ...selection, provider }, draft, plan, evidence, source, signal,
        details => {
          rejections++
          lastRetry = { reasonCategory: 'validation', retryMessage: details.retryMessage }
          progress('reviewing', 'submission-retry', details)
        })
      lastRetry = undefined
      if (review.approved) return { ...renderWikiDocument(draft, source), files: [...evidence] }
      if (repair === 2) throw wikiInvalid('Wiki 经过两次定向修订仍未通过独立审核：' + review.issues.map(issue => issue.reason).join('；').slice(0, 1200))
      const requests = [...new Map(review.issues.flatMap(issue => issue.reads).map(read => [`${read.path}:${read.start}:${read.count}`, read])).values()]
      const additionalEvidence = []
      repair = reviewRound + 1
      roundAttempt = 1
      if (requests.length) {
        progress('researching', 'review-reading', { plan, reasonCategory: 'review' })
        const read = definitions.find(tool => tool.name === 'wiki_read')
        for (const request of requests) {
          signal.throwIfAborted()
          const result = JSON.parse((await read.execute(request, { signal })).data)
          if (result.error || !result.evidence || result.rangeTruncated) throw wikiInvalid('审核要求的补读未完成：' + request.path + '，'
            + (result.error || (result.rangeTruncated ? '所需范围超过读取预算，请缩小补读范围' : '没有返回证据')) + '。未发布草稿。')
          additionalEvidence.push(result)
        }
      }
      phase = 'writing'
      progress('writing', 'revising', { plan, reasonCategory: 'review' })
      let recoveryContext = ''
      if (resumedDraft && reviewRound === 0) {
        const targets = new Set(review.issues.map(issue => issue.target))
        const objects = [
          ...draft.chapters.flatMap(chapter => chapter.blocks.map(block => [block.id, block])),
          ...draft.graph.layers.flatMap(layer => layer.nodes.map(node => ['node:' + node.id, node])),
          ...draft.graph.edges.map(edge => [`edge:${edge.from}:${edge.to}`, edge]),
        ].filter(([target]) => targets.has(target)).map(([, value]) => value)
        const ranges = new Set(objects.flatMap(value => [...value.refs, ...(value.items?.flatMap(item => item.refs) ?? []),
          ...(value.nodes?.flatMap(node => node.refs) ?? []), ...(value.edges?.flatMap(edge => edge.refs) ?? [])])
          .map(ref => `${ref.evidence}:${ref.start}:${ref.end}`))
        const reviewMaterial = wikiReviewMaterial(draft, plan, evidence)
        recoveryContext = wikiResearchInstructions + '\n此前研究已完成，plan已被接受，以下是同一提交的当前草稿、完整证据目录及被审核问题直接引用的原文。仅修订审核问题；未展示全文的证据可按目录中的真实路径补读，不必重复研究。证据目录id与工具evidence编号一致。\n'
          + JSON.stringify({ repository, commit: source.commit, plan, draft: currentRaw,
            evidence: checkpoint.evidence.map((item, index) => ({ id: index + 1, path: item.path, start: item.start, end: item.end, primary: item.primary, kind: item.kind })),
            citationInstructions: reviewMaterial.citationInstructions,
            excerpts: reviewMaterial.excerpts.filter(ref => (ref.citations ?? [ref])
              .some(citation => ranges.has(`${citation.id}:${citation.start}:${citation.end}`))) }) + '\n'
      }
      draft = await draftRound('独立审核要求定向修订，尚未发布。保留未受影响的章节，只修正列出的问题。调用 wiki_publish(kind=revise) 仅提交改动，不重新输出整篇草稿。'
        + 'revisions.blocks 使用 chapter、action(replace|insert_after|delete)、target(原正文块id)及新增/替换的完整block；replace保留原id。需要时可整体更新revisions.graph或coverage。合并后仍会完整验证并重新审核。补读材料已实际读取，可继续有针对性地查证。\n'
        + recoveryContext
        + JSON.stringify({ corrections: review.issues, additionalEvidence }))
    }
  } catch (error) {
    // Retain completed research even when a pending model request is cancelled or times out.
    try { await saveCheckpoint() } catch { /* Preserve the original generation failure. */ }
    if (signal.aborted || ['model-output-invalid', 'model-unavailable'].includes(error?.code)) throw error
    throw modelError(error)
  } finally {
    signal.removeEventListener('abort', abort)
    try { await handle?.dispose() } finally { disposeAdapter?.() }
  }
}
