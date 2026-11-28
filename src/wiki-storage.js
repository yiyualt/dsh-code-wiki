import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'
import { chapterFigureSlots, isFigureSlot } from '../skills/repo-design-wiki/scripts/chapter-figures.mjs'
import { singleLine } from '../skills/repo-design-wiki/scripts/wiki-generation.mjs'

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

function missingDocument() {
  return storageError('wiki-document-not-found', '找不到这篇代码百科。')
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
  if (!hasText(location) || location.includes('\0')) return false
  const local = source === 'local' && (isAbsolute(location) || (legacy && win32.isAbsolute(location)))
  if (commit === null) return local && !legacy
  if (typeof commit !== 'string' || !gitCommit.test(commit)) return false
  if (source === 'github') {
    return commit.length === 40 && githubLocation.test(location) && !/\/\.{1,2}$/.test(location)
  }
  return local
}

export function readChapterConnection(value) {
  const { module, from, to, handoff } = value ?? {}
  if ([module, from, to, handoff].some(field => !hasText(field) || singleLine(field) !== field)) return null
  if (module !== from && module !== to) return null
  return { module, from, to, handoff }
}

function readDocument(input) {
  const { source, title, location, mainline, commit, chapters, overview: rawOverview } = input ?? {}
  if (!validLocation(source, location, commit) || !hasText(title) || !hasText(mainline)
    || !Array.isArray(chapters) || !chapters.length) return null
  const outline = Array.from(chapters, chapter => {
    const sources = sourceList(chapter?.sources)
    if (!hasText(chapter?.title) || !sources) return null
    const connection = chapter.connection === undefined ? undefined : readChapterConnection(chapter.connection)
    if (connection === null) return null
    return { title: chapter.title, sources, ...(connection && { connection }), markdown: '' }
  })
  if (outline.includes(null)) return null
  const overview = rawOverview === undefined ? undefined : readOverview(rawOverview)
  if (overview === null) return null
  return { source, title, location, mainline, commit, ...(overview && { overview }), chapters: outline }
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

function readSectionContent(content, completeFigures = false) {
  const { markdown } = content ?? {}
  const sources = sourceList(content?.sources)
  if (!hasText(markdown) || !sources || !Array.isArray(content?.diagrams)) return null
  const diagrams = Array.from(content.diagrams, readDiagram)
  if (diagrams.includes(null)) return null
  if (completeFigures || diagrams.some(diagram => diagram.slot !== undefined)) {
    const slots = chapterFigureSlots(markdown).map(({ slot }) => slot)
    if (completeFigures && slots.some((slot, index) => slot !== index + 1)) return null
    const pending = new Set(slots)
    if (diagrams.some(diagram => !pending.delete(diagram.slot)) || (completeFigures && pending.size)) return null
  }
  return { markdown, sources, diagrams }
}

function readOverview(value) {
  const overview = readSectionContent(value, true)
  return overview?.diagrams.some(({ kind }) => kind === 'component' || kind === 'dependency') ? overview : null
}

function readChapterWork(value) {
  const { content, warning } = value ?? {}
  const handoff = content?.handoff
  if (typeof handoff !== 'string' || (warning !== undefined && typeof warning !== 'string')) return null
  const section = readSectionContent(content)
  if (!section) return null
  const { markdown, sources, diagrams } = section
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
  if (input?.id !== id || !createdAt || (input.archived !== undefined && typeof input.archived !== 'boolean')) return null
  const archive = input.archived ? { archived: true } : {}
  if (!Object.hasOwn(input, 'document')) {
    const record = readLegacy(input, id, createdAt)
    return record && { ...record, ...archive }
  }

  const updatedAt = isoTime(input.updatedAt)
  const document = readDocument(input.document)
  if (input.legacy || !updatedAt || !document || !Array.isArray(input.chapterWork)
    || input.chapterWork.length !== document.chapters.length) return null
  const chapterWork = input.chapterWork.map(value => value === null ? null : readChapterWork(value))
  if (chapterWork.some((value, index) => value === null && input.chapterWork[index] !== null)) return null
  return { id, createdAt, updatedAt, document, chapterWork, ...archive }
}

function summarize({ id, createdAt, updatedAt, document, chapterWork, legacy, archived }) {
  const { title, source, location, commit, chapters } = document
  return {
    id, title, source, location, commit, createdAt, updatedAt,
    chapterCount: chapters.length, generatedCount: chapterWork.filter(work => work?.content).length,
    ...(document.overview && { hasOverview: true }),
    ...(legacy && { legacy }), ...(archived && { archived }),
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
    const persisted = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    const record = readRecord(persisted, id)
    return record && { record, persisted }
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

  async function updateRecord(id, operation) {
    if (!validId(id)) throw missingDocument()
    return serializeUpdate(join(queueDirectory, id), async () => {
      const folder = await accessDirectory(false)
      const stored = folder && await loadRecord(folder, id)
      if (!stored) throw missingDocument()
      return operation(stored, folder)
    })
  }

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
      return folder ? (await loadRecord(folder, id))?.record ?? null : null
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
        const stored = await loadRecord(folder, id)
        if (stored) summaries.push(summarize(stored.record))
      }
      return summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
    },
    async setArchived(id, archived) {
      return updateRecord(id, async ({ record, persisted }, folder) => {
        if (Boolean(record.archived) !== archived) await publishRecord(folder, { ...persisted, archived }, true)
        return { id, archived }
      })
    },
    async delete(id) {
      return updateRecord(id, async (_stored, folder) => {
        await unlink(join(folder, id + '.json'))
        return { id, deleted: true }
      })
    },
    async updateChapter(id, index, transform) {
      return updateRecord(id, async ({ record }, folder) => {
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
