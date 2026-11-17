const codeFile = /\.(?:[cm]?[jt]sx?|cts|mts|rs|go|py|rb|java|kts?|scala|swift|c|cc|cpp|cxx|h|hpp|cs|exs?|php|sh|lua|dart|zig|vue|svelte|sql|proto|graphql|elm|clj|fs|vb|r|jl|v|sv|sol|pl|pm)$/i
const manifest = /(?:^|\/)(?:Cargo\.toml|package\.json|go\.mod|pyproject\.toml|pom\.xml|build\.gradle(?:\.kts)?|requirements\.txt|Gemfile|Makefile|justfile|BUILD(?:\.bazel)?|MODULE\.bazel|Dockerfile|flake\.nix|tsconfig[^/]*\.json|pnpm-workspace\.yaml)$/i
const docs = /\.(?:mdx?|rst|adoc|txt)$/i
const textConfig = /\.(?:json|ya?ml|toml|xml|ini|cfg|properties)$/i
const maxBlobBytes = 2 * 1024 * 1024
const maxFiles = 90
const maxEvidence = 240
const skipDirectory = /(?:^|\/)(?:node_modules|vendor|target|dist|third_party|__snapshots__)(?:\/|$)/
const sensitiveFile = /(?:^|\/)(?:\.env(?:\.[^/]*)?|(?:credentials|secrets?)\.(?:json|toml|ya?ml)|id_(?:rsa|ed25519))(?:$|\/)/i

const text = { type: 'string' }
const integer = { type: 'integer' }

function tool(name, description, properties, required, execute) {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'object', properties: { data: text }, required: ['data'] },
      render: (_args, result) => [{ type: 'text', text: result.data }] },
    async execute(args, exec) { return { data: JSON.stringify(await execute(args, exec.signal)) } },
  }
}

export function repositoryTools(source, signal, onRead) {
  const files = new Map(source.tree.filter(entry => entry.type === 'blob' && /^100(?:644|755)$/.test(entry.mode)
    && !skipDirectory.test(entry.path) && !sensitiveFile.test(entry.path)
    && (codeFile.test(entry.path) || manifest.test(entry.path) || docs.test(entry.path) || textConfig.test(entry.path)))
    .map(entry => [entry.path, entry]))
  const cache = new Map()
  const evidence = []
  const evidenceIds = new Map()

  async function lines(path, callSignal) {
    const entry = files.get(path)
    if (!entry) return null
    if (!cache.has(path)) {
      if (cache.size >= maxFiles) return null
      const readSignal = AbortSignal.any([signal, callSignal])
      const bytes = await source.read(source.owner ? path : entry, maxBlobBytes, readSignal)
      if (!bytes?.length || bytes.includes(0)) return null
      cache.set(path, bytes.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/))
      onRead?.(cache.size, path)
    }
    return cache.get(path)
  }

  function snippet(path, body, start, count) {
    if (start < 1 || start > body.length) return null
    const texts = body.slice(start - 1, start - 1 + count).map(line => line.slice(0, 360))
    if (evidence.length >= maxEvidence && !evidenceIds.has(path + ':' + start + ':' + texts.length)) return null
    const end = start + texts.length - 1
    const primary = codeFile.test(path) || manifest.test(path) || /(?:^|\/)\.github\/workflows\//.test(path)
    const key = path + ':' + start + ':' + texts.length
    if (!evidenceIds.has(key)) {
      evidence.push({ path, start, end, text: texts.join('\n'), primary })
      evidenceIds.set(key, evidence.length)
    }
    return {
      evidence: evidenceIds.get(key), path, start, end, primary,
      lines: texts.map((line, i) => (i + start) + ' | ' + line).join('\n'),
    }
  }

  async function read({ path, start = 1, count = 72 }, callSignal) {
    const body = await lines(path, callSignal)
    const result = body && snippet(path, body, start, Math.max(1, Math.min(count, 95)))
    return result ? { ...result, availableLines: body.length } : { path, error: 'No readable lines in the requested range' }
  }

  const definitions = [
    tool('wiki_list', 'List immediate repository subdirectories and text/code files at the pinned commit. Pass match for recursive path substring search within directory.', { directory: text, match: text }, [],
      ({ directory = '', match = '' }) => {
        const prefix = directory.replace(/^\.?\/+|\/+$/g, '')
        const base = prefix ? prefix + '/' : ''
        const query = match.toLowerCase()
        const entries = new Set()
        for (const path of files.keys()) {
          if (!path.startsWith(base)) continue
          const relative = path.slice(base.length)
          if (query) {
            if (relative.toLowerCase().includes(query)) entries.add(path)
          } else {
            const slash = relative.indexOf('/')
            entries.add(slash < 0 ? path : base + relative.slice(0, slash + 1))
          }
        }
        const all = [...entries].sort()
        return { entries: all.slice(0, 80), total: all.length }
      }),
    tool('wiki_read', 'Read numbered lines of one file at the pinned commit. Start is one-based. Reference only the returned evidence ID and numbered lines. primary:false is guidance only.', { path: text, start: integer, count: integer }, ['path'],
      read),
    tool('wiki_read_batch', 'Read up to 6 related source ranges in one turn. Use this to follow imports and calls across files. Every range gets its own evidence ID.', {
      ranges: { type: 'array', maxItems: 6, items: {
        type: 'object', properties: { path: text, start: integer, count: integer }, required: ['path'], additionalProperties: false,
      } },
    }, ['ranges'], async ({ ranges }, callSignal) => {
      const results = []
      for (const range of ranges.slice(0, 6)) results.push(await read(range, callSignal))
      return { results }
    }),
    tool('wiki_find', 'Find a literal symbol or text in up to 10 specified files. Returns numbered source excerpts around matches. Supply repository-relative paths returned by wiki_list.', {
      query: text, paths: { type: 'array', items: text, maxItems: 10 },
    }, ['query', 'paths'],
    async ({ query, paths }, callSignal) => {
      const found = []
      const searched = []
      if (!query || query.length > 120) return { error: 'Use a nonempty literal query of at most 120 characters' }
      for (const path of paths.slice(0, 10)) {
        const body = await lines(path, callSignal)
        if (!body) continue
        searched.push(path)
        for (let index = 0; index < body.length && found.length < 10; index++) {
          if (!body[index].includes(query)) continue
          const item = snippet(path, body, Math.max(1, index - 3), 11)
          if (item) found.push(item)
          index += 5
        }
        if (found.length === 10) break
      }
      return { found, searched }
    }),
  ]
  return { evidence, definitions }
}
