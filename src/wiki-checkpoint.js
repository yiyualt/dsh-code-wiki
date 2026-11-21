import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const maxBytes = 8 * 1024 * 1024
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0')
const fields = new Set(['version', 'repositoryUrl', 'repositoryPath', 'commit', 'plan', 'draft', 'evidence'])
const kinds = new Set(['source', 'documentation', 'config'])
const pendingWrites = new Map()

async function replaceCheckpoint(temporary, target) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, target); return }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 5) throw error
      // Windows readers or scanners can briefly deny replacement of an otherwise writable file.
      await delay(10 * 2 ** attempt)
    }
  }
}

function validPayload(value) {
  if (!object(value) || Object.keys(value).some(key => !fields.has(key)) || value.version !== 1
    || typeof value.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.commit)
    || !object(value.plan) || (value.draft !== undefined && !object(value.draft))
    || !Array.isArray(value.evidence) || value.evidence.length > 240) return false
  const github = value.repositoryUrl !== undefined
  const local = value.repositoryPath !== undefined
  if (github === local) return false
  if (github && (!nonempty(value.repositoryUrl, 300) || !/^https:\/\/github\.com\/[a-z\d-]+\/[\w.-]+\/?$/i.test(value.repositoryUrl))) return false
  if (local && (!nonempty(value.repositoryPath, 4096) || !isAbsolute(value.repositoryPath))) return false
  if (!value.evidence.every(file => object(file) && nonempty(file.path, 300)
    && !/[\\\u0000-\u001f\u007f]/.test(file.path) && file.path.split('/').every(part => part && part !== '.' && part !== '..')
    && Number.isSafeInteger(file.start) && file.start > 0 && Number.isSafeInteger(file.end) && file.end >= file.start
    && typeof file.text === 'string' && typeof file.primary === 'boolean'
    && (file.kind === undefined || kinds.has(file.kind)))) return false
  return new Set(value.evidence.map(file => file.path)).size <= 90
}

async function readRegular(path) {
  let file
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.size > maxBytes) return null
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes || stat.ino !== before.ino || stat.dev !== before.dev) return null
    const chunks = []
    let length = 0
    while (length <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      length += bytesRead
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return length > maxBytes ? null : Buffer.concat(chunks, length)
  } catch (error) {
    if (!['ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR'].includes(error?.code)) throw error
    return null
  } finally { await file?.close() }
}

export function createWikiCheckpoints(directory) {
  async function get(id) {
    if (!validId(id)) return null
    const bytes = await readRegular(join(directory, id + '.json'))
    if (!bytes) return null
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      return validPayload(value) ? value : null
    } catch { return null }
  }

  return {
    async save(id, payload) {
      if (!validId(id)) throw new TypeError('Invalid Wiki checkpoint ID')
      if (!validPayload(payload)) throw new TypeError('Invalid Wiki checkpoint payload')
      const serialized = JSON.stringify(payload)
      if (Buffer.byteLength(serialized) > maxBytes) throw new RangeError('Wiki checkpoint exceeds 8 MiB')
      if (!validPayload(JSON.parse(serialized))) throw new TypeError('Invalid Wiki checkpoint payload')
      const target = resolve(directory, id + '.json')
      const writing = (pendingWrites.get(target) ?? Promise.resolve()).catch(() => {}).then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await chmod(directory, 0o700)
        const temporary = join(directory, '.' + randomUUID() + '.tmp')
        let file
        try {
          file = await open(temporary, 'wx', 0o600)
          await file.writeFile(serialized, 'utf8')
          await file.sync()
          await file.close()
          file = undefined
          await replaceCheckpoint(temporary, target)
        } finally {
          await file?.close()
          await unlink(temporary).catch(error => { if (error?.code !== 'ENOENT') throw error })
        }
      })
      pendingWrites.set(target, writing)
      try { await writing }
      finally { if (pendingWrites.get(target) === writing) pendingWrites.delete(target) }
    },
    get,
    async latest(accept = () => true) {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
      const candidates = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const id = entry.name.slice(0, -5)
        if (!validId(id)) continue
        const file = await lstat(join(directory, entry.name)).catch(error => {
          if (error?.code !== 'ENOENT') throw error
        })
        if (file?.isFile() && file.size <= maxBytes) candidates.push({ id, updatedAt: file.mtimeMs })
      }
      candidates.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      for (const { id, updatedAt } of candidates) {
        const checkpoint = await get(id)
        if (!checkpoint) continue
        const { repositoryUrl, repositoryPath, commit } = checkpoint
        const metadata = { id, commit, repositoryUrl, repositoryPath, updatedAt }
        if (await accept(metadata)) return metadata
      }
      return null
    },
    async remove(id) {
      if (!validId(id)) return false
      try { await unlink(join(directory, id + '.json')) }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
      return true
    },
  }
}
