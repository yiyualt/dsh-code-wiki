import { fromMarkdown } from 'mdast-util-from-markdown'
import { chapterFigureSlots, isFigureSlot, replaceOutsideCode } from './chapter-figures.mjs'
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

function stageSources(current, resolveReference) {
  const sources = [...current]
  const numbers = new Map(current.map((source, index) => [sourceKey(source), index + 1]))
  function numberFor(reference) {
    const source = resolveReference(reference)
    if (!source) throw invalidChapter('引用须使用本次 wiki_read 返回的 handle 和范围内的行号，例如 r1:9。')
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

function readBody(input, numberFor) {
  const markdown = typeof input?.markdown === 'string' ? input.markdown.trim() : ''
  if (!markdown || markdown.length > 10_000) throw invalidChapter('正文须为非空 Markdown，长度不超过 10000 字符。')
  const tree = fromMarkdown(markdown)
  if (embeddedDiagram(tree)) {
    throw invalidChapter('正文只用文字或代码说明，图请单独交给 wiki_submit_diagram。')
  }
  const figureSlots = chapterFigureSlots(markdown, tree).map(({ slot }) => slot)
  if (figureSlots.some((slot, index) => slot !== index + 1)) {
    throw invalidChapter('正文图位须从 [[figure:1]] 开始连续编号，每个图位独占一行，前后留空行。')
  }
  const handoff = singleLine(input.handoff, 400)
  if (!handoff) throw invalidChapter('handoff 须为一句单行文字，说明本章产生或交出的结果。')
  let citations = 0
  const marked = replaceOutsideCode(markdown, text => text.replace(/【([^】]*)】/gu, (original, reference) => {
    if (!/^(?:[\d０-９]+|r[\d０-９]+(?:\s*[:：][\s\S]*)?)$/i.test(reference.trim())) return original
    const number = numberFor(reference)
    citations += 1
    return '【' + number + '】'
  }), tree)
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

export function createChapterSubmissions({ repository, signal, evidence, sourceFor, onEvent, diagnostic }) {
  const unresolvedDiagrams = new Map()
  let content
  let bodyError
  let figureSlots = []

  function submitBody(input, resolveReference = sourceFor) {
    signal?.throwIfAborted()
    if (content) return { accepted: true, message: '正文已经接受。下一步可单独提交需要的图。' }
    const { sources, numberFor } = stageSources([], resolveReference)
    let body
    try {
      body = readBody(input, numberFor)
    } catch (error) {
      if (error?.code !== 'wiki-chapter-invalid') throw error
      bodyError = error.message
      diagnostic({ phase: 'body', status: 'rejected', message: error.message })
      return { accepted: false, error: error.message }
    }
    const { markdown, handoff } = body
    figureSlots = body.figureSlots
    content = { markdown, handoff, sources, diagrams: [] }
    onEvent({ type: 'body', content })
    diagnostic({ phase: 'body', status: 'accepted', sourceCount: sources.length })
    return figureSlots.length
      ? { accepted: true, message: '正文已通过核对。依图位分别提交图，diagram.slot 填图位编号。', figureSlots }
      : { accepted: true, message: '正文已通过核对。' }
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
    const stage = stageSources(content.sources, resolveReference)
    let diagram
    try {
      diagram = prepareDiagram(input, stage, repository)
      if (slot !== undefined) diagram = { ...diagram, slot }
    } catch (error) {
      if (error?.code !== 'wiki-chapter-invalid') throw error
      unresolvedDiagrams.delete(key)
      unresolvedDiagrams.set(key, error.message)
      diagnostic({ phase: 'diagram', status: 'rejected', message: error.message })
      return { accepted: false, error: error.message }
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
      tool('wiki_submit_chapter',
        '提交本章正文。markdown 须含 【r1:9】 形式的源码引用，需要图时在对应段落后声明 [[figure:1]] 等图位。handoff 用一句话说明本章结果。返回 accepted 后再提交图。',
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
