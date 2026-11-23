const pageSize = 80
const readLimit = 40
const rangeLimit = 120
const snippetLimit = 8_000
const replyLimit = 24_000
const sourceLimit = 16
const outputSchema = { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] }

function tool(name, description, properties, required, run) {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: outputSchema, render: (_args, result) => [{ type: 'text', text: result.data }] },
    async execute(args, options) {
      return { data: JSON.stringify(await run(args, options?.signal)) }
    },
  }
}

function listPaths(repository, { directory = '', match = '', offset = 0 }) {
  if (typeof directory !== 'string' || directory.length > 300 || typeof match !== 'string' || match.length > 120
    || !Number.isSafeInteger(offset) || offset < 0) return { error: '请提供有效的仓库目录、匹配词和分页位置。' }
  const prefix = directory === '' || directory === '.' ? '' : directory.replace(/\/$/, '') + '/'
  const query = match.toLowerCase()
  const entries = new Set()
  for (const path of repository.paths) {
    if (!path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    if (!relative || (query && !relative.toLowerCase().includes(query))) continue
    const separator = relative.indexOf('/')
    entries.add(query || separator < 0 ? path : prefix + relative.slice(0, separator + 1))
  }

  const paths = [...entries].sort()
  return {
    paths: paths.slice(offset, offset + pageSize),
    nextOffset: offset + pageSize < paths.length ? offset + pageSize : null,
    treeComplete: repository.treeComplete !== false,
  }
}

function repositoryTools(repository, signal) {
  const paths = new Set(repository.paths)
  const cache = new Map()
  const evidence = new Map()
  let remainingReads = readLimit

  async function read({ path, start = 1, count = 72 }, callSignal) {
    if (!paths.has(path)) return { error: '只能读取 wiki_list 中可见的仓库文件。' }
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > rangeLimit) {
      return { error: `起始行号必须大于零，每次读取 1 到 ${rangeLimit} 行。` }
    }
    if (!remainingReads) return { error: '已用完读取次数，请使用已取得的证据完成结果。' }
    remainingReads -= 1
    const readSignal = signal && callSignal ? AbortSignal.any([signal, callSignal]) : signal ?? callSignal
    readSignal?.throwIfAborted()
    if (!cache.has(path)) {
      const loading = Promise.resolve().then(async () => {
        const text = await repository.read(path, readSignal)
        return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
      })
      cache.set(path, loading)
    }
    let lines
    try {
      lines = await cache.get(path)
    } catch {
      cache.delete(path)
      readSignal?.throwIfAborted()
      return { error: '无法读取该文件的文本。请选择其他源码位置。', path, remainingReads }
    }
    readSignal?.throwIfAborted()
    if (start > lines.length) return { error: '起始行超出已读取的文件范围。', path, availableLines: lines.length }

    const excerpt = []
    let characters = 0
    for (const line of lines.slice(start - 1, start - 1 + count)) {
      const numbered = `${start + excerpt.length} | ${line}`
      if (characters + numbered.length + 1 > snippetLimit) break
      excerpt.push(numbered)
      characters += numbered.length + 1
    }
    if (!excerpt.length) return { error: '该行过长，请从下一行开始读取。', path, nextLine: start + 1 }
    const end = start + excerpt.length - 1
    if (!evidence.has(path)) evidence.set(path, [])
    evidence.get(path).push({ start, end })
    return { path, start, end, lines: excerpt.join('\n'), nextLine: end < lines.length ? end + 1 : null, remainingReads }
  }

  const string = { type: 'string' }
  const integer = { type: 'integer' }
  return {
    evidence,
    tools: [
      tool('wiki_list', '列出已固定提交中的目录和可读文件。设定 match 可在目录内按路径递归匹配，使用 nextOffset 翻页。',
        { directory: string, match: string, offset: integer }, [], args => listPaths(repository, args)),
      tool('wiki_read', `读取已固定提交中的源码行。默认从第 1 行读 72 行，每次最多 ${rangeLimit} 行。引用须落在实际返回的 start 至 end 范围内。`,
        { path: string, start: integer, count: integer }, ['path'], read),
    ],
  }
}

export function singleLine(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= maxLength && !/[\r\n\u2028\u2029]/.test(text) ? text : ''
}

export function readSources(sources, evidence) {
  if (!Array.isArray(sources) || !sources.length || sources.length > sourceLimit || sources.some(source =>
    !Number.isSafeInteger(source?.line) || !evidence.get(source?.path)?.some(range =>
      source.line >= range.start && source.line <= range.end))) return null
  return sources.map(({ path, line }) => ({ path, line }))
}

function parseReply(response, invalid) {
  if (typeof response !== 'string' || !response.trim() || response.length > replyLimit) {
    throw invalid('结果为空或过长。')
  }
  const text = response.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text)
  let result
  try {
    result = JSON.parse(fenced?.[1] ?? text)
  } catch {
    throw invalid('结果必须是一个 JSON 对象。')
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid('结果必须是一个 JSON 对象。')
  return result
}

export async function generateFromRepository({ repository, openAuthor, signal, prompt, parse, code }) {
  const { tools, evidence } = repositoryTools(repository, signal)
  const invalid = message => Object.assign(new Error(message), { code })
  const parseResponse = response => {
    signal?.throwIfAborted()
    return parse(parseReply(response, invalid), evidence, invalid)
  }

  signal?.throwIfAborted()
  const author = await openAuthor({ tools, signal })
  try {
    const response = await author.reply(prompt)
    try {
      return parseResponse(response)
    } catch (error) {
      if (error?.code !== code) throw error
      const corrected = await author.reply(
        `${error.message} 请根据已读源码修正结果。必要时先用工具补充证据，然后只返回符合约定的 JSON 对象。`,
      )
      return parseResponse(corrected)
    }
  } finally {
    await author.dispose()
  }
}
