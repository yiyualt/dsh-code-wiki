import { maxBlobBytes, readPinnedGithubFile } from './github-source.js'

const maxReferences = 160
const maxExcerptLines = 8
const maxCitationLines = 25
const maxExcerptLineLength = 300
const maxCommands = 10
const maxMaterialExcerpts = 10
const maxReadmeCharacters = 18_000
const maxIntroDocuments = 3
const maxDocumentCandidates = 6
const maxDocumentCharacters = 6_000
const maxDocumentsCharacters = 16_000
const materialConcurrency = 3
const maxReadmeImages = 2
const maxImageCandidates = 8
const maxImageBytes = 2 * 1024 * 1024
const rawGithub = 'https://raw.githubusercontent.com/'
const githubRepository = /^https:\/\/github\.com\/[a-z\d-]+\/[a-z\d_.-]+$/i
const githubCommit = /^[\da-f]{40}$/i
const localDocument = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const invalidPath = /[\\\u0000-\u001f\u007f]/

function validRange(start, end) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start && end - start < maxCitationLines
}

function sourceLines(text) {
  return text.replace(/\r?\n$/, '').split(/\r?\n/)
}

const normalizedQuote = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim()

export function videoQuoteCitation(source, quote) {
  const needle = normalizedQuote(quote)
  if (!needle) return null
  // Normalize each original line, retaining its position so whitespace-tolerant
  // quotation matching still links to the actual archived source range.
  let normalized = ''
  const spans = []
  for (const [line, value] of sourceLines(source.text).entries()) {
    const text = normalizedQuote(value)
    if (!text) continue
    if (normalized) normalized += ' '
    spans.push({ start: normalized.length, end: normalized.length + text.length, line })
    normalized += text
  }
  let url
  try { if (source.url) url = new URL(source.url) } catch {}
  const local = url?.origin === 'https://dsh-code-wiki.invalid' && url.pathname === '/source'
  const github = url?.origin === 'https://github.com' && /^#L[1-9]\d*(?:-L[1-9]\d*)?$/.test(url.hash)
  const first = local ? Number(url.searchParams.get('start')) : github ? Number(url.hash.match(/^#L(\d+)/)[1]) : 1
  if (!Number.isSafeInteger(first) || first < 1) return null
  for (let offset = normalized.indexOf(needle); offset >= 0; offset = normalized.indexOf(needle, offset + 1)) {
    const start = first + spans.find(span => span.end > offset).line
    const end = first + spans.find(span => span.end >= offset + needle.length).line
    if (local && !validRange(start, end)) continue
    if (local) {
      url.searchParams.set('start', String(start))
      url.searchParams.set('end', String(end))
    } else if (github) url.hash = `L${start}${end === start ? '' : `-L${end}`}`
    return { ...(url && { url: url.href }) }
  }
  return null
}

function githubCitation(document, url) {
  if (!githubRepository.test(document.repoUrl) || !githubCommit.test(document.commit)
    || /\/(?:\.{1,2}|[^/]+\.git)$/i.test(document.repoUrl)) return null
  const prefix = `${document.repoUrl}/blob/${document.commit}/`
  if (!url.startsWith(prefix)) return null
  const match = /^([^?#]+)#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(url.slice(prefix.length))
  if (!match) return null
  const [, encodedPath, first, last = first] = match
  const start = Number(first)
  const end = Number(last)
  if (!validRange(start, end) || encodedPath.length > 1_200) return null
  let path
  try {
    const parts = encodedPath.split('/').map(decodeURIComponent)
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('/') || invalidPath.test(part))) return null
    path = parts.join('/')
  } catch { return null }
  return path.length <= 300 ? { path, start, end } : null
}

function localCitation(document, url) {
  const match = /^https:\/\/dsh-code-wiki\.invalid\/source\?key=([^&]+)&file=([1-9]\d*)&start=([1-9]\d*)&end=([1-9]\d*)$/.exec(url)
  if (!match || match[1] !== document.id || !localDocument.test(match[1])) return null
  const file = document.files?.[Number(match[2]) - 1]
  const start = Number(match[3])
  const end = Number(match[4])
  if (!Number.isSafeInteger(Number(match[2])) || !validRange(start, end) || typeof file?.text !== 'string'
    || typeof file.path !== 'string' || !file.path || file.path.length > 300 || invalidPath.test(file.path)) return null
  const first = file.startLine ?? 1
  if (!Number.isSafeInteger(first) || first < 1 || start < first || end - first >= sourceLines(file.text).length) return null
  return { path: file.path, start, end, file, first }
}

export function videoReferences(document) {
  const refs = new Map()
  const add = url => {
    if (refs.size >= maxReferences || typeof url !== 'string' || refs.has(url)) return
    const citation = document.source === 'github' ? githubCitation(document, url)
      : document.source === 'local' ? localCitation(document, url) : null
    if (!citation) return
    const { path, start, end } = citation
    refs.set(url, { id: refs.size + 1, label: `${path}:${start}${end === start ? '' : `–${end}`}`, url, path, start, end })
  }
  // Generated Wiki claims cite the relevant source range in inline Markdown links.
  for (const [, url] of (document.markdown ?? '').slice(0, 100_000).matchAll(/\]\((https:\/\/[^\s)]+)\)/g)) add(url)
  for (const layer of document.architecture?.layers ?? []) {
    for (const node of layer.nodes ?? []) for (const ref of node.refs ?? []) add(ref?.url)
  }
  for (const edge of document.architecture?.edges ?? []) for (const ref of edge.refs ?? []) add(ref?.url)
  return [...refs.values()]
}

async function readPinnedText(document, path, signal) {
  try {
    const bytes = await readPinnedGithubFile(document.repoUrl, document.commit, path, maxBlobBytes, signal)
    signal?.throwIfAborted()
    return bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function readVideoCitation(document, citation, startLine, maxLines, readText) {
  const count = Math.min(maxLines, citation.end - startLine + 1)
  const local = document.source === 'local' ? localCitation(document, citation.url) : null
  const text = document.source === 'local' ? local?.file.text : await readText(citation.path)
  if (typeof text !== 'string') return null
  const offset = startLine - (local?.first ?? 1)
  const lines = sourceLines(text).slice(offset, offset + count)
  if (lines.length !== count || !lines.some(line => line.trim())
    || lines.some(line => line.length > maxExcerptLineLength || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(line))) return null
  return { path: citation.path, startLine, lines }
}

export async function loadVideoExcerpt(document, reference, signal, { startLine, maxLines = maxExcerptLines } = {}) {
  signal?.throwIfAborted()
  const citation = videoReferences(document).find(ref => ref.url === reference?.url)
  if (!citation) return null
  const first = startLine ?? citation.start
  if (!Number.isSafeInteger(first) || first < citation.start || first > citation.end
    || !Number.isSafeInteger(maxLines) || maxLines < 1) return null
  return readVideoCitation(document, citation, first, Math.min(maxCitationLines, maxLines),
    path => readPinnedText(document, path, signal))
}

async function readVideoReadme(document, readText) {
  if (document.source === 'github') {
    for (const path of ['README.md', 'README.rst', 'readme.md']) {
      const text = await readText(path)
      if (text?.trim() && !text.includes('\0')) return { path, first: 1, text,
        urlAt: line => `${document.repoUrl}/blob/${document.commit}/${path}#L${line}` }
    }
    return null
  }
  if (document.source === 'local' && localDocument.test(document.id)) {
    const candidates = (document.files ?? []).flatMap((file, index) => {
      const name = /^readme(?:[._-]([a-z]{2,3}(?:[._-][a-z]{2,4})?))?\.(md|rst)$/i.exec(file?.path ?? '')
      const first = file?.startLine ?? 1
      if (!name || typeof file.text !== 'string' || !file.text.trim() || file.text.includes('\0')
        || !Number.isSafeInteger(first) || first < 1) return []
      const language = name[1]?.toLowerCase()
      const rank = !language ? 0 : /^en(?:[._-]|$)/.test(language) ? 1 : 2
      return [{ file, index, first, rank, extension: name[2].toLowerCase() === 'md' ? 0 : 1 }]
    }).sort((a, b) => a.rank - b.rank || a.extension - b.extension || a.file.path.localeCompare(b.file.path, 'en'))
    if (!candidates.length) return null
    const { file, index, first } = candidates[0]
    return { path: file.path, first, text: file.text.slice(0, maxBlobBytes),
      urlAt: line => `https://dsh-code-wiki.invalid/source?key=${document.id}&file=${index + 1}&start=${line}&end=${line}` }
  }
  return null
}

function readmeMarkup(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '')
}

function introDocumentPath(link) {
  const literal = link.split('#', 1)[0].replace(/^\.\//, '')
  if (!literal || literal.length > 1_200 || /[?:]/.test(literal) || literal.startsWith('/')) return null
  try {
    const parts = literal.split('/').map(decodeURIComponent)
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('/') || invalidPath.test(part))) return null
    const path = parts.join('/')
    return path.length <= 300 && /\.(?:md|mdx|rst|txt)$/i.test(path) ? path : null
  } catch { return null }
}

function introDocumentCandidates(readme) {
  const candidates = new Map()
  const add = (label, link, position) => {
    const path = introDocumentPath(link)
    if (!path || path === readme.path || /^readme[._-]/i.test(path)) return
    const topic = `${label} ${path}`
    if (/\b(?:changelog|changes|license|contributing|code[-_ ]of[-_ ]conduct|security[-_ ]policy)\b/i.test(topic)) return
    const priority = /(?:overview|introduction|features?|use[-_ ]cases?|why|about|concepts?|capabilities)/i.test(topic) ? 0
      : /(?:getting[-_ ]started|quick[-_ ]start|examples?|usage|tutorial|user[-_ ]guide|readme)/i.test(topic) ? 1
      : /(?:architecture|design)/i.test(topic) ? 2 : 3
    if (!candidates.has(path) || candidates.get(path).priority > priority) candidates.set(path, { path, priority, position })
  }
  const markup = readmeMarkup(readme.text)
  for (const match of markup.matchAll(/(?<!!)\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))[^\n]*?\)/g)) {
    const [, label, bracketed, plain] = match
    add(label, bracketed ?? plain, match.index)
  }
  for (const match of markup.matchAll(/`([^`\n]+?)\s+<([^>\n]+)>`_/g)) {
    add(match[1], match[2], match.index)
  }
  const definitions = new Map([...markup.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*<?([^\s>]+)>?.*$/gm)]
    .map(([, id, target]) => [id.toLowerCase(), target]))
  for (const match of markup.matchAll(/(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const [, label, id] = match
    const target = definitions.get((id || label).toLowerCase())
    if (target) add(label, target, match.index)
  }
  return [...candidates.values()].sort((a, b) => a.priority - b.priority || a.position - b.position).slice(0, maxDocumentCandidates)
}

async function loadIntroDocuments(document, readme, readText, signal) {
  if (!readme) return []
  const candidates = introDocumentCandidates(readme)
  const documents = []
  let remaining = maxDocumentsCharacters
  for (let i = 0; i < candidates.length && documents.length < maxIntroDocuments && remaining > 0; i += materialConcurrency) {
    signal?.throwIfAborted()
    const loaded = await Promise.all(candidates.slice(i, i + materialConcurrency).map(async ({ path }) => {
      if (document.source === 'github') {
        const text = await readText(path)
        return typeof text === 'string' && text.trim() && !text.includes('\0')
          ? { path, text, url: `${document.repoUrl}/blob/${document.commit}/${path.split('/').map(encodeURIComponent).join('/')}#L1` } : null
      }
      const index = document.files?.findIndex(file => file?.path === path) ?? -1
      const file = document.files?.[index]
      const first = file?.startLine ?? 1
      if (!localDocument.test(document.id) || typeof file?.text !== 'string' || !file.text.trim() || file.text.includes('\0')
        || !Number.isSafeInteger(first) || first < 1) return null
      return { path, text: file.text, url: `https://dsh-code-wiki.invalid/source?key=${document.id}&file=${index + 1}&start=${first}&end=${first}` }
    }))
    for (const item of loaded) {
      if (!item || documents.length === maxIntroDocuments || !remaining) continue
      const text = item.text.slice(0, Math.min(maxDocumentCharacters, remaining))
      documents.push({ ...item, text })
      remaining -= text.length
    }
  }
  return documents
}

function readmeCommands({ path, first, text, urlAt }) {
  const commands = new Map()
  const headings = []
  let fence
  for (const [index, line] of sourceLines(text).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence && marker?.[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
      for (const item of fence.commands) {
        if (!commands.has(item.command) || commands.get(item.command).rank < item.rank) commands.set(item.command, item)
      }
      fence = undefined
      continue
    }
    if (!fence) {
      const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(line)
      if (heading) {
        headings.length = heading[1].length
        headings[heading[1].length - 1] = heading[2]
      }
      if (marker) {
        const language = marker[2].trim().split(/\s/, 1)[0].toLowerCase()
        const section = headings.findLast(Boolean) ?? ''
        const rank = /\b(?:quick[ -]?start|usage|examples?|getting started|run|running)\b/i.test(section) ? 3
          : /\binstall\w*\b/i.test(section) ? 0 : 2
        fence = { marker: marker[1], language, rank, commands: [] }
      }
      continue
    }
    if (!/^(?:bash|sh|shell|zsh|console)$/.test(fence.language)) continue
    const prompt = /^\$\s+/.test(line.trim())
    const command = line.trim().replace(/^\$\s+/, '')
    if ((fence.language === 'console' && !prompt) || command.length > 100 || command.endsWith('\\')
      || !/^[a-z0-9][\w./+-]*(?:\s+.+)?$/i.test(command) || invalidPath.test(command)) continue
    const number = first + index
    if (!Number.isSafeInteger(number)) continue
    fence.commands.push({ command, rank: fence.rank,
      ref: { path, label: `${path}:${number}`, url: urlAt(number), start: number, end: number } })
  }
  return [...commands.values()].sort((a, b) => b.rank - a.rank || a.ref.start - b.ref.start)
    .slice(0, maxCommands).map(({ command, ref }, index) => ({ id: index + 1, command, ref }))
}

export async function loadVideoCommands(document, signal) {
  signal?.throwIfAborted()
  const readme = await readVideoReadme(document, path => readPinnedText(document, path, signal))
  return readme ? readmeCommands(readme) : []
}

function repositoryImagePath(url, rawPrefix) {
  const literal = url.replace(/^\.\//, '')
  if (/[?#]/.test(literal) || /^\s*\//.test(literal)) return null
  if (/^[\w+.-]+:/.test(literal) && literal.slice(0, rawPrefix.length).toLowerCase() !== rawPrefix.toLowerCase()) return null
  const relative = literal.startsWith(rawGithub) ? literal.slice(rawPrefix.length) : literal
  try {
    const parts = relative.split('/').map(decodeURIComponent)
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('/') || invalidPath.test(part))) return null
    const path = parts.join('/')
    if (path.length > 300 || !/\.(?:png|jpe?g|webp)$/i.test(path)
      || /(?:^|[\s_.\/-])(?:badges?|shields?|build-status|coverage)(?=[\s_.\/-]|$)/i.test(path)) return null
    return path
  } catch { return null }
}

function readmeImagePaths(text, rawPrefix) {
  const paths = new Set()
  const markup = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))[^\n]*?\)|<img\b[^>]*?\ssrc\s*=\s*(['"])(.*?)\4[^>]*>/gi
  const readme = readmeMarkup(text)
  for (const [, alt, escaped, inline, , html] of readme.matchAll(markup)) {
    if (alt && /\b(?:badges?|build status|coverage)\b/i.test(alt)) continue
    const path = repositoryImagePath(escaped ?? inline ?? html, rawPrefix)
    if (path) paths.add(path)
    if (paths.size === maxImageCandidates) break
  }
  return [...paths]
}

function imageType(path, bytes) {
  if (/\.png$/i.test(path) && bytes.length >= 33 && bytes.readBigUInt64BE(0) === 0x89504e470d0a1a0an
    && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png'
  if (/\.jpe?g$/i.test(path) && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[2] === 0xff && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) return 'image/jpeg'
  if (/\.webp$/i.test(path) && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp'
  return null
}

async function readPinnedImage(rawPrefix, path, signal) {
  try {
    const deadline = AbortSignal.timeout(8_000)
    const url = rawPrefix + path.split('/').map(encodeURIComponent).join('/')
    const response = await fetch(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { Accept: 'image/png, image/jpeg, image/webp' } })
    if (!response.ok || Number(response.headers.get('content-length')) > maxImageBytes) {
      await response.body?.cancel()
      return null
    }
    const chunks = []
    let bytesRead = 0
    for await (const chunk of response.body) {
      bytesRead += chunk.length
      if (bytesRead > maxImageBytes) return null
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks, bytesRead)
    const mimeType = imageType(path, bytes)
    if (!mimeType) return null
    return { path, mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` }
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function loadReadmeImages(document, readme, signal) {
  if (!readme || document.source !== 'github' || !githubRepository.test(document.repoUrl) || !githubCommit.test(document.commit)
    || /\/(?:\.{1,2}|[^/]+\.git)$/i.test(document.repoUrl)) return []
  const prefix = `${rawGithub}${document.repoUrl.slice('https://github.com/'.length)}/${document.commit}/`
  const paths = readmeImagePaths(readme.text, prefix)
  const images = []
  while (paths.length && images.length < maxReadmeImages) {
    signal?.throwIfAborted()
    const batch = paths.splice(0, maxReadmeImages - images.length)
    const loaded = await Promise.all(batch.map(path => readPinnedImage(prefix, path, signal)))
    images.push(...loaded.filter(Boolean))
  }
  return images.map((image, i) => ({ id: `image-${i + 1}`, ...image }))
}

function citationPriority({ path }) {
  const filename = path.split('/').at(-1)
  if (/^(?:test[_-]|.+[._-](?:spec|test)\.)/i.test(filename)
    || /(?:^|\/)(?:tests?|fixtures|vendor|node_modules)\//i.test(path)) return 3
  if (/^(?:main|app|server|cli|run|start|quick[-_]start|run[-_][^.]+)\.[\w]+$/i.test(filename)) return 0
  return /\.(?:[cm]?[jt]sx?|rs|go|py|rb|java|kts?|scala|swift|c|cc|cpp|cs|exs?|php|sh)$/i.test(filename) ? 1 : 2
}

export async function loadVideoMaterial(document, signal) {
  signal?.throwIfAborted()
  const references = videoReferences(document)
  const ordered = references.map(ref => ({ ref, priority: citationPriority(ref) }))
    .sort((a, b) => a.priority - b.priority || (b.ref.end - b.ref.start) - (a.ref.end - a.ref.start) || a.ref.id - b.ref.id)
  const byPath = new Map()
  for (const { ref } of ordered) if (!byPath.has(ref.path)) byPath.set(ref.path, ref)
  const selected = [...byPath.values()].slice(0, maxMaterialExcerpts)
  const reads = new Map()
  const readText = path => {
    if (!reads.has(path)) reads.set(path, readPinnedText(document, path, signal))
    return reads.get(path)
  }
  // Reserve at most three simultaneous reads, including the README. A missing
  // file or an archived excerpt with unavailable lines can be left out.
  const work = [() => readVideoReadme(document, readText), ...selected.map(ref => async () => {
    const excerpt = await readVideoCitation(document, ref, ref.start, maxCitationLines, readText)
    return excerpt && { id: ref.id, ...excerpt }
  })]
  const results = []
  for (let i = 0; i < work.length; i += materialConcurrency) {
    signal?.throwIfAborted()
    results.push(...await Promise.all(work.slice(i, i + materialConcurrency).map(read => read())))
  }
  const [readme, ...excerpts] = results
  const documents = await loadIntroDocuments(document, readme, readText, signal)
  const images = await loadReadmeImages(document, readme, signal)
  signal?.throwIfAborted()
  return { references, commands: readme ? readmeCommands(readme) : [], excerpts: excerpts.filter(Boolean),
    images,
    ...(documents.length && { documents }),
    ...(readme && { readme: readme.text.slice(0, maxReadmeCharacters), readmePath: readme.path, readmeUrl: readme.urlAt(readme.first) }) }
}
