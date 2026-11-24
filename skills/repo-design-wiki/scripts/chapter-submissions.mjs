import { chapterFigureSlots, isFigureSlot } from './chapter-figures.mjs'
import { readDiagram } from './diagram-spec.mjs'
import { renderWikiDiagram } from './render-wiki-diagram.mjs'
import { readSources, singleLine, tool } from './wiki-generation.mjs'
import { normalizeWikiCitations, readWikiMarkdown, rewriteWikiCitations } from './wiki-markdown.mjs'

export function invalidChapter(message) {
  return Object.assign(new Error(message), { code: 'wiki-chapter-invalid' })
}

function sourceKey({ path, line }) {
  return path + '\0' + line
}

function stageSources(current, resolveReference, citationError) {
  const sources = [...current]
  const numbers = new Map(current.map((source, index) => [sourceKey(source), index + 1]))
  function numberFor(reference) {
    const source = resolveReference(reference)
    if (!source) {
      const error = invalidChapter('引用须使用本次 wiki_read 返回的 handle 和范围内的行号，例如 r1:9。')
      error.citationErrors = [citationError?.(reference) ?? { reference, reason: error.message }]
      throw error
    }
    const key = sourceKey(source)
    if (!numbers.has(key)) {
      sources.push(source)
      numbers.set(key, sources.length)
    }
    return numbers.get(key)
  }
  return { sources, numberFor }
}

function readBody(input, numberFor) {
  const { markdown, tree } = readWikiMarkdown(input?.markdown, invalidChapter, {
    label: '正文',
    proseError: '正文需要可阅读的文字来回答本章问题。请提交完整正文。',
    diagramError: '正文只用文字或代码说明，图请单独交给 wiki_submit_diagram。',
  })
  const figureSlots = chapterFigureSlots(markdown, tree).map(({ slot }) => slot)
  if (!figureSlots.length) {
    throw invalidChapter('正文至少需要一个图位。请在首次说明配图的段落后，用前后留空行的独立段落写 [[figure:1]]。')
  }
  if (figureSlots.some((slot, index) => slot !== index + 1)) {
    throw invalidChapter('正文图位须从 [[figure:1]] 开始连续编号，每个图位独占一行，前后留空行。')
  }
  const handoff = singleLine(input.handoff)
  if (!handoff || !handoff.isWellFormed()) throw invalidChapter('handoff 须为一句单行文字，说明本章产生或交出的结果。')
  let citations = 0
  const citationErrors = new Map()
  const marked = rewriteWikiCitations(markdown, tree, (reference, original) => {
    try {
      const number = numberFor(reference)
      citations += 1
      return '【' + number + '】'
    } catch (error) {
      if (!error?.citationErrors) throw error
      citationErrors.set(reference, error.citationErrors[0])
      return original
    }
  })
  if (citationErrors.size) {
    const error = invalidChapter(`正文有 ${citationErrors.size} 处不同的无效源码引用，请根据 citationErrors 更正。`)
    error.citationErrors = [...citationErrors.values()]
    throw error
  }
  if (!citations) throw invalidChapter('正文至少需要一处源码引用。用【r1:9】标注结论来自哪次读取和哪一行。')
  return { markdown: normalizeWikiCitations(marked), handoff, figureSlots }
}

function prepareDiagram(input, { sources, numberFor }, repository) {
  const field = input?.kind === 'sequence' ? 'messages' : input?.kind === 'er' ? 'relations' : 'edges'
  const links = input?.[field]
  const normalized = Array.isArray(links)
    ? { ...input, [field]: links.map(link => ({ ...link, source: numberFor(link?.source) })) }
    : input
  const diagram = readDiagram(normalized, sources.length, invalidChapter)
  try {
    return renderWikiDiagram(diagram, sources, repository)
  } catch {
    throw invalidChapter('无法绘制这张图。请缩短标签、减少节点与关系，再单独提交这张图。')
  }
}

export function createChapterSubmissions({ repository, signal, evidence, sourceFor, citationError, onEvent, diagnostic }) {
  const unresolvedDiagrams = new Map()
  let content
  let bodyError
  let bodySources = []
  let figureSlots = []

  function validateBody(input, resolveReference = sourceFor) {
    signal?.throwIfAborted()
    const { sources, numberFor } = stageSources([], resolveReference, citationError)
    try {
      return { body: readBody(input, numberFor), sources }
    } catch (error) {
      if (error?.code !== 'wiki-chapter-invalid') throw error
      return { error: error.message, ...(error.citationErrors && { citationErrors: error.citationErrors }) }
    }
  }

  function checkBody(input) {
    const { body, ...failure } = validateBody(input)
    return body ? { valid: true, figureSlots: body.figureSlots } : { valid: false, ...failure }
  }

  function submitBody(input, resolveReference = sourceFor) {
    const { body, sources, ...failure } = validateBody(input, resolveReference)
    if (!body) {
      bodyError = failure.error
      diagnostic({ phase: 'body', status: 'rejected', message: bodyError })
      return { accepted: false, ...failure }
    }
    bodyError = undefined
    const { markdown, handoff } = body
    if (content?.markdown === markdown && content.handoff === handoff && bodySources.length === sources.length
      && sources.every(({ path, line }, index) => bodySources[index].path === path && bodySources[index].line === line)) {
      return { accepted: true, message: '这份正文已提交。', figureSlots }
    }
    const revised = Boolean(content)
    bodySources = sources
    figureSlots = body.figureSlots
    unresolvedDiagrams.clear()
    content = { markdown, handoff, sources, diagrams: [] }
    onEvent({ type: 'body', content })
    diagnostic({ phase: 'body', status: 'accepted', sourceCount: sources.length, ...(revised && { revised }) })
    const message = revised ? '已更新正文和图位。' : '正文已通过核对。'
    return { accepted: true, message: message + '依当前图位分别提交图，diagram.slot 填图位编号。', figureSlots }
  }

  function submitDiagram(input, resolveReference = sourceFor) {
    signal?.throwIfAborted()
    if (!content) return { accepted: false, error: '请先调用 wiki_submit_chapter 并确认正文已被接受，再提交图。' }
    const slot = input?.slot
    if (!isFigureSlot(slot) || !figureSlots.includes(slot)) {
      const error = 'diagram.slot 须填写正文中声明的图位编号。'
      diagnostic({ phase: 'diagram', status: 'rejected', message: error })
      return { accepted: false, error }
    }
    if (content.diagrams.some(existing => existing.slot === slot)) {
      return { accepted: true, message: `图 ${slot} 已通过核对，无需重复提交。` }
    }
    const stage = stageSources(content.sources, resolveReference, citationError)
    let diagram
    try {
      diagram = { ...prepareDiagram(input, stage, repository), slot }
    } catch (error) {
      if (error?.code !== 'wiki-chapter-invalid') throw error
      unresolvedDiagrams.delete(slot)
      unresolvedDiagrams.set(slot, error.message)
      diagnostic({ phase: 'diagram', status: 'rejected', message: error.message })
      return { accepted: false, error: error.message, ...(error.citationErrors && { citationErrors: error.citationErrors }) }
    }
    unresolvedDiagrams.delete(slot)
    const { sources } = stage
    content = { ...content, sources, diagrams: [...content.diagrams, diagram] }
    onEvent({ type: 'diagram', diagram, sources })
    diagnostic({ phase: 'diagram', status: 'accepted', diagramCount: content.diagrams.length, sourceCount: sources.length })
    return { accepted: true, message: '图已通过核对并加入章节。' }
  }

  function submitLegacy(result) {
    const legacySources = result.sources
    const resolveReference = Array.isArray(legacySources)
      ? reference => {
        if (typeof reference !== 'number' && typeof reference !== 'string') return null
        if (!/^[1-9]\d*$/.test(String(reference))) return sourceFor(reference)
        return readSources([legacySources[Number(reference) - 1]], evidence)?.[0]
      }
      : sourceFor
    if (!submitBody(result, resolveReference).accepted) return
    diagnostic({ phase: 'legacy', status: 'accepted' })
    if (result.diagrams === undefined) return
    if (!Array.isArray(result.diagrams)) {
      unresolvedDiagrams.set(1, '图须作为 diagrams 数组提交，每个数组元素是一张图。')
      return
    }
    for (const diagram of result.diagrams) submitDiagram(diagram, resolveReference)
  }

  const string = { type: 'string' }
  return {
    tools: [
      tool('wiki_check_chapter',
        '检查完整正文的 Markdown、引用、handoff 和图位，返回需要更正的引用及已读范围。此检查不会提交或保存正文。',
        { markdown: string, handoff: string }, ['markdown', 'handoff'], checkBody),
      tool('wiki_submit_chapter',
        '提交完整正文供读者阅读。正文含 【r1:9】 形式的源码引用，并声明至少一个图位 [[figure:1]]。handoff 用一句话说明本章结果。修订正文后按新的图位提交图。草稿和引用验证请用 wiki_check_chapter。',
        { markdown: string, handoff: string }, ['markdown', 'handoff'], args => submitBody(args)),
      tool('wiki_submit_diagram',
        '在正文已接受后提交一张图。diagram.slot 填正文中声明的图位编号，其他字段按图型规则填写。每条关系的 source 用字符串 r1:9 引用实际读取的位置。',
        { diagram: { type: 'object' } }, ['diagram'], ({ diagram }) => submitDiagram(diagram)),
    ],
    submitLegacy,
    get content() { return content },
    get bodyError() { return bodyError },
    get diagramError() {
      const missing = figureSlots.filter(slot => !content.diagrams.some(diagram => diagram.slot === slot))
      const reason = [...unresolvedDiagrams.values()].at(-1)
      return missing.length ? `${missing.map(slot => `图 ${slot}`).join('、')} 尚未生成。${reason ?? ''}` : undefined
    },
  }
}
