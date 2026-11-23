const codeFile = /\.(?:[cm]?[jt]sx?|cts|mts|rs|go|py|rb|java|kts?|scala|swift|c|cc|cpp|cxx|h|hpp|cs|exs?|php|sh|lua|dart|zig|vue|svelte|sql|proto|graphql|elm|clj|fs|vb|r|jl|v|sv|sol|pl|pm)$/i
const manifest = /(?:^|\/)(?:Cargo\.toml|package\.json|go\.mod|pyproject\.toml|pom\.xml|build\.gradle(?:\.kts)?|requirements\.txt|Gemfile|Makefile|justfile|BUILD(?:\.bazel)?|MODULE\.bazel|Dockerfile|flake\.nix|tsconfig[^/]*\.json|pnpm-workspace\.yaml)$/i
const docs = /\.(?:mdx?|rst|adoc|txt)$/i
const textConfig = /\.(?:json|ya?ml|toml|xml|ini|cfg|properties)$/i
const maxBlobBytes = 2 * 1024 * 1024
const maxFiles = 90
const maxEvidence = 240
const maxSnippetCharacters = 24_000
const skipDirectory = /(?:^|\/)(?:node_modules|vendor|target|dist|third_party|__snapshots__)(?:\/|$)/
const sensitiveFile = /(?:^|\/)(?:\.env(?:\.[^/]*)?|(?:credentials|secrets?)\.(?:json|toml|ya?ml)|id_(?:rsa|ed25519))(?:$|\/)/i
const documentation = path => docs.test(path) || /(?:^|\/)readme(?:[._-][a-z]{2,3}(?:[._-][a-z]{2,4})?)?$/i.test(path)
const kindOf = path => codeFile.test(path) ? 'source' : manifest.test(path) ? 'config' : documentation(path) ? 'documentation' : 'config'
const primaryFile = path => codeFile.test(path) || manifest.test(path) || /(?:^|\/)\.github\/workflows\/.*\.ya?ml$/i.test(path)
const validPath = path => typeof path === 'string' && path.length <= 300 && !/[\\\u0000-\u001f\u007f]/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..')

const text = { type: 'string' }
const integer = { type: 'integer' }
const pagination = { offset: integer, limit: integer, cursor: text }

function page(args, maximum) {
  const cursor = args.cursor === undefined || args.cursor === '' ? undefined : /^\d+$/.test(args.cursor) ? Number(args.cursor) : NaN
  const offset = args.offset ?? cursor ?? 0
  const limit = args.limit ?? maximum
  return Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= maximum
    && (cursor === undefined || (Number.isSafeInteger(cursor) && cursor === offset)) ? { offset, limit } : null
}

function directoryPrefix(directory = '') {
  if (typeof directory !== 'string') return null
  const path = directory.replace(/^\.\//, '').replace(/\/$/, '')
  if (!path || path === '.') return ''
  return validPath(path) ? path + '/' : null
}

function pageInfo(total, offset, limit) {
  const nextOffset = offset + limit < total ? offset + limit : null
  return { total, offset, limit, nextOffset, nextCursor: nextOffset === null ? null : String(nextOffset) }
}

function tool(name, description, properties, required, execute, feedback) {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'object', properties: { data: text }, required: ['data'] },
      render: (_args, result) => [{ type: 'text', text: result.data }] },
    async execute(args, exec) { return { data: JSON.stringify({ ...await execute(args, exec.signal), ...feedback() }) } },
  }
}

export function repositoryTools(source, signal, onRead, initialEvidence = []) {
  const files = new Map(source.tree.filter(entry => entry.type === 'blob' && /^100(?:644|755)$/.test(entry.mode)
    && validPath(entry.path) && !skipDirectory.test(entry.path) && !sensitiveFile.test(entry.path)
    && (codeFile.test(entry.path) || manifest.test(entry.path) || documentation(entry.path) || textConfig.test(entry.path)))
    .map(entry => [entry.path, entry]))
  // Reserve the promise before I/O: simultaneous reads share both data and budget.
  const cache = new Map()
  if (initialEvidence.length > maxEvidence || initialEvidence.some(file => !files.has(file.path)
    || !Number.isSafeInteger(file.start) || !Number.isSafeInteger(file.end) || file.start < 1 || file.end < file.start
    || typeof file.text !== 'string' || file.text.split('\n').length !== file.end - file.start + 1)) {
    throw new TypeError('Invalid research checkpoint evidence')
  }
  const evidence = initialEvidence.map(file => ({ ...file, primary: primaryFile(file.path), kind: kindOf(file.path) }))
  const evidenceIds = new Map(evidence.map((file, i) => [file.path + ':' + file.start + ':' + (file.end - file.start + 1), i + 1]))
  const touchedFiles = new Set(evidence.map(file => file.path))
  const readableFiles = new Set(touchedFiles)
  if (touchedFiles.size > maxFiles) throw new TypeError('Research checkpoint exceeds the file budget')
  const feedback = () => ({
    budget: { files: { used: touchedFiles.size, limit: maxFiles, remaining: maxFiles - touchedFiles.size },
      evidence: { used: evidence.length, limit: maxEvidence, remaining: maxEvidence - evidence.length } },
    discovery: { eligibleFiles: files.size, treeComplete: source.treeComplete !== false,
      unvisitedDirectoryCount: source.unvisitedDirectories?.length ?? 0,
      unvisitedDirectories: (source.unvisitedDirectories ?? []).slice(0, 20) },
  })
  const define = (...args) => tool(...args, feedback)

  async function lines(path, callSignal) {
    const entry = files.get(path)
    if (!entry) return { error: 'Path is not an eligible regular file in the pinned commit', reason: 'ineligible-path' }
    if (!cache.has(path)) {
      if (!touchedFiles.has(path) && touchedFiles.size >= maxFiles) return { error: 'File read budget exhausted; reuse the files already read', reason: 'file-budget' }
      touchedFiles.add(path)
      const reading = Promise.resolve().then(async () => {
        const signals = [signal, callSignal].filter(Boolean)
        const readSignal = signals.length ? AbortSignal.any(signals) : undefined
        try {
          readSignal?.throwIfAborted()
          const target = source.owner ? path : entry
          const result = source.readWithMetadata ? await source.readWithMetadata(target, maxBlobBytes, readSignal)
            : { bytes: await source.read(target, maxBlobBytes, readSignal) }
          readSignal?.throwIfAborted()
          const bytes = result?.bytes
          if (!bytes?.length || bytes.includes(0)) return {
            error: result?.truncated && !bytes?.length ? 'No complete text line fits within the file read limit' : 'No readable UTF-8 text at the pinned commit',
            reason: 'unreadable-file', ...(result?.truncated && { fileTruncated: true }),
          }
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          const truncated = result.truncated ?? (Number.isSafeInteger(entry.size) ? entry.size > bytes.length : bytes.length >= maxBlobBytes)
          readableFiles.add(path)
          onRead?.(readableFiles.size, path)
          return { body: text.replace(/\r?\n$/, '').split(/\r?\n/), truncated,
            ...(Number.isSafeInteger(result.totalBytes ?? entry.size) && { totalBytes: result.totalBytes ?? entry.size }) }
        } catch {
          readSignal?.throwIfAborted()
          return { error: 'Unable to read UTF-8 text at the pinned commit', reason: 'read-failed' }
        }
      })
      cache.set(path, reading)
    }
    return cache.get(path)
  }

  function snippet(path, body, start, count, characterLimit = maxSnippetCharacters) {
    if (!Number.isSafeInteger(start) || start < 1 || start > body.length) return { error: 'No readable lines in the requested range', reason: 'line-range' }
    const texts = []
    let characters = 0
    for (const line of body.slice(start - 1, start - 1 + count)) {
      if (characters + line.length + 1 > characterLimit) break
      texts.push(line)
      characters += line.length + 1
    }
    if (!texts.length) return { error: 'This complete line exceeds the output limit; it has not been cited or shortened', reason: 'long-line', nextLine: start + 1 }
    const end = start + texts.length - 1
    const key = path + ':' + start + ':' + texts.length
    if (evidence.length >= maxEvidence && !evidenceIds.has(key)) return { error: 'Evidence budget exhausted; reuse existing evidence IDs', reason: 'evidence-budget' }
    const primary = primaryFile(path)
    const kind = kindOf(path)
    if (!evidenceIds.has(key)) {
      // text contains complete original lines, including lines longer than 360 characters.
      evidence.push({ path, start, end, text: texts.join('\n'), primary, kind })
      evidenceIds.set(key, evidence.length)
    }
    return { evidence: evidenceIds.get(key), path, start, end, primary, kind,
      lines: texts.map((line, i) => (i + start) + ' | ' + line).join('\n'),
      rangeTruncated: texts.length < Math.min(count, body.length - start + 1) }
  }

  async function read({ path, start = 1, count = 72 }, callSignal) {
    if (!Number.isSafeInteger(count) || count < 1) return { path, error: 'count must be a positive integer', reason: 'line-range' }
    const loaded = await lines(path, callSignal)
    if (loaded.error) return { path, ...loaded }
    const requested = Math.min(count, 95)
    const result = snippet(path, loaded.body, start, requested)
    const nextLine = result.evidence && result.end < loaded.body.length ? result.end + 1 : null
    return { path, ...result, availableLines: loaded.body.length, fileTruncated: loaded.truncated,
      ...(loaded.totalBytes !== undefined && { totalBytes: loaded.totalBytes }),
      ...(result.evidence && { nextLine, rangeTruncated: result.rangeTruncated || count > requested,
        truncated: loaded.truncated || result.rangeTruncated || count > requested }),
      ...(loaded.truncated && { note: 'Only a bounded file prefix was read; later lines are unavailable, not absent from the repository' }) }
  }

  const definitions = [
    define('wiki_list', 'List immediate repository subdirectories and eligible files at the pinned commit. match searches paths recursively inside directory. Paginate with offset/limit (up to 80), or nextCursor. Check discovery.treeComplete and remaining budgets.', { directory: text, match: text, ...pagination }, [],
      ({ directory = '', match = '', ...args }) => {
        const prefix = directoryPrefix(directory)
        const paging = page(args, 80)
        if (prefix === null || !paging || typeof match !== 'string' || match.length > 120) return { error: 'Use a relative directory and valid pagination (limit 1–80)' }
        const query = match.toLowerCase()
        const entries = new Set()
        const kinds = { source: 0, documentation: 0, config: 0 }
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue
          const relative = path.slice(prefix.length)
          if (query && !relative.toLowerCase().includes(query)) continue
          kinds[kindOf(path)]++
          const slash = relative.indexOf('/')
          entries.add(query || slash < 0 ? path : prefix + relative.slice(0, slash + 1))
        }
        const all = [...entries].sort()
        return { entries: all.slice(paging.offset, paging.offset + paging.limit), ...pageInfo(all.length, paging.offset, paging.limit), kinds }
      }),
    define('wiki_read', 'Read complete numbered lines at the pinned commit (default 72, maximum 95 per range). Only returned evidence IDs/lines may be cited. kind is source, documentation, or config; primary remains the implementation-evidence flag. Check fileTruncated, rangeTruncated, nextLine and budgets.', { path: text, start: integer, count: integer }, ['path'], read),
    define('wiki_read_batch', 'Read up to 6 source ranges, at most 3 files concurrently. Every returned range has its own evidence ID, original lines, kind and truncation feedback.', {
      ranges: { type: 'array', maxItems: 6, items: {
        type: 'object', properties: { path: text, start: integer, count: integer }, required: ['path'], additionalProperties: false,
      } },
    }, ['ranges'], async ({ ranges }, callSignal) => {
      const results = []
      for (let i = 0; i < Math.min(ranges.length, 6); i += 3) results.push(...await Promise.all(ranges.slice(i, i + 3).map(range => read(range, callSignal))))
      return { results }
    }),
    define('wiki_find', 'Find literal text in eligible files at the pinned commit. Supply paths (up to 10), or directory to discover and search files recursively. offset/limit or cursor paginate FILES (up to 10 per call), perFile limits excerpts per file (1–2, default 1). coverage reports every searched file; continue nextCursor to cover later files.', {
      query: text, paths: { type: 'array', items: text, maxItems: 10 }, directory: text, ...pagination, perFile: integer,
    }, ['query'], async ({ query, paths, directory = '', perFile = 1, ...args }, callSignal) => {
      const prefix = directoryPrefix(directory)
      const paging = page(args, 10)
      if (typeof query !== 'string' || !query || query.length > 120 || prefix === null || !paging || !Number.isInteger(perFile) || perFile < 1 || perFile > 2) return { error: 'Use a literal query up to 120 characters, relative directory, limit 1–10 and perFile 1–2' }
      if (paths !== undefined && (!Array.isArray(paths) || paths.length > 10)) return { error: 'paths must contain at most 10 repository-relative paths' }
      const candidates = paths ? [...new Set(paths)].filter(path => files.has(path) && path.startsWith(prefix))
        : [...files.keys()].filter(path => path.startsWith(prefix)).sort()
      const selected = candidates.slice(paging.offset, paging.offset + paging.limit)
      const found = []
      const searched = []
      const coverage = []
      const excerptLimit = Math.floor(maxSnippetCharacters / Math.max(1, selected.length * perFile))
      for (const path of selected) {
        const loaded = await lines(path, callSignal)
        if (loaded.error) { coverage.push({ path, ...loaded }); continue }
        searched.push(path)
        const matches = []
        let matchCount = 0
        for (let index = 0; index < loaded.body.length; index++) {
          if (!loaded.body[index].includes(query)) continue
          matchCount++
          if (matches.length < perFile) matches.push(index + 1)
        }
        let returned = 0
        for (const line of matches) {
          let start = Math.max(1, line - 3)
          // Reserve enough space for the matched complete line before adding context.
          while (start < line && loaded.body.slice(start - 1, line).reduce((sum, value) => sum + value.length + 1, 0) > excerptLimit) start++
          const item = snippet(path, loaded.body, start, 11, excerptLimit)
          if (item.evidence) { found.push({ ...item, matchLine: line }); returned++ }
        }
        coverage.push({ path, kind: kindOf(path), matchCount, returned, fileTruncated: loaded.truncated,
          matchesTruncated: matchCount > returned })
      }
      return { found, searched, coverage, ...pageInfo(candidates.length, paging.offset, paging.limit) }
    }),
  ]
  return { evidence, definitions }
}
