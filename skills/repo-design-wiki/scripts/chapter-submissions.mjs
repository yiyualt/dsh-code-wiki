import { fromMarkdown } from 'mdast-util-from-markdown'
import { chapterFigureSlots, isFigureSlot, replaceChapterText } from './chapter-figures.mjs'
import { readDiagram } from './diagram-spec.mjs'
import { renderEntityDiagram } from './render-entity-diagram.mjs'
import { renderGraphDiagram } from './render-graph-diagram.mjs'
import { renderSequenceDiagram } from './render-sequence-diagram.mjs'
import { readSources, singleLine, tool } from './wiki-generation.mjs'

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

function embeddedDiagram(node) {
  return node.type === 'image' || node.type === 'imageReference'
    || (node.type === 'code' && /^(?:mermaid|graphviz|dot|plantuml)$/i.test(node.lang ?? ''))
    || node.children?.some(embeddedDiagram)
}

const placeholderText = [
  /^(?:本章|章节)(?:已|已经)?(?:生成|完成)(?:完成|成功|完毕)?$/u,
  /^(?:探针(?:验证|检查|测试|调试|核对|提交|成功|通过)?|(?:测试|验证|检查|调试|核对)引用(?:有效|正确|可用|成功|通过)?|引用(?:测试|验证|检查|调试|核对)(?:成功|通过)?)$/u,
  /^(?:待生成|待补充|正文待补充|暂无内容|占位(?:文字|文本)?|todo|placeholder|probe|(?:citation|reference)(?:test|check|probe)|(?:test|check|probe)(?:citation|reference))$/iu,
]
const probeLabel = /^\s*(?:探针|(?:测试|验证|检查|调试|核对)(?:源码)?引用|引用(?:测试|验证|检查|调试|核对)|(?:citation|reference)\s+(?:test|check|probe))\s*[:：]/iu

function paragraphText(node) {
  if (node.type === 'text') return node.value
  if (node.type === 'break') return '\n'
  return node.children?.map(paragraphText).join('') ?? ''
}

function hasBodyProse(node) {
  if (node.type !== 'paragraph') return node.children?.some(hasBodyProse) ?? false
  const prose = paragraphText(node).replace(/【[^】]*】|\[\[figure:-?\d+\]\]/gu, '')
  return prose.split(/\r?\n/u).some(line => {
    if (/^\s*\|.*\|\s*$/u.test(line)) return false
    return line.split(/[。！？!?]+|\.(?:\s+|$)/u).some(sentence => {
      if (probeLabel.test(sentence)) return false
      const words = sentence.replace(/[^\p{L}\p{N}]+/gu, '')
      return Boolean(words) && !placeholderText.some(pattern => pattern.test(words))
    })
  })
}

function readBody(input, numberFor) {
  const markdown = typeof input?.markdown === 'string' ? input.markdown.trim() : ''
  if (!markdown || !markdown.isWellFormed()) throw invalidChapter('正文须为有效的非空 Markdown。')
  const tree = fromMarkdown(markdown)
  if (embeddedDiagram(tree)) {
    throw invalidChapter('正文只用文字或代码说明，图请单独交给 wiki_submit_diagram。')
  }
  if (!hasBodyProse(tree)) throw invalidChapter('正文需要可阅读的文字来回答本章问题。请提交完整正文。')
  const figureSlots = chapterFigureSlots(markdown, tree).map(({ slot }) => slot)
  if (figureSlots.some((slot, index) => slot !== index + 1)) {
    throw invalidChapter('正文图位须从 [[figure:1]] 开始连续编号，每个图位独占一行，前后留空行。')
  }
  const handoff = singleLine(input.handoff)
  if (!handoff || !handoff.isWellFormed()) throw invalidChapter('handoff 须为一句单行文字，说明本章产生或交出的结果。')
  let citations = 0
  const citationErrors = new Map()
  const marked = replaceChapterText(markdown, text => text.replace(/【([^】]*)】/gu, (original, value) => {
    const reference = value.trim()
    if (!/^(?:[\d０-９]+|r[\d０-９]+|r[^\s:：]*\s*[:：][^\r\n]*)$/iu.test(reference)) return original
    try {
      const number = numberFor(reference)
      citations += 1
      return '【' + number + '】'
    } catch (error) {
      if (!error?.citationErrors) throw error
      citationErrors.set(reference, error.citationErrors[0])
      return original
    }
  }), tree)
  if (citationErrors.size) {
    const error = invalidChapter(`正文有 ${citationErrors.size} 处不同的无效源码引用，请根据 citationErrors 更正。`)
    error.citationErrors = [...citationErrors.values()]
    throw error
  }
  if (!citations) throw invalidChapter('正文至少需要一处源码引用。用【r1:9】标注结论来自哪次读取和哪一行。')
  return { markdown: marked, handoff, figureSlots }
}

function renderDiagram(diagram, sources, repository) {
  function sourceAt(number) {
    const { path, line } = sources[number - 1]
    const position = path + ':' + line
    if (!repository.webUrl) return { position }
    const filePath = path.split('/').map(encodeURIComponent).join('/')
    const url = repository.webUrl + '/blob/' + repository.commit + '/' + filePath + '#L' + line
    return { position, url }
  }
  if (diagram.kind === 'sequence') return renderSequenceDiagram(diagram, sourceAt)
  if (diagram.kind === 'er') return renderEntityDiagram(diagram, sourceAt)
  return renderGraphDiagram(diagram, sourceAt)
}

function prepareDiagram(input, { sources, numberFor }, repository) {
  const field = input?.kind === 'sequence' ? 'messages' : input?.kind === 'er' ? 'relations' : 'edges'
  const links = input?.[field]
  const normalized = Array.isArray(links)
    ? { ...input, [field]: links.map(link => ({ ...link, source: numberFor(link?.source) })) }
    : input
  const diagram = readDiagram(normalized, sources.length, invalidChapter)
  try {
    return renderDiagram(diagram, sources, repository)
  } catch {
    throw invalidChapter('无法绘制这张图。请缩短标签、减少节点与关系，再单独提交这张图。')
  }
}

function diagramKey(diagram) {
  return JSON.stringify([singleLine(diagram?.kind, 32), singleLine(diagram?.title, 100)])
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
    return { accepted: true, message: message + (figureSlots.length
      ? '依当前图位分别提交图，diagram.slot 填图位编号。' : ''), figureSlots }
  }

  function submitDiagram(input, resolveReference = sourceFor) {
    signal?.throwIfAborted()
    if (!content) return { accepted: false, error: '请先调用 wiki_submit_chapter 并确认正文已被接受，再提交图。' }
    const slot = input?.slot
    if (slot !== undefined ? !isFigureSlot(slot) || !figureSlots.includes(slot) : figureSlots.length > 0) {
      const error = 'diagram.slot 须填写正文中声明的图位编号。'
      diagnostic({ phase: 'diagram', status: 'rejected', message: error })
      return { accepted: false, error }
    }
    if (slot !== undefined && content.diagrams.some(existing => existing.slot === slot)) {
      return { accepted: true, message: `图 ${slot} 已通过核对，无需重复提交。` }
    }
    const key = slot ?? diagramKey(input)
    const stage = stageSources(content.sources, resolveReference, citationError)
    let diagram
    try {
      diagram = prepareDiagram(input, stage, repository)
      if (slot !== undefined) diagram = { ...diagram, slot }
    } catch (error) {
      if (error?.code !== 'wiki-chapter-invalid') throw error
      unresolvedDiagrams.delete(key)
      unresolvedDiagrams.set(key, error.message)
      diagnostic({ phase: 'diagram', status: 'rejected', message: error.message })
      return { accepted: false, error: error.message, ...(error.citationErrors && { citationErrors: error.citationErrors }) }
    }
    unresolvedDiagrams.delete(key)
    if (slot === undefined && content.diagrams.some(existing => existing.svg === diagram.svg)) {
      return { accepted: true, message: '同一张图已通过核对，无需重复提交。' }
    }
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
      unresolvedDiagrams.set(diagramKey(), '图须作为 diagrams 数组提交，每个数组元素是一张图。')
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
        '提交完整正文供读者阅读。正文含 【r1:9】 形式的源码引用，需要图时声明 [[figure:1]] 等图位。handoff 用一句话说明本章结果。修订正文后按新的图位提交图。草稿和引用验证请用 wiki_check_chapter。',
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
      return missing.length ? `${missing.map(slot => `图 ${slot}`).join('、')}尚未生成。${reason ?? ''}` : reason
    },
  }
}
