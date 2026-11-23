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

function readBody(input, numberFor) {
  const markdown = typeof input?.markdown === 'string' ? input.markdown.trim() : ''
  if (!markdown || markdown.length > 10_000) throw invalidChapter('正文须为非空 Markdown，长度不超过 10000 字符。')
  if (markdown.includes('![') || /^\s*(?:```+|~~~+)\s*(?:mermaid|graphviz|dot|plantuml)\b/im.test(markdown)) {
    throw invalidChapter('正文只用文字或代码说明，图请单独交给 wiki_submit_diagram。')
  }
  const handoff = singleLine(input.handoff, 400)
  if (!handoff) throw invalidChapter('handoff 须为一句单行文字，说明本章产生或交出的结果。')
  let citations = 0
  const marked = markdown.replace(/【([^】]*)】/gu, (original, reference) => {
    if (!/^(?:[\d０-９]+|r[\d０-９]+(?:\s*[:：][\s\S]*)?)$/i.test(reference.trim())) return original
    const number = numberFor(reference)
    citations += 1
    return '【' + number + '】'
  })
  if (!citations) throw invalidChapter('正文至少需要一处源码引用。用【r1:9】标注结论来自哪次读取和哪一行。')
  return { markdown: marked, handoff }
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
    content = { ...body, sources, diagrams: [] }
    onEvent({ type: 'body', content })
    diagnostic({ phase: 'body', status: 'accepted', sourceCount: sources.length })
    return { accepted: true, message: '正文已通过核对。需要的图可依次单独提交。' }
  }

  function submitDiagram(input, resolveReference = sourceFor) {
    signal?.throwIfAborted()
    if (!content) return { accepted: false, error: '请先调用 wiki_submit_chapter 并确认正文已被接受，再提交图。' }
    const key = diagramKey(input)
    const stage = stageSources(content.sources, resolveReference)
    let diagram
    try {
      diagram = prepareDiagram(input, stage, repository)
    } catch (error) {
      if (error?.code !== 'wiki-chapter-invalid') throw error
      unresolvedDiagrams.delete(key)
      unresolvedDiagrams.set(key, error.message)
      diagnostic({ phase: 'diagram', status: 'rejected', message: error.message })
      return { accepted: false, error: error.message }
    }
    unresolvedDiagrams.delete(key)
    if (content.diagrams.some(existing => existing.svg === diagram.svg)) {
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
        '提交本章正文。markdown 须含 【r1:9】 形式的源码引用，handoff 用一句话说明本章结果。返回 accepted 后再提交图。',
        { markdown: string, handoff: string }, ['markdown', 'handoff'], args => submitBody(args)),
      tool('wiki_submit_diagram',
        '在正文已接受后提交一张图。diagram 按图型规则填写；每条关系的 source 用字符串 r1:9 引用实际读取的位置。',
        { diagram: { type: 'object' } }, ['diagram'], ({ diagram }) => submitDiagram(diagram)),
    ],
    submitLegacy,
    get content() { return content },
    get bodyError() { return bodyError },
    get diagramError() { return [...unresolvedDiagrams.values()].at(-1) },
  }
}
