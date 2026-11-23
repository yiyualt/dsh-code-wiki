import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'repo-design-wiki'
const provider = 'dsh-code-wiki'
const maxBytes = 32 * 1024
const bundled = new URL('../skills/repo-design-wiki/', import.meta.url)
const bundledEntry = fileURLToPath(new URL('SKILL.md', bundled))
const bundledRank = 600 // Same precedence as DSH's bundled skill directory.

function skillError(message, cause) {
  return Object.assign(new Error(`代码百科 Skill ${name}：${message}`, { cause }), { code: 'wiki-skill-invalid' })
}

async function readText(path, label, signal, optional = false) {
  signal?.throwIfAborted()
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw skillError(`${label} 必须是 32 KiB 以内的普通文件。`)

    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    signal?.throwIfAborted()
    if (length > maxBytes) throw skillError(`${label} 必须是 32 KiB 以内的普通文件。`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)).replace(/\r\n?/g, '\n')
    if (!text.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw skillError(`${label} 必须包含有效文字。`)
    return text
  } catch (error) {
    signal?.throwIfAborted()
    if (optional && error?.code === 'ENOENT' && !handle) return undefined
    if (error?.code === 'wiki-skill-invalid') throw error
    throw skillError(`无法读取 ${label}。`, error)
  } finally {
    await handle?.close()
  }
}

function parseSkill(text) {
  const document = /^---\n([\s\S]+?)\n---\n([\s\S]+)$/.exec(text)
  const names = document && Array.from(document[1].matchAll(/^name:[ \t]*(.+)$/gm), match => match[1].trim())
  const description = document && /^description:[ \t]*(\S[^\n]*)/m.exec(document[1])?.[1].trim()
  if (names?.length !== 1 || ![name, `'${name}'`, `"${name}"`].includes(names[0])
    || !description || !document[2].trim()) {
    throw skillError('SKILL.md 需要匹配的 name、description 和正文。')
  }
  return { description, content: document[2].trim() }
}

function bundledSummary(description) {
  return {
    name, description, provider, source: 'bundled', path: bundledEntry,
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: dirname(bundledEntry).split(sep).join('/') },
  }
}

export function registerWikiSkill(skills) {
  return skills?.registerProvider(() => ({
    name: provider,
    async list({ signal }) {
      const { description } = parseSkill(await readText(bundledEntry, 'SKILL.md', signal))
      return [{ ...bundledSummary(description), rank: bundledRank, locator: bundledEntry }]
    },
    async get(_candidate, { signal }) {
      const { description, content } = parseSkill(await readText(bundledEntry, 'SKILL.md', signal))
      return { ...bundledSummary(description), content }
    },
  }))
}

export async function loadWikiSkill(home, signal) {
  if (home !== undefined && (typeof home !== 'string' || !isAbsolute(home))) throw skillError('无法定位 DSH 技能目录。')
  const installed = home === undefined ? undefined : join(home, 'skills', name)
  const entry = installed === undefined ? undefined : await readText(join(installed, 'SKILL.md'), 'SKILL.md', signal, true)
  const root = entry === undefined ? bundled : installed
  const resource = path => typeof root === 'string' ? join(root, path) : new URL(path, root)
  const { content } = parseSkill(entry ?? await readText(resource('SKILL.md'), 'SKILL.md', signal))
  const guide = await readText(resource('references/diagrams.md'), 'references/diagrams.md', signal)
  return { name, content, guide: guide.trim(), source: entry === undefined ? 'bundled' : 'installed' }
}
