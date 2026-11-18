import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const validVideoId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const maxArtifactBytes = 8 * 1024 * 1024

async function regularFile(path, maxBytes) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) return null
    return await file.readFile()
  } catch (error) {
    if (!['ENOENT', 'ELOOP', 'EISDIR'].includes(error.code)) throw error
    return null
  } finally { await file?.close() }
}

export function createVideoStorage(directory) {
  async function get(documentId, id) {
    if (!validVideoId(documentId) || !validVideoId(id)) return null
    const bytes = await regularFile(join(directory, documentId, id, 'video.json'), maxArtifactBytes)
    if (!bytes) return null
    try {
      const artifact = JSON.parse(bytes)
      if (artifact.id !== id || artifact.documentId !== documentId || artifact.version !== 1 || !Array.isArray(artifact.scenes)) return null
      return artifact
    } catch { return null }
  }
  return {
    get,
    async latest(documentId) {
      if (!validVideoId(documentId)) return null
      let entries
      try { entries = await readdir(join(directory, documentId), { withFileTypes: true }) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
      const artifacts = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !validVideoId(entry.name)) continue
        const artifact = await get(documentId, entry.name)
        if (artifact) artifacts.push(artifact)
      }
      return artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    },
    async save(artifact, clips) {
      if (!validVideoId(artifact.documentId) || !validVideoId(artifact.id)) throw new Error('Invalid video ID')
      const serialized = JSON.stringify(artifact)
      if (Buffer.byteLength(serialized) > maxArtifactBytes) throw new Error('Video artifact is too large')
      const parent = join(directory, artifact.documentId)
      const temporary = join(parent, '.' + randomUUID())
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      try {
        for (const [i, clip] of clips.entries()) await writeFile(join(temporary, `${i}.wav`), clip, { mode: 0o600 })
        await writeFile(join(temporary, 'video.json'), serialized, { mode: 0o600 })
        await rename(temporary, join(parent, artifact.id))
      } finally { await rm(temporary, { recursive: true, force: true }) }
    },
    async audio(documentId, id, index) {
      if (!Number.isInteger(index) || index < 0 || index > 9) return null
      const artifact = await get(documentId, id)
      if (!artifact?.speech.available || index >= artifact.scenes.length) return null
      return regularFile(join(directory, documentId, id, `${index}.wav`), 16 * 1024 * 1024)
    },
    async remove(documentId) {
      if (!validVideoId(documentId)) return
      await rm(join(directory, documentId), { recursive: true, force: true })
    },
  }
}
