import { fromMarkdown } from 'mdast-util-from-markdown'
import { replaceChapterText } from './chapter-figures.mjs'

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

export function readWikiMarkdown(value, invalid, { label, proseError, diagramError }) {
  const markdown = typeof value === 'string' ? value.trim() : ''
  if (!markdown || !markdown.isWellFormed()) throw invalid(label + '须为有效的非空 Markdown。')
  const tree = fromMarkdown(markdown)
  if (embeddedDiagram(tree)) throw invalid(diagramError)
  if (!hasBodyProse(tree)) throw invalid(proseError)
  return { markdown, tree }
}

export function rewriteWikiCitations(markdown, tree, replace) {
  return replaceChapterText(markdown, text => text.replace(/【([^】]*)】/gu, (original, value) => {
    const reference = value.trim()
    return /^(?:[\d０-９]+|r[\d０-９]+|r[^\s:：]*\s*[:：][^\r\n]*)$/iu.test(reference)
      ? replace(reference, original) : original
  }), tree)
}

const numericCitation = /【([1-9]\d*)】/gu
const sentenceToken = /【([1-9]\d*)】|[。！？!?]+|\.(?=[\s"'”’」』）)\]【]|$)/gu
const authoredLink = new Set(['link', 'linkReference', 'image', 'imageReference'])
const tableDelimiter = /^[ \t]*(?=[^\r\n]*\|)\|?[ \t]*:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*[ \t]*\|?[ \t]*$/mu
const onlyCitationMarkers = /^(?:【[1-9]\d*】[ \t]*)+$/u

export function normalizeWikiCitations(markdown, citationNumber = number => number) {
  if (!markdown.includes('【')) return markdown
  const edits = []

  function edit(start, end, text) {
    if (markdown.slice(start, end) !== text) edits.push({ start, end, text })
  }

  function paragraph(node) {
    let citations = []
    let contentEnd
    let previousSentence

    function rewriteSentence({ citations, contentEnd, punctuation }) {
      const keep = new Map()
      for (const citation of citations) {
        if (!keep.has(citation.marker) || !citation.leading || keep.get(citation.marker).leading) {
          keep.set(citation.marker, citation)
        }
      }
      const stays = citation => keep.get(citation.marker) === citation && (!citation.leading || contentEnd === undefined)
      const moved = []
      for (const citation of citations) {
        const { start, end, marker, leading, wrapper } = citation
        if (stays(citation)) {
          edit(start, end, marker)
          continue
        }
        if (keep.get(marker) === citation) moved.push(marker)
        const removeWrapper = wrapper && !wrapper.citations.some(stays)
        if (removeWrapper && wrapper.citations[0] !== citation) continue
        const { start: removeStart, end: removeEnd } = removeWrapper ? wrapper : citation
        let stop = removeEnd
        if (leading || /[ \t]/u.test(markdown[removeStart - 1] ?? '')) {
          while (/[ \t]/u.test(markdown[stop] ?? '')) stop++
        }
        edit(removeStart, stop, '')
      }
      if (moved.length) edit(punctuation ?? contentEnd, punctuation ?? contentEnd, moved.join(''))
    }

    function finishSentence(punctuation) {
      // A citation-only tail after the last punctuation belongs to the preceding sentence.
      if (previousSentence) {
        if (punctuation === undefined && contentEnd === undefined && previousSentence.contentEnd !== undefined) {
          previousSentence.citations.push(...citations)
          citations = []
        }
        rewriteSentence(previousSentence)
      }
      const sentence = { citations, contentEnd, punctuation }
      if (punctuation === undefined) rewriteSentence(sentence)
      else previousSentence = sentence
      citations = []
      contentEnd = undefined
    }

    function noteText(text, start) {
      const trimmed = text.trimEnd()
      if (trimmed && (contentEnd !== undefined || /[\p{L}\p{N}]/u.test(trimmed))) contentEnd = start + trimmed.length
    }

    function scan(node) {
      const start = node.position.start.offset
      const end = node.position.end.offset
      if (node.type === 'text') {
        const text = markdown.slice(start, end)
        let cursor = 0
        for (const token of text.matchAll(sentenceToken)) {
          const [original, reference] = token
          const offset = start + token.index
          noteText(text.slice(cursor, token.index), start + cursor)
          cursor = token.index + original.length
          if (reference) {
            const number = citationNumber(reference)
            if (number) citations.push({ start: offset, end: start + cursor, marker: `【${number}】`, leading: contentEnd === undefined })
          } else {
            finishSentence(markdown[offset - 1] === '\\' ? offset - 1 : offset)
          }
        }
        noteText(text.slice(cursor), start + cursor)
      } else if (node.type === 'inlineCode' || authoredLink.has(node.type)) {
        contentEnd = end
      } else if (node.children) {
        const before = contentEnd
        const citationCount = citations.length
        node.children.forEach(scan)
        if (contentEnd !== undefined && contentEnd !== before) contentEnd = end
        if (citations.length > citationCount && node.children.length === 1 && (node.type === 'emphasis' || node.type === 'strong')) {
          const [child] = node.children
          const inner = citations.slice(citationCount)
          const wrapper = inner[0].wrapper
          const text = markdown.slice(child.position.start.offset, child.position.end.offset)
          if (wrapper?.start === child.position.start.offset && wrapper.end === child.position.end.offset) {
            Object.assign(wrapper, { start, end })
          } else if (child.type === 'text' && onlyCitationMarkers.test(text) && inner.length === [...text.matchAll(numericCitation)].length) {
            const group = { start, end, citations: inner }
            for (const citation of inner) citation.wrapper = group
          }
        }
      }
    }

    node.children.forEach(scan)
    finishSentence()
  }

  function visit(node) {
    if (authoredLink.has(node.type)) return
    if (node.type === 'text' || node.type === 'paragraph') {
      const start = node.position.start.offset
      const source = markdown.slice(start, node.position.end.offset)
      if (node.type === 'paragraph' && !tableDelimiter.test(source)) {
        paragraph(node)
        return
      }
      if (node.type === 'text') {
        for (const { 0: marker, 1: reference, index } of source.matchAll(numericCitation)) {
          const number = citationNumber(reference)
          if (number) edit(start + index, start + index + marker.length, `【${number}】`)
        }
      }
    }
    node.children?.forEach(visit)
  }

  visit(fromMarkdown(markdown))
  if (!edits.length) return markdown
  edits.sort((a, b) => a.start - b.start || a.end - b.end)
  const parts = []
  let offset = 0
  for (const { start, end, text } of edits) {
    parts.push(markdown.slice(offset, start), text)
    offset = end
  }
  return parts.join('') + markdown.slice(offset)
}
