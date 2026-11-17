import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const documentFile = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/
const commitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const githubRepo = /^https:\/\/github\.com\/[a-z\d-]+\/[\w.-]+$/i

const timestamp = value => new Date(value).getTime()
const nonempty = value => typeof value === 'string' && Boolean(value.trim())

function documentRecord(document, id) {
  if (document?.id !== id || !uuid.test(id)) return
  const { createdAt, source, repoUrl, repositoryPath, repoName, commit, markdown, model, note, files, durationMs, architecture } = document
  if ((typeof createdAt !== 'string' && typeof createdAt !== 'number')
    || !Number.isFinite(timestamp(createdAt))
    || typeof commit !== 'string' || !commitHash.test(commit)
    || !nonempty(markdown)) return
  if (model !== undefined && typeof model !== 'string') return
  if (note !== undefined && typeof note !== 'string') return
  if (repoName !== undefined && !nonempty(repoName)) return

  const metadata = { id, createdAt, source, commit, ...(repoName !== undefined && { repoName }) }
  const content = {
    markdown, ...(model !== undefined && { model }), ...(note !== undefined && { note }),
    ...(Number.isSafeInteger(durationMs) && durationMs >= 0 && { durationMs }),
    ...(Array.isArray(architecture?.layers) && Array.isArray(architecture?.edges) && { architecture }),
  }
  if (source === 'github' && typeof repoUrl === 'string' && githubRepo.test(repoUrl)) {
    return { ...metadata, repoUrl, ...content }
  }
  if (source === 'local' && nonempty(repositoryPath) && isAbsolute(repositoryPath)) {
    if (files !== undefined && (!Array.isArray(files)
      || !files.every(file => nonempty(file?.path) && typeof file.text === 'string'))) return
    return {
      ...metadata, repositoryPath, ...content,
      ...(files !== undefined && { files: files.map(({ path, text, startLine }) => ({
        path, text, ...(Number.isSafeInteger(startLine) && startLine > 1 && { startLine }),
      })) }),
    }
  }
}

function documentSummary({ id, createdAt, source, commit, repoUrl, repositoryPath, repoName }) {
  return {
    id, createdAt, source, commit,
    ...(repoUrl !== undefined && { repoUrl }),
    ...(repositoryPath !== undefined && { repositoryPath }),
    ...(repoName !== undefined && { repoName }),
  }
}

export function createWikiStorage(directory) {
  async function get(id) {
    if (typeof id !== 'string' || !uuid.test(id)) return
    let handle
    try {
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      handle = await open(join(directory, id + '.json'), flags)
      if (!(await handle.stat()).isFile()) return
      const content = await handle.readFile('utf8')
      return documentRecord(JSON.parse(content), id)
    } catch (error) {
      if (!(error instanceof SyntaxError) && !['ENOENT', 'ELOOP', 'EISDIR'].includes(error?.code)) throw error
    } finally {
      await handle?.close()
    }
  }

  return {
    async save(document) {
      const id = document?.id
      if (typeof id !== 'string') throw new TypeError('Invalid wiki document')
      const record = documentRecord(document, id)
      if (!record) throw new TypeError('Invalid wiki document')

      await mkdir(directory, { recursive: true, mode: 0o700 })
      const destination = join(directory, id + '.json')
      const temporary = join(directory, '.' + randomUUID() + '.tmp')
      const handle = await open(temporary, 'wx', 0o600)
      try {
        try {
          await handle.writeFile(JSON.stringify(record) + '\n', 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        // Linking within the directory publishes the finished file without replacing an existing document.
        await link(temporary, destination)
      } finally {
        await unlink(temporary).catch(() => {})
      }
      return record
    },
    get,
    async list() {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }

      const summaries = []
      for (const entry of entries) {
        if (!entry.isFile() || !documentFile.test(entry.name)) continue
        const record = await get(entry.name.slice(0, -5))
        if (record) summaries.push(documentSummary(record))
      }
      return summaries.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || a.id.localeCompare(b.id))
    },
  }
}
