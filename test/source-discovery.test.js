import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { openGithubRepository, readPinnedGithubFile } from '../src/github-source.js'
import { openLocalRepository } from '../src/local-source.js'
import { repositoryTools } from '../skills/repo-design-wiki/scripts/repository-tools.mjs'

const repo = 'https://github.com/example/repo'
const commit = '1'.repeat(40)
const rootTree = 'a'.repeat(40)
const sha = number => number.toString(16).padStart(40, '0')
const blob = (path, size) => ({ path, type: 'blob', mode: '100644', sha: 'f'.repeat(40), ...(size === undefined ? {} : { size }) })
const tree = (path, id) => ({ path, type: 'tree', mode: '040000', sha: id })
const head = () => ({ sha: commit, commit: { tree: { sha: rootTree } } })

function tools(source) {
  const signal = new AbortController().signal
  const result = repositoryTools(source, signal)
  return { ...result, read: async args => JSON.parse((await result.definitions.find(tool => tool.name === 'wiki_read')
    .execute(args, { signal })).data) }
}

test('GitHub explicit commit never resolves default HEAD and all subsequent blob reads remain pinned', async t => {
  const content = 'first\n' + 'x'.repeat(800) + '\nlast\n'
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url)
    if (url === 'https://api.github.com/repos/example/repo/commits/' + commit) return Response.json(head())
    if (url === 'https://api.github.com/repos/example/repo/git/trees/' + rootTree + '?recursive=1') {
      return Response.json({ tree: [blob('src/main.js', Buffer.byteLength(content))], truncated: false })
    }
    assert.equal(url, 'https://raw.githubusercontent.com/example/repo/' + commit + '/src/main.js')
    return new Response(content)
  })
  const source = await openGithubRepository(repo, { commit })
  assert.equal(source.commit, commit)
  assert.equal(source.treeComplete, true)
  assert(!calls.some(url => url.includes('commits?')))
  const meta = await source.readWithMetadata('src/main.js', 64)
  assert.equal(meta.truncated, true)
  assert.equal(meta.bytes.toString(), 'first\n')
  const old = await source.read('src/main.js', 64)
  assert(Buffer.isBuffer(old))
  assert.deepEqual(old, meta.bytes)
  assert.deepEqual(await readPinnedGithubFile(repo, commit, 'src/main.js', 64), old)
  const api = tools(source)
  const exact = await api.read({ path: 'src/main.js', start: 2, count: 1 })
  assert.equal(api.evidence[exact.evidence - 1].text, 'x'.repeat(800))
  assert.equal(exact.start, 2)
  assert.equal(exact.fileTruncated, false)
})

test('GitHub rejects malformed and mismatched pinned commits instead of silently following another revision', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...head(), sha: '2'.repeat(40) }))
  for (const value of ['main', '../HEAD', '', 'a'.repeat(39), null]) {
    await assert.rejects(openGithubRepository(repo, { commit: value }), error => error.code === 'invalid-repository-commit')
  }
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(openGithubRepository(repo, { commit }), error => error.code === 'github-request-failed')
  assert.equal(fetch.mock.callCount(), 1)
})

test('truncated recursive GitHub trees recover later application directories and nested files breadth first', async t => {
  const routes = new Map([
    [rootTree, [tree('a', sha(2)), tree('z-app', sha(3)), tree('.github', sha(4))]],
    [sha(2), [blob('early.js')]],
    [sha(3), [tree('nested', sha(5)), blob('app.js')]],
    [sha(4), [blob('config.yml')]],
    [sha(5), [blob('actual.js')]],
  ])
  let requests = 0
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/commits?per_page=1')) return Response.json([head()])
    const parsed = new URL(url)
    assert(parsed.pathname.startsWith('/repos/example/repo/git/trees/'))
    requests++
    if (parsed.search) return Response.json({ truncated: true, tree: [tree('a', sha(2)), blob('a/early.js')] })
    const entries = routes.get(parsed.pathname.split('/').at(-1))
    assert(entries, 'only pinned tree IDs may be requested')
    return Response.json({ tree: entries, truncated: false })
  })
  const source = await openGithubRepository(repo)
  assert.equal(source.commit, commit)
  assert.equal(source.treeComplete, true)
  assert.deepEqual(source.unvisitedDirectories, [])
  assert(source.tree.some(entry => entry.path === 'z-app/nested/actual.js'))
  assert(source.tree.some(entry => entry.path === '.github/config.yml'))
  assert.equal(requests, 6)
})

test('GitHub tree traversal is bounded and discloses directories that were not completely discovered', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/commits?per_page=1')) return Response.json([head()])
    requests++
    const parsed = new URL(url)
    if (parsed.search) return Response.json({ tree: [], truncated: true })
    if (parsed.pathname.endsWith('/' + rootTree)) return Response.json({ tree: Array.from({ length: 70 }, (_, i) =>
      tree('package-' + String(i).padStart(2, '0'), sha(i + 10))), truncated: false })
    return Response.json({ tree: [blob('main.js')], truncated: false })
  })
  const source = await openGithubRepository(repo)
  assert.equal(requests, 64)
  assert.equal(source.treeComplete, false)
  assert.equal(source.unvisitedDirectories.length, 8)
  assert(source.unvisitedDirectories.includes('package-69'))
  const list = repositoryTools(source, new AbortController().signal).definitions.find(tool => tool.name === 'wiki_list')
  const result = JSON.parse((await list.execute({}, { signal: new AbortController().signal })).data)
  assert.equal(result.discovery.treeComplete, false)
  assert.equal(result.discovery.unvisitedDirectoryCount, 8)
})

test('local pinned Git blobs expose complete-prefix truncation and preserve complete long source lines', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-source-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const exec = promisify(execFile)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  const git = args => exec('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, env, windowsHide: true })
  await git(['init', '--quiet'])
  await mkdir(join(directory, 'src'))
  const original = 'first\r\n' + 'x'.repeat(800) + '\r\nlast\r\n'
  await writeFile(join(directory, 'src', 'main.js'), original)
  await git(['add', '--all'])
  await git(['-c', 'user.name=Source Test', '-c', 'user.email=source-test@example.com', '-c', 'core.autocrlf=false',
    'commit', '--quiet', '-m', 'fixture'])
  const source = await openLocalRepository(directory)
  const entry = source.tree.find(entry => entry.path === 'src/main.js')
  await writeFile(join(directory, 'src', 'main.js'), 'changed worktree\n')
  const meta = await source.readWithMetadata(entry, 64)
  assert.equal(meta.truncated, true)
  assert.equal(meta.totalBytes, Buffer.byteLength(original))
  assert.equal(meta.bytes.toString(), 'first\r\n')
  assert.deepEqual(await source.read(entry, 64), meta.bytes)
  const api = tools(source)
  const exact = await api.read({ path: 'src/main.js', start: 2, count: 1 })
  assert.equal(exact.start, 2)
  assert.equal(exact.fileTruncated, false)
  assert.equal(api.evidence[exact.evidence - 1].text, 'x'.repeat(800))
  const limited = tools({ ...source, readWithMetadata: (entry, _bytes, signal) => source.readWithMetadata(entry, 64, signal) })
  const bounded = await limited.read({ path: 'src/main.js' })
  assert.equal(bounded.fileTruncated, true)
  assert.equal(bounded.availableLines, 1)
  assert.equal(limited.evidence[bounded.evidence - 1].text, 'first')
  assert.equal((await limited.read({ path: 'src/main.js', start: 2 })).reason, 'line-range')
})
