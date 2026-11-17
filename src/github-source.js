import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const apiBase = 'https://api.github.com'
const rawBase = 'https://raw.githubusercontent.com'
const runGit = promisify(execFile)
const maxTreeBytes = 12 * 1024 * 1024
export const maxBlobBytes = 96 * 1024
const maxExcerptCharacters = 2_500
const maxExcerptLines = 120
const requestTimeout = 30_000
const batchSize = 5

const objectId = /^[0-9a-f]{40}$/i
const manifestNames = /^(?:package\.json|Cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|mix\.exs|Gemfile|composer\.json|deno\.jsonc?|pubspec\.yaml|Package\.swift|.+\.slnx?)$/i
const localBuildFiles = /^(?:justfile|Makefile|Taskfile\.ya?ml|CMakeLists\.txt|BUILD\.bazel|MODULE\.bazel|WORKSPACE(?:\.bazel)?|pnpm-workspace\.yaml|rust-toolchain(?:\.toml)?|\.tool-versions|\.nvmrc|\.bazelrc|\.bazelversion|Dockerfile|flake\.nix)$/i
const readmeName = /^readme(?:\.(?:md|mdx|rst|adoc|txt))?$/i
const architectureName = /^(?:architecture|design|overview|project-structure|repository-layout)\.(?:md|mdx|rst|adoc)$/i
const sourceFile = /\.(?:[cm]?[jt]sx?|cts|mts|rs|go|py|rb|java|kts?|scala|swift|c|cc|cpp|cxx|cs|exs?|php|sh)$/i
const lowPriorityFolder = /^(?:\.|_?tests?$|__tests__$|fixtures?$|examples?$|samples?$|benchmarks?$|vendor$|third[_-]?party$|dist$|target$|node_modules$|generated$|docs?$)/i
const sourceFolder = /^(?:src|lib|bin|cmd)$/i
const entryPoint = /^(?:main|index|lib|mod|app|server|cli|runtime|engine|__init__)\.[^.]+$/i

function sourceError(code, message) {
  return Object.assign(new Error(message), { code })
}

function invalidUrl() {
  return sourceError('invalid-repository-url', '请输入公开 GitHub 仓库地址，例如 https://github.com/openai/codex。')
}

function parseRepository(repositoryUrl) {
  if (typeof repositoryUrl !== 'string') throw invalidUrl()
  const match = /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]{1,100})\/?$/i.exec(repositoryUrl.trim())
  if (!match) throw invalidUrl()
  const [, owner, name] = match
  const repo = name.replace(/\.git$/i, '')
  if (!repo || repo === '.' || repo === '..') throw invalidUrl()
  return { owner, repo }
}

function requestFailed() {
  return sourceError('github-request-failed', '无法完成 GitHub 仓库读取，请稍后重试。')
}

async function readGitHub(url, signal, { bytes, raw = false }) {
  try {
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: {
        Accept: raw ? 'text/plain' : 'application/vnd.github+json',
        'User-Agent': 'dsh-code-wiki',
        ...(raw ? {} : { 'X-GitHub-Api-Version': '2022-11-28' }),
      },
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')) {
        throw sourceError('github-rate-limited', 'GitHub 公共 API 请求受限，请稍后重试。')
      }
      if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
        if (raw) return null
        throw sourceError('repository-unavailable', '找不到公开仓库，请核对 GitHub 上的当前仓库地址。')
      }
      if (response.status === 409) {
        throw sourceError('repository-no-evidence', '仓库中没有可读取的提交。')
      }
      throw requestFailed()
    }

    const chunks = []
    let received = 0
    for await (const chunk of response.body) {
      if (received + chunk.byteLength > bytes) {
        if (!raw) throw requestFailed()
        chunks.push(chunk.subarray(0, bytes - received))
        const prefix = Buffer.concat(chunks, bytes)
        return prefix.subarray(0, prefix.lastIndexOf(10) + 1)
      }
      received += chunk.byteLength
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks, received)
    if (raw) return buffer
    return JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    if (typeof error?.code === 'string' && (error.code.startsWith('github-') || error.code.startsWith('repository-'))) throw error
    throw requestFailed()
  }
}

function compareFiles(a, b) {
  return a.priority - b.priority || a.path.localeCompare(b.path, 'en')
}

function modulePriority(module) {
  const parts = module.split('/')
  const name = parts.at(-1)
  // Prefer product components over their nested helpers or auxiliary tool UIs.
  if (parts.length > 2) return 5
  if (/^(?:core|engine|runtime|kernel|orchestrator)$/i.test(name)) return 0
  if (/^(?:cli|tui|app-server|application|server|frontend|backend|ui|api)$/i.test(name)) return 1
  if (/^sdk\//i.test(module) || /^[^/]+-cli$/i.test(module)) return 2
  if (module === '.' || /^(?:agent|client|exec|runner|config|plugins?|storage|web|sdk)$/i.test(name)) return 3
  return 4
}

function moduleFile(components) {
  const basename = components.at(-1)
  const parent = components.slice(0, -1)
  if (parent.some(part => lowPriorityFolder.test(part))) return
  const anchor = parent.findIndex(part => sourceFolder.test(part))
  const folder = anchor < 0 ? parent : parent.slice(0, anchor)
  if (anchor === 0 && parent.length > 1) folder.push(...parent.slice(0, 2))
  const module = folder.join('/') || '.'
  if (folder.length > 3 || parent.length > 5) return
  if (manifestNames.test(basename) && parent.length) return { module: parent.join('/'), priority: 4 }
  if (!sourceFile.test(basename) || /(?:\.d\.ts$|^test_|[._-](?:test|spec)\.)/i.test(basename)) return
  const atSourceRoot = parent.length - folder.length <= 1
  if (atSourceRoot && (entryPoint.test(basename) || folder.length === 1 && parent.at(-1) === 'bin')) {
    // Library entry points often name internal components, while CLI mains expose dispatch.
    const prefersMain = /(?:^|[/\-])cli$/i.test(module)
    const preferred = prefersMain ? /^main\./i : /^(?:lib|index)\./i
    return { module, priority: preferred.test(basename) ? 0 : 1 }
  }
  return { module, priority: atSourceRoot ? 3 : 5 }
}

function fileGroup(path, components) {
  const basename = components.at(-1)
  if (components.length === 1 && readmeName.test(basename)) return { group: 'docs', priority: 0 }
  if (/^(?:docs\/|\.github\/)?contributing(?:\.[^.\/]+)?$/i.test(path)) return { group: 'docs', priority: 1 }
  if (/^docs\/(?:development|developer-guide)(?:\/index)?\.md$/i.test(path)) return { group: 'docs', priority: 2 }
  if (/^\.github\/workflows\/readme\.md$/i.test(path)) return { group: 'docs', priority: 3 }
  if (architectureName.test(basename) && (components.length === 1 || /^docs\//i.test(path))) {
    return { group: 'architecture', priority: components.length - 1 }
  }
  const parent = components.slice(0, -1)
  if (readmeName.test(basename) && parent.length && parent.length <= 3 && !parent.some(part => lowPriorityFolder.test(part))) {
    const priority = modulePriority(parent.join('/'))
    if (priority <= 2) return { group: 'architecture', priority: 10 + priority }
  }
  if (components.length === 3 && path.startsWith('.github/workflows/') && /\.ya?ml$/i.test(basename)) {
    if (/^(?:blocking-ci|ci|test|tests|build|repo-checks)\.ya?ml$/i.test(basename)) return { group: 'workflows', priority: 0 }
    if (/(?:^|[-_])(?:ci|tests?|build)(?:[-_]|\.)/i.test(basename)) return { group: 'workflows', priority: 1 }
    return { group: 'workflows', priority: 2 }
  }
  if (components.length <= 2 && manifestNames.test(basename)) {
    const priority = components.length === 1 ? 0 : /^(?:Cargo\.toml|go\.mod)$/i.test(basename) ? 1 : 2
    return { group: 'manifests', priority }
  }
  if (components.length === 1 && localBuildFiles.test(path)) {
    return { group: 'build', priority: /^(?:justfile|Makefile|Taskfile\.ya?ml|CMakeLists\.txt|pnpm-workspace\.yaml|BUILD\.bazel)$/i.test(path) ? 0 : 1 }
  }
}

export function selectFiles(tree) {
  const groups = { docs: [], architecture: [], manifests: [], build: [], workflows: [] }
  const modules = new Map()
  for (const entry of tree) {
    const { path, type, mode, size, sha } = entry
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || size === 0) continue
    if (typeof path !== 'string' || path.length > 300 || /[\u0000-\u001f\u007f]/.test(path)) continue
    const components = path.split('/')
    if (components.some(part => !part || part === '.' || part === '..')) continue
    const entryGroup = fileGroup(path, components)
    if (entryGroup) groups[entryGroup.group].push({ path, sha, ...entryGroup })
    const component = moduleFile(components)
    if (!component) continue
    const candidate = { path, sha, group: 'modules', ...component }
    const previous = modules.get(component.module)
    if (!previous || compareFiles(candidate, previous) < 0) modules.set(component.module, candidate)
  }
  const overview = [
    ...groups.docs.sort(compareFiles).slice(0, 2),
    ...groups.architecture.sort(compareFiles).slice(0, 2),
    ...groups.manifests.sort(compareFiles).slice(0, 2),
  ]
  const development = [
    ...groups.build.sort(compareFiles).slice(0, 2),
    ...groups.workflows.sort(compareFiles).slice(0, 3),
  ]
  const alreadySelected = new Set([...overview, ...development].map(({ path }) => path))
  const componentSources = [...modules.values()].filter(({ path }) => !alreadySelected.has(path))
    .sort((a, b) => modulePriority(a.module) - modulePriority(b.module) || compareFiles(a, b))
  return [...overview, ...componentSources.slice(0, 8), ...development]
}

export function excerpt(buffer) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return ''
  }
  if (text.includes('\0')) return ''
  const lines = text.replaceAll('\r\n', '\n').replace(/\n$/, '').split('\n').slice(0, maxExcerptLines)
  const included = []
  let length = 0
  for (const line of lines) {
    length += line.length + 1
    if (length > maxExcerptCharacters) break
    included.push(line)
  }
  const result = included.join('\n')
  return result.trim() ? result : ''
}

async function readTree(base, treeId, signal) {
  const params = { bytes: maxTreeBytes }
  const result = await readGitHub(`${base}/git/trees/${treeId}?recursive=1`, signal, params)
  if (!Array.isArray(result.tree)) throw requestFailed()
  if (!result.truncated) return result.tree

  // Recover the root and workflow entries when GitHub caps the recursive listing.
  const entries = new Map(result.tree.map(entry => [entry.path, entry]))
  const root = await readGitHub(`${base}/git/trees/${treeId}`, signal, params)
  if (!Array.isArray(root.tree)) throw requestFailed()
  for (const entry of root.tree) entries.set(entry.path, entry)
  const github = root.tree.find(entry => entry.path === '.github' && entry.type === 'tree')
  if (!github || !objectId.test(github.sha)) return [...entries.values()]
  const subtree = await readGitHub(`${base}/git/trees/${github.sha}?recursive=1`, signal, params)
  if (!Array.isArray(subtree.tree)) throw requestFailed()
  for (const entry of subtree.tree) {
    const path = `.github/${entry.path}`
    entries.set(path, { ...entry, path })
  }
  return [...entries.values()]
}

async function readApiSnapshot(owner, repo, signal) {
  const base = `${apiBase}/repos/${owner}/${repo}`
  // Without a branch argument GitHub lists commits from the default branch.
  const commits = await readGitHub(`${base}/commits?per_page=1`, signal, { bytes: 256 * 1024 })
  const head = Array.isArray(commits) ? commits[0] : undefined
  const commit = head?.sha
  const treeId = head?.commit?.tree?.sha
  if (typeof commit !== 'string' || typeof treeId !== 'string' || !objectId.test(commit) || !objectId.test(treeId)) throw requestFailed()
  return { commit, tree: await readTree(base, treeId, signal) }
}

async function readGitSnapshot(owner, repo, signal) {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-code-wiki-'))
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|SSH_ASKPASS$)/i.test(key)))
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GIT_NO_LAZY_FETCH: '1',
    })
    const config = [
      '-c', 'credential.helper=',
      '-c', `core.hooksPath=${devNull}`,
      '-c', 'http.followRedirects=false',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.version=2',
    ]
    const options = { cwd: temp, env, signal, maxBuffer: maxTreeBytes, windowsHide: true }
    const git = (...args) => runGit('git', [...config, ...args], options)
    await git('clone', '--quiet', '--no-checkout', '--depth=1', '--no-tags', '--filter=blob:none',
      '--single-branch', '--template=', '--', `https://github.com/${owner}/${repo}.git`, 'repo')
    const commit = (await git('-C', 'repo', 'rev-parse', '--verify', 'HEAD^{commit}')).stdout.trim()
    if (!objectId.test(commit)) throw requestFailed()
    // Avoid the long format in the partial clone because it needs blob sizes.
    const { stdout } = await git('-C', 'repo', 'ls-tree', '-r', '-z', commit)
    const tree = []
    for (const entry of stdout.split('\0')) {
      if (!entry) continue
      const separator = entry.indexOf('\t')
      const [mode, type] = entry.slice(0, separator).split(' ')
      tree.push({ mode, type, path: entry.slice(separator + 1) })
    }
    return { commit, tree }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export async function openGithubRepository(repositoryUrl, { signal } = {}) {
  const { owner, repo } = parseRepository(repositoryUrl)
  const deadline = AbortSignal.timeout(requestTimeout)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  let snapshot
  try {
    snapshot = await readApiSnapshot(owner, repo, requestSignal)
  } catch (error) {
    if (error.code !== 'github-rate-limited' || requestSignal.aborted) throw error
    try {
      snapshot = await readGitSnapshot(owner, repo, requestSignal)
    } catch {
      throw error
    }
  }

  const { commit, tree } = snapshot
  const ref = `${rawBase}/${owner}/${repo}/${commit}`
  return {
    owner, repo, commit, tree,
    read(path, bytes, readSignal = signal) {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/')
      const timeout = AbortSignal.timeout(requestTimeout)
      return readGitHub(`${ref}/${encodedPath}`, readSignal ? AbortSignal.any([readSignal, timeout]) : timeout, { raw: true, bytes })
    },
  }
}

export async function collectGithubSource(repositoryUrl, { signal } = {}) {
  const source = await openGithubRepository(repositoryUrl, { signal })
  const candidates = selectFiles(source.tree)
  const files = []
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = await Promise.all(candidates.slice(index, index + batchSize).map(async ({ path, group, module }) => {
      const bytes = await source.read(path, maxBlobBytes)
      return { path, text: bytes ? excerpt(bytes) : '', group, ...(module && { module }) }
    }))
    files.push(...batch.filter(file => file.text))
  }
  if (!files.length) {
    throw sourceError('repository-no-evidence', '该提交中没有找到可读取的源码、项目文档或开发配置。')
  }
  return { owner: source.owner, repo: source.repo, commit: source.commit, files }
}
