import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export async function readPreview(directory, signal) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new Error('示例文档需要有效的 Skill 目录。')
  }

  const text = await readFile(join(directory, 'references', 'preview.md'), { encoding: 'utf8', signal })
  const chapters = []
  let fence

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
        fence = undefined
      }
    } else if (delimiter && (delimiter[1][0] === '~' || !delimiter[2].includes('`'))) {
      fence = delimiter[1]
    } else {
      const heading = /^ {0,3}##[ \t]+(.*)$/.exec(line)
      if (heading) {
        const title = heading[1].trim().replace(/(?:^|[ \t]+)#+$/, '')
        chapters.push({ title, lines: [] })
        continue
      }
    }
    chapters.at(-1)?.lines.push(line)
  }

  const result = chapters.map(({ title, lines }) => ({ title, markdown: lines.join('\n').trim() }))
  if (fence || !result.length || new Set(result.map(({ title }) => title)).size !== result.length
    || result.some(({ title, markdown }) => !title || !markdown)) {
    throw new Error('示例文档需要至少一个二级章节，每章须有正文且标题互不重复。')
  }

  return result
}
