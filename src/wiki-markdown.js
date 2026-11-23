export const maxWikiMarkdownLength = 160_000

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const protocolMarker = /^ {0,3}<!--[ \t]*wiki:(continue|complete)[ \t]*-->[ \t]*$/gm
const reference = /\[E(?=[ \t]*[\d:+-])([^\[\]\n]*:[^\[\]\n]*)\]/g
const referenceNumbers = /^([1-9]\d*):([1-9]\d*)(?:-([1-9]\d*))?$/

function invalid(message) {
  return Object.assign(new Error(message), { code: 'model-output-invalid' })
}

function markdownFence(line) {
  const quote = /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? ''
  line = line.slice(quote.length)
  const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(line)?.[0] ?? ''
  const marker = /^( *)((?:`{3,}|~{3,}))(.*)$/.exec(line.slice(list.length))
  if (!marker) return null
  const [, indent, delimiter, info] = marker
  return { indent: indent.length, delimiter, info: info.trim(), quotes: (quote.match(/>/g) ?? []).length, list: list.length }
}

function markdownBlocks(markdown) {
  const blocks = []
  let fence = null
  let indented = false
  let blank = true
  let offset = 0
  let proseStart = 0
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const next = offset + line.length
    const content = line.replace(/\n$/, '')
    const marker = markdownFence(content)
    const quotedContent = content.replace(/^(?: {0,3}>[ \t]?)+/, '')
    const quotes = (content.slice(0, content.length - quotedContent.length).match(/>/g) ?? []).length
    const indent = /^ */.exec(quotedContent)[0].length
    if (fence && (quotes < fence.quotes || (fence.list > indent && quotedContent.trim()))) {
      blocks.push({ start: fence.start, end: offset, code: true })
      fence = null
      proseStart = offset
    }
    if (fence) {
      if (marker && marker.quotes === fence.quotes && !marker.list && marker.indent <= fence.list + 3
        && marker.delimiter[0] === fence.delimiter[0] && marker.delimiter.length >= fence.delimiter.length && !marker.info) {
        const plainWrapper = !fence.quotes && !fence.list && /^(?:markdown|md|mdx|text|plaintext)?$/i.test(fence.info)
        blocks.push({ start: fence.start, end: next, code: true, plainWrapper })
        fence = null
        proseStart = next
      }
    } else if (marker && marker.indent <= 3 && (marker.delimiter[0] !== '`' || !marker.info.includes('`'))) {
      if (proseStart < offset) blocks.push({ start: proseStart, end: offset })
      fence = { ...marker, start: offset }
    } else if ((blank || indented) && /^(?: {4}| {0,3}\t)/.test(quotedContent)) {
      if (proseStart < offset) blocks.push({ start: proseStart, end: offset })
      blocks.push({ start: offset, end: next, code: true })
      proseStart = next
      indented = true
    } else if (content.trim()) {
      indented = false
    }
    blank = !content.trim()
    offset = next
  }
  if (fence) blocks.push({ start: fence.start, end: offset, code: true })
  else if (proseStart < offset) blocks.push({ start: proseStart, end: offset })
  return blocks
}

function escaped(text, index) {
  let preceding = index
  while (preceding > 0 && text[preceding - 1] === '\\') preceding--
  return (index - preceding) % 2 === 1
}

function outsideInlineCode(text, transform, preserve) {
  return text.split(/(\n[ \t]*\n)/).map(paragraph => {
    const delimiters = [...paragraph.matchAll(/`+/g)]
    const nextByLength = new Map()
    const escapedFirst = delimiters.map(match => Number(escaped(paragraph, match.index)))
    const closing = delimiters.map(() => undefined)
    for (let index = delimiters.length - 1; index >= 0; index--) {
      const length = delimiters[index][0].length
      closing[index] = nextByLength.get(length - escapedFirst[index])
      nextByLength.set(length, index)
    }
    const parts = []
    let start = 0
    for (let index = 0; index < delimiters.length; index++) {
      const ending = delimiters[closing[index]]
      if (!ending) continue
      const opening = delimiters[index].index + escapedFirst[index]
      const end = ending.index + ending[0].length
      parts.push(transform(paragraph.slice(start, opening)), preserve(paragraph.slice(opening, end)))
      start = end
      index = closing[index]
    }
    parts.push(transform(paragraph.slice(start)))
    return parts.join('')
  }).join('')
}

function transformMarkdown(markdown, transform, preserve = part => part) {
  return markdownBlocks(markdown).map(({ start, end, code }) => {
    const part = markdown.slice(start, end)
    return code ? preserve(part) : outsideInlineCode(part, transform, preserve)
  }).join('')
}

const maskCode = part => part.replace(/[^\n]/g, '\u0000')

export function savedWikiHeadings(markdown) {
  return [...transformMarkdown(markdown, part => part, maskCode).matchAll(/^#{1,2} [^\n]+/gm)]
    .map(match => markdown.slice(match.index, match.index + match[0].length)).join('\n')
}

export function readMarkdownReply(text) {
  if (typeof text !== 'string' || text.length > maxWikiMarkdownLength || controls.test(text)) {
    throw invalid('请返回长度有效的纯文本 Markdown 正文。')
  }
  const normalized = text.replace(/\r\n?/g, '\n')
  const markers = [...transformMarkdown(normalized, part => part, maskCode).matchAll(protocolMarker)]
  const marker = markers[0]
  if (markers.length !== 1 || normalized.slice(marker.index + marker[0].length).trim()) {
    throw invalid('请在 Markdown 正文末尾另起一行放置唯一的 Wiki 结束标记。')
  }
  const markdown = normalized.slice(0, marker.index).replace(/\n(?:[ \t]*\n)*$/, '')
  if (!markdown.trim()) throw invalid('Markdown 正文为空。')
  const blocks = markdownBlocks(markdown.replace(/^(?:[ \t]*\n)+/, ''))
  if (blocks.length === 1 && blocks[0].plainWrapper) {
    throw invalid('请直接返回 Markdown 正文。')
  }
  return { markdown, complete: marker[1] === 'complete' }
}

const validPath = path => typeof path === 'string' && path.length <= 300 && path.isWellFormed() && !/[\\\u0000-\u001f\u007f]/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..')

function citationLink(source, path, evidence, start, end) {
  const label = path.replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&') + ':' + start + (end > start ? '–' + end : '')
  const encodedPath = path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,
    char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/')
  const url = source.owner
    ? `https://github.com/${source.owner}/${source.repo}/blob/${source.commit}/${encodedPath}#L${start}${end > start ? '-L' + end : ''}`
    : 'https://dsh-code-wiki.invalid/source?' + new URLSearchParams({ key: source.sourceKey, file: evidence, start, end })
  return `[${label}](${url})`
}

export function resolveMarkdownCitations(markdown, source, evidence) {
  return transformMarkdown(markdown, part => part
    // Keep image destinations as links rather than fetching model-authored URLs on open.
    .replace(/!\[/g, (start, index) => escaped(part, index) ? start : '\\![')
    .replace(reference, (raw, numbers, index, prose) => {
      if (escaped(prose, index)) return raw
      const match = referenceNumbers.exec(numbers)
      if (!match) throw invalid(`源码引用 ${raw.slice(0, 80)} 的编号或行号格式无效。`)
      const [, evidenceNumber, first, last = first] = match
      const [id, start, end] = [evidenceNumber, first, last].map(Number)
      const file = evidence[id - 1]
      if (![id, start, end].every(Number.isSafeInteger) || !validPath(file?.path)
        || !Number.isSafeInteger(file.start) || !Number.isSafeInteger(file.end)
        || start < file.start || end > file.end || end < start) {
        throw invalid(`源码引用 ${raw} 超出已读取的证据范围。`)
      }
      const links = []
      for (let firstLine = start; firstLine <= end; firstLine += 25) {
        links.push(citationLink(source, file.path, id, firstLine, Math.min(end, firstLine + 24)))
      }
      return links.join(' ')
    }))
}
