import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'
import { chapterFigureSlots, isFigureSlot } from '../skills/repo-design-wiki/scripts/chapter-figures.mjs'

const documentId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/
const gitCommit = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i
const githubLocation = /^https:\/\/github\.com\/[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i
const macSystemAlias = /^\/(?:tmp|var|etc)(?:\/|$)/
const maxDocumentBytes = 64 * 1024 * 1024
const pendingWrites = new Map()

function storageError(code, message) {
  return Object.assign(new Error(message), { code })
}

function invalidStorage() {
  return storageError('wiki-storage-invalid', '代码百科文档的保存数据无效。')
}

function validId(id) {
  return typeof id === 'string' && documentId.test(id)
}

function hasText(value) {
  return typeof value === 'string' && value.isWellFormed() && Boolean(value.trim())
}

function isoTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function sourceList(value) {
  if (!Array.isArray(value) || !value.length) return null
  const sources = Array.from(value, source => {
    const { path, line } = source ?? {}
    if (!hasText(path) || path.length > 512 || /[\\\u0000-\u001f\u007f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(line) || line < 1) return null
    return { path, line }
  })
  return sources.includes(null) ? null : sources
}

function validLocation(source, location, commit, legacy = false) {
  if (!hasText(location) || location.includes('\0') || typeof commit !== 'string' || !gitCommit.test(commit)) return false
  if (source === 'github') {
    return commit.length === 40 && githubLocation.test(location) && !/\/\.{1,2}$/.test(location)
  }
  return source === 'local' && (isAbsolute(location) || (legacy && win32.isAbsolute(location)))
}

function readDocument(input) {
  const { source, title, location, mainline, commit, chapters } = input ?? {}
  if (!validLocation(source, location, commit) || !hasText(title) || !hasText(mainline)
    || !Array.isArray(chapters) || !chapters.length) return null
  const outline = Array.from(chapters, chapter => {
    const sources = sourceList(chapter?.sources)
    if (!hasText(chapter?.title) || !sources) return null
    return { title: chapter.title, sources, markdown: '' }
  })
  if (outline.includes(null)) return null
  return { source, title, location, mainline, commit, chapters: outline }
}

function readDiagram(value) {
  const { kind, label, title, width, height, svg, slot } = value ?? {}
  if (!hasText(kind) || !hasText(label) || !hasText(title)
    || !Number.isInteger(width) || width < 1 || width > 4096
    || !Number.isInteger(height) || height < 1 || height > 4096
    || (slot !== undefined && !isFigureSlot(slot))
    || typeof svg !== 'string' || !svg.isWellFormed() || svg.length > 160_000 || !/^<svg(?:\s|>)[\s\S]*<\/svg>$/.test(svg.trim())) return null
  return { kind, label, title, width, height, svg, ...(slot !== undefined && { slot }) }
}

function readChapterWork(value) {
  const { content, warning } = value ?? {}
  const { markdown, handoff } = content ?? {}
  const sources = sourceList(content?.sources)
  if (!hasText(markdown) || typeof handoff !== 'string' || !sources || !Array.isArray(content?.diagrams)
    || (warning !== undefined && typeof warning !== 'string')) return null
  const diagrams = Array.from(content.diagrams, readDiagram)
  if (diagrams.includes(null)) return null
  if (diagrams.some(diagram => diagram.slot !== undefined)) {
    const slots = new Set(chapterFigureSlots(markdown).map(({ slot }) => slot))
    if (diagrams.some(diagram => !slots.delete(diagram.slot))) return null
  }
  return { content: { markdown, handoff, sources, diagrams }, ...(warning !== undefined && { warning }) }
}

function readLegacy(input, id, createdAt) {
  const { source, repoUrl, repositoryPath, commit, repoName, markdown } = input
  const location = source === 'github' ? repoUrl : repositoryPath
  if (!hasText(markdown) || !validLocation(source, location, commit, true)) return null
  const heading = markdown.match(/^#[ \t]+([^\r\n]+)/m)?.[1]?.trim()
  const title = [input.title, repoName, heading].find(hasText)
    ?? (source === 'github' ? location.slice('https://github.com/'.length) : location.split(/[\\/]/).filter(Boolean).at(-1) ?? location)
  return {
    id, createdAt, updatedAt: isoTime(input.updatedAt) ?? createdAt, legacy: true,
    document: { source, title, location, mainline: '', commit, chapters: [{ title: '归档正文', sources: [], markdown: '' }] },
    chapterWork: [{ content: { markdown, handoff: '', sources: [], diagrams: [] } }],
  }
}

function readRecord(input, id) {
  const createdAt = isoTime(input?.createdAt)
  if (input?.id !== id || !createdAt) return null
  if (!Object.hasOwn(input, 'document')) return readLegacy(input, id, createdAt)

  const updatedAt = isoTime(input.updatedAt)
  const document = readDocument(input.document)
  if (input.legacy || !updatedAt || !document || !Array.isArray(input.chapterWork)
    || input.chapterWork.length !== document.chapters.length) return null
  const chapterWork = input.chapterWork.map(value => value === null ? null : readChapterWork(value))
  if (chapterWork.some((value, index) => value === null && input.chapterWork[index] !== null)) return null
  return { id, createdAt, updatedAt, document, chapterWork }
}

function summarize({ id, createdAt, updatedAt, document, chapterWork, legacy }) {
  const { title, source, location, commit, chapters } = document
  return {
    id, title, source, location, commit, createdAt, updatedAt,
    chapterCount: chapters.length, generatedCount: chapterWork.filter(work => work?.content).length,
    ...(legacy && { legacy }),
  }
}

async function entryInfo(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function unsafeDirectory() {
  return storageError('wiki-storage-invalid', '代码百科存储目录不可用。')
}

function directoryResolver(directory) {
  const { root } = parse(directory)
  const parts = relative(root, directory).split(sep).filter(Boolean)
  return async function accessDirectory(create) {
    let current = root
    for (const part of parts) {
      current = join(current, part)
      let info = await entryInfo(current)
      // Resolve only macOS's fixed system aliases, never user-configured directory links.
      if (info?.isSymbolicLink() && process.platform === 'darwin' && macSystemAlias.test(current)) {
        const canonical = '/private' + current
        if (await realpath(current) !== canonical) throw unsafeDirectory()
        current = canonical
        info = await entryInfo(current)
      }
      if (!info && create) {
        await mkdir(current, { mode: 0o700 }).catch(error => {
          if (error?.code !== 'EEXIST') throw error
        })
        info = await entryInfo(current)
      }
      if (!info) return null
      if (!info.isDirectory()) throw unsafeDirectory()
    }
    return current
  }
}

async function loadRecord(directory, id) {
  const path = join(directory, id + '.json')
  let handle
  try {
    const entry = await entryInfo(path)
    if (!entry?.isFile() || entry.nlink > 1) return null
    const noFollow = constants.O_NOFOLLOW ?? 0
    const flags = constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0)
    handle = await open(path, flags)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink > 1 || info.size < 1 || info.size > maxDocumentBytes) return null
    // A save can replace the filename after lstat. On platforms without O_NOFOLLOW, verify the new entry too.
    if (!noFollow && (info.dev !== entry.dev || info.ino !== entry.ino)) {
      const replacement = await entryInfo(path)
      if (!replacement?.isFile() || info.dev !== replacement.dev || info.ino !== replacement.ino) return null
    }
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    // Bound the read to the verified file size even if an external writer appends data.
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== info.size) return null
    return readRecord(JSON.parse(bytes.subarray(0, length).toString('utf8')), id)
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ELOOP', 'EISDIR'].includes(error?.code)) return null
    throw error
  } finally {
    await handle?.close()
  }
}

async function publishRecord(directory, record, replace) {
  const serialized = JSON.stringify(record) + '\n'
  if (Buffer.byteLength(serialized) > maxDocumentBytes) throw invalidStorage()
  const target = join(directory, record.id + '.json')
  const temporary = join(directory, '.' + randomUUID() + '.tmp')
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (replace) await rename(temporary, target)
    else await link(temporary, target)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

function serializeUpdate(key, operation) {
  const result = (pendingWrites.get(key) ?? Promise.resolve()).then(operation)
  const barrier = result.then(() => {}, () => {})
  pendingWrites.set(key, barrier)
  return result.finally(() => {
    if (pendingWrites.get(key) === barrier) pendingWrites.delete(key)
  })
}

export function createWikiStorage(directory) {
  const location = resolve(directory)
  const accessDirectory = directoryResolver(location)
  const queueDirectory = process.platform === 'darwin' && macSystemAlias.test(location) ? '/private' + location : location
  return {
    async create(document) {
      const normalized = readDocument(document)
      if (!normalized) throw invalidStorage()
      const now = new Date().toISOString()
      const record = {
        id: randomUUID(), createdAt: now, updatedAt: now, document: normalized,
        chapterWork: normalized.chapters.map(() => null),
      }
      const folder = await accessDirectory(true)
      if (!folder) throw unsafeDirectory()
      await publishRecord(folder, record, false)
      return record
    },
    async get(id) {
      if (!validId(id)) return null
      const folder = await accessDirectory(false)
      return folder ? loadRecord(folder, id) : null
    },
    async list() {
      const folder = await accessDirectory(false)
      if (!folder) return []
      const entries = await readdir(folder, { withFileTypes: true })
      const summaries = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const id = entry.name.slice(0, -5)
        if (!validId(id)) continue
        const record = await loadRecord(folder, id)
        if (record) summaries.push(summarize(record))
      }
      return summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
    },
    async updateChapter(id, index, transform) {
      const missing = () => storageError('wiki-document-not-found', '找不到这篇代码百科。')
      if (!validId(id)) throw missing()
      return serializeUpdate(join(queueDirectory, id), async () => {
        const folder = await accessDirectory(false)
        if (!folder) throw missing()
        const record = await loadRecord(folder, id)
        if (!record) throw missing()
        if (record.legacy) throw storageError('wiki-document-read-only', '旧版归档文档只能阅读。')
        if (!Number.isSafeInteger(index) || index < 0 || index >= record.chapterWork.length) {
          throw storageError('wiki-chapter-not-found', '找不到该章节。')
        }
        const value = await transform(record.chapterWork[index], record)
        const work = value === null ? null : readChapterWork(value)
        if (value !== null && !work) throw invalidStorage()
        const chapterWork = [...record.chapterWork]
        chapterWork[index] = work
        const now = Math.max(Date.now(), Date.parse(record.updatedAt) + 1)
        const next = { ...record, updatedAt: isoTime(now) ?? record.updatedAt, chapterWork }
        await publishRecord(folder, next, true)
        return next
      })
    },
  }
}
