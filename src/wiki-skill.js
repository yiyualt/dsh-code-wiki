import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const name = 'repo-design-wiki'
const maxBytes = 32 * 1024
const bundled = new URL('../skills/repo-design-wiki/', import.meta.url)

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

function skillContent(text) {
  const document = /^---\n([\s\S]+?)\n---\n([\s\S]+)$/.exec(text)
  const names = document && Array.from(document[1].matchAll(/^name:[ \t]*(.+)$/gm), match => match[1].trim())
  if (names?.length !== 1 || ![name, `'${name}'`, `"${name}"`].includes(names[0])
    || !/^description:[ \t]*\S/m.test(document[1]) || !document[2].trim()) {
    throw skillError('SKILL.md 需要匹配的 name、description 和正文。')
  }
  return document[2].trim()
}

export async function loadWikiSkill(home, signal) {
  if (home !== undefined && (typeof home !== 'string' || !isAbsolute(home))) throw skillError('无法定位 DSH 技能目录。')
  const installed = home === undefined ? undefined : join(home, 'skills', name)
  const entry = installed === undefined ? undefined : await readText(join(installed, 'SKILL.md'), 'SKILL.md', signal, true)
  const root = entry === undefined ? bundled : installed
  const resource = path => typeof root === 'string' ? join(root, path) : new URL(path, root)
  const content = skillContent(entry ?? await readText(resource('SKILL.md'), 'SKILL.md', signal))
  const guide = await readText(resource('references/diagrams.md'), 'references/diagrams.md', signal)
  return { name, content, guide: guide.trim(), source: entry === undefined ? 'bundled' : 'installed' }
}
