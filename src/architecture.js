import { randomUUID } from 'node:crypto'
import { modelError } from './generate-wiki.js'
import { repositoryTools } from './repository-tools.js'
import { normalizeWikiPlan, normalizeWikiChapter, normalizeWikiDraft, restoreWikiDraft, renderWikiDocument, wikiInvalid } from './wiki-document.js'
import { wikiPublicationSchema, wikiResearchInstructions, reviewWikiDraft, wikiSkillPlanSchema, wikiSkillChapterSchema,
  wikiSkillFinishSchema, wikiSkillTransportInstructions } from './wiki-editor.js'

const reviewTimeoutMs = 75_000

export async function exploreArchitecture(ctx, source, selection, adapter, signal, onRead, onPhase = () => {}, { checkpoint, onCheckpoint, loadSkill } = {}) {
  const { definitions, evidence } = repositoryTools(source, signal, onRead, checkpoint?.evidence)
  const provider = adapter ? 'code-wiki-' + randomUUID() : selection.provider
  let disposeAdapter, handle, publication, plan, phase = 'planning', plans = 0
  let lastRejection = '', submissions = 0
  let roundAttempt = 1, rejections = 0, lastRetry
  const progress = (phase, step, details = {}) => onPhase(phase, {
    step, attempt: roundAttempt, attemptLimit: 3, rejections, ...lastRetry, ...details,
  })
  let currentRaw, skill
  const staged = new Map()
  const pending = () => plan?.chapters.filter(chapter => !staged.has(chapter.id)).map(chapter => chapter.id) ?? []
  const chapterStatus = () => pending().length ? '待提交章节：' + pending().join('、') : '所有章节已接受。调用 wiki_finish 完成存档。'
  let checkpointWrites = Promise.resolve(), publicationWrites = Promise.resolve(), lastCheckpoint
  async function saveCheckpoint(draft = currentRaw) {
    if (!plan || !onCheckpoint) return
    const material = structuredClone({ plan, ...(draft !== undefined && { draft }),
      ...((skill || checkpoint?.chapters !== undefined) && { chapters: draft === undefined ? [...staged.values()] : [] }), evidence })
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
      if (plan && phase !== 'reviewing') progress('researching', 'researching', { plan })
      const before = evidence.length
      const result = await execute(...args)
      if (evidence.length !== before) {
        if (skill) await publicationWrites.catch(() => {})
        await saveCheckpoint()
      }
      return result
    }
  }
  const abort = () => handle?.agent.cancel({ kind: 'user' })
  const publish = {
    name: 'wiki_publish', description: 'Submit a research plan, then a complete draft with verified source ranges.',
    parameters: wikiPublicationSchema,
    output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
      render: (_args, result) => [{ type: 'text', text: result.status }] },
    async execute(args) {
      try {
        submissions++
        signal.throwIfAborted()
        if (phase === 'reviewing') throw wikiInvalid('草稿已收到，请停止并等待独立审核。')
        if (args?.kind === 'plan') {
          if (plans >= 3) throw wikiInvalid('研究计划最多修订三次，请按当前计划完成研究。')
          if (staged.size) throw wikiInvalid('已有章节通过校验，请继续现有提纲。' + chapterStatus())
          const next = normalizeWikiPlan(args.plan, source)
          if ((skill || !checkpoint) && !next.walkthrough) throw wikiInvalid('新研究计划需要 walkthrough，填写案例标题和要解释的问题。')
          if ((skill || !checkpoint || plan?.chapters[0].diagrams) && !next.chapters[0].diagrams) {
            throw wikiInvalid('新研究计划需要在每章填写 diagrams，选择一到两张能回答本章设计问题的图。')
          }
          const previousPlan = plan, previousPhase = phase
          plan = { ...next, moduleCases: true }; plans++; phase = 'researching'
          try { await saveCheckpoint() }
          catch (error) { plan = previousPlan; phase = previousPhase; plans--; throw error }
          lastRetry = undefined
          lastRejection = ''
          progress('researching', 'researching', { plan })
          if (skill) return { status: '研究计划已接受。用 wiki_submit_chapter 逐章提交。' + chapterStatus() }
          return { status: '研究计划已接受。读取实际证据后提交 kind=draft，每个核心模块章需要一个 module-case。'
            + (plan.chapters[0].diagrams ? '每章需要 design-note 与计划中的图，架构及模块图要写清接口。' : '') }
        }
        if (skill && args?.kind === 'chapter') {
          if (!plan) throw wikiInvalid('先调用 wiki_submit_plan 提交研究计划。')
          const raw = args.chapter
          const otherIds = [...staged].filter(([id]) => id !== raw?.id).flatMap(([, chapter]) => chapter.blocks.map(block => block.id))
          normalizeWikiChapter(raw, source, evidence, plan, otherIds)
          const chapter = structuredClone(raw)
          const previous = staged.get(chapter.id)
          staged.set(chapter.id, chapter)
          try {
            if (JSON.stringify([...staged.values()]).length > 110_000) throw wikiInvalid('章节正文合计过长，请缩短新增章节。')
            await saveCheckpoint()
          } catch (error) {
            if (previous) staged.set(chapter.id, previous)
            else staged.delete(chapter.id)
            throw error
          }
          lastRetry = undefined
          lastRejection = ''
          progress('writing', 'drafting')
          return { status: '章节已接受并已保存：' + chapter.id + '。' + chapterStatus() }
        }
        let candidate = args?.draft
        if (skill) {
          if (!plan) throw wikiInvalid('先调用 wiki_submit_plan 提交研究计划。')
          if (pending().length) throw wikiInvalid('还有章节待提交。' + chapterStatus())
          candidate = { ...candidate, chapters: plan.chapters.map(chapter => staged.get(chapter.id)) }
        } else if (args?.kind !== 'draft') throw wikiInvalid('wiki_publish 需要 kind=plan 或 kind=draft。')
        progress('writing', 'validating', { plan })
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
        return { status: '草稿已收到。请停止，文档将进入事实与编辑审核。' }
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
  const skillTool = (name, description, parameters, toPublication) => ({
    name, description, parameters, output: publish.output,
    execute(args) {
      const pendingWrite = publicationWrites.catch(() => {}).then(() => publish.execute(toPublication(args)))
      publicationWrites = pendingWrite
      return pendingWrite
    },
  })
  progress('planning', 'planning')
  try {
    const restored = checkpoint && restoreWikiDraft(checkpoint, source, evidence)
    const resumedDraft = restored?.draft
    if (!resumedDraft && loadSkill) skill = await loadSkill()
    if (restored) {
      plan = restored.plan
      currentRaw = restored.raw
      if (skill && !resumedDraft && !plan?.chapters[0].diagrams) plan = undefined
      if (skill && plan && !resumedDraft) for (const chapter of checkpoint.chapters ?? []) {
        try {
          const otherIds = [...staged.values()].flatMap(item => item.blocks.map(block => block.id))
          normalizeWikiChapter(chapter, source, evidence, plan, otherIds)
          staged.set(chapter.id, chapter)
        } catch (error) {
          if (error?.code !== 'model-output-invalid') throw error
        }
      }
      phase = resumedDraft ? 'reviewing' : plan ? 'researching' : 'planning'
      plans = plan ? 1 : 0
      if (plan) await saveCheckpoint()
      progress(phase, phase)
      onRead?.(new Set(evidence.map(item => item.path)).size, evidence.at(-1)?.path)
    }
    async function draftRound(prompt) {
      const publicationTools = skill ? [
        skillTool('wiki_submit_plan', 'Submit the research questions, modules, section order and planned diagrams.', wikiSkillPlanSchema, plan => ({ kind: 'plan', plan })),
        skillTool('wiki_submit_chapter', 'Validate and save one chapter. Submit only the chapter being written or repaired.', wikiSkillChapterSchema, chapter => ({ kind: 'chapter', chapter })),
        skillTool('wiki_finish', 'After all chapters are accepted, submit research coverage, the navigation graph and walkthrough to save the Wiki.', wikiSkillFinishSchema, draft => ({ kind: 'finish', draft })),
      ] : [publish]
      if (adapter) disposeAdapter = ctx.llm.registerAdapter([provider], adapter)
      handle = await ctx.agents.create({
        sessionId: 'code-wiki-' + randomUUID(), agentOptions: { ...selection, provider, maxTokens: 24_000 }, signal,
        setup(agentCtx) {
          agentCtx.tools.restrict({ allow: [] })
          for (const definition of [...definitions, ...publicationTools]) agentCtx.tools.register(definition)
        },
      })
      signal.addEventListener('abort', abort, { once: true })
      signal.throwIfAborted()
      const { agent } = handle
      let previousCount = staged.size + Number(Boolean(plan)), stalled = 0
      for (let attempt = 0; attempt < (skill ? 12 : 3); attempt++) {
        roundAttempt = skill ? stalled + 1 : attempt + 1
        if (lastRetry) progress('writing', 'submission-retry', { plan })
        else progress(plan ? 'writing' : 'planning', plan ? 'drafting' : 'planning', { plan })
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
        const detail = lastRejection || (skill ? '尚未完成分章提交。' : submissions
          ? '尚未收到完整、有效的 kind=draft 提交。' : '研究代理结束前没有调用 wiki_publish。')
        lastRetry = { reasonCategory: lastRejection ? 'validation' : 'missing-publication', retryMessage: detail }
        progress('writing', 'submission-retry', { plan })
        const completed = staged.size + Number(Boolean(plan))
        stalled = completed > previousCount ? 0 : stalled + 1
        previousCount = completed
        if (stalled >= 3 || attempt === (skill ? 11 : 2)) throw wikiInvalid((skill ? '研究代理未能完成有效草稿：'
          : '研究代理三次尝试后尚未提交有效草稿：') + detail.slice(0, 900)
          + (reason === 'max-tokens' ? '模型输出达到长度上限。' : '') + (skill ? '' : '本次没有保存不完整文档。'))
        if (skill) {
          prompt = (plan ? chapterStatus() : '调用 wiki_submit_plan 先提交研究计划。') + '\n最近校验反馈：' + detail
            + '\n已被接受的章节仍有效。每次只提交一章，先修正出错的字段或提交下一章。所有章通过后调用 wiki_finish。'
          continue
        }
        prompt = '研究尚未完成，也没有保存任何文档。继续当前任务，必须调用 wiki_publish(kind=draft) 提交有效草稿，不能只在聊天中回复。'
          + (plan ? '已接受研究计划，不需要重复提交计划。' : '先提交 kind=plan 的有效计划。')
          + '\n最近校验反馈：' + detail + '\n复用已读取的证据，按工具 schema 提交简洁完整的草稿。'
          + '只补读确实缺少的实现证据。'
          + (reason === 'max-tokens' ? '\n上次输出达到长度上限，请缩短各段，保留主要论述、所选视图及引用，重新提交完整 JSON。' : '')
      }
    }
    const repository = source.owner ? `${source.owner}/${source.repo}` : source.repo
    const researchPrompt = checkpoint && !resumedDraft
      ? '\n已恢复同一提交的已读证据，证据编号保持不变。以下原文可以直接引用，只补读确实缺少的依据。'
        + (skill ? (plan ? '\n' + chapterStatus() : '\n请参考旧计划，调用 wiki_submit_plan 提交新提纲。') + '\n'
          : (plan ? '研究计划已被接受，尚无可用草稿。' : '旧研究计划与当前格式不兼容，请参考旧计划并先用 kind=plan 提交新的计划。')
            + '然后调用 wiki_publish(kind=draft) 提交新草稿。\n')
        + JSON.stringify({ repository, commit: source.commit, ...(plan ? { plan } : { previousPlan: checkpoint.plan }),
          evidence: evidence.map((file, index) => ({ id: index + 1, ...file })) })
      : '\n先列目录并读取项目介绍。优先批量读取和有目标的搜索，覆盖主要架构问题后及时提交草稿。'
    const instructions = skill
      ? `[${skill.name} · SKILL.md]\n${skill.content}\n\n[${skill.name} · references/diagrams.md]\n${skill.guide}\n\n${wikiSkillTransportInstructions}`
      : wikiResearchInstructions
    const draft = resumedDraft ?? await draftRound(instructions + '\n\n仓库：' + repository + '\n固定提交：' + source.commit + researchPrompt)
    const rendered = renderWikiDocument(draft, source)
    progress('reviewing', 'reviewing', { plan, attempt: 1, attemptLimit: 2 })
    const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(reviewTimeoutMs)])
    const interrupted = Promise.withResolvers()
    const stopReview = () => interrupted.resolve(undefined)
    reviewSignal.addEventListener('abort', stopReview, { once: true })
    if (reviewSignal.aborted) stopReview()
    let verdict
    try {
      const inspection = reviewWikiDraft(adapter ?? ctx.llm, { ...selection, provider }, draft, plan, evidence, source, reviewSignal,
        details => {
          if (reviewSignal.aborted) return
          rejections++
          progress('reviewing', 'submission-retry', { reasonCategory: 'validation', ...details })
        })
      verdict = await Promise.race([inspection, interrupted.promise])
    } catch {
      // A structurally valid draft is ready to save even if the model review could not finish.
    } finally {
      reviewSignal.removeEventListener('abort', stopReview)
    }
    signal.throwIfAborted()
    const review = verdict === undefined ? { status: 'unavailable' } : verdict.approved
      ? { status: 'approved' } : { status: 'findings', issues: verdict.issues.map(({ reviewer, reason }) => ({ reviewer, reason })) }
    return { ...rendered, review, files: [...evidence] }
  } catch (error) {
    // Retain completed research even when a pending model request is cancelled or times out.
    try { await saveCheckpoint() } catch { /* Preserve the original generation failure. */ }
    if (signal.aborted || ['model-output-invalid', 'model-unavailable', 'wiki-skill-invalid'].includes(error?.code)) throw error
    throw modelError(error)
  } finally {
    signal.removeEventListener('abort', abort)
    try { await handle?.dispose() } finally { disposeAdapter?.() }
  }
}
