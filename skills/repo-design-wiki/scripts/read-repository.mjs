import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execGit = promisify(execFile)
const treeLimit = 12 * 1024 * 1024
const fileLimit = 128 * 1024
const gitHubId = /^[a-f0-9]{40}$/i
const gitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const regularModes = new Set(['100644', '100755'])
const sensitivePart = /^(?:\.git$|\.(?:ssh|aws|gnupg|kube|npmrc|pypirc|netrc)(?:[._-]|$)|\.env(?:[._-]|$)|id_(?:rsa|dsa|ecdsa|ed25519)|(?:secrets?|credentials?|private[-_]key)(?:[._-]|$))/i
const privateFile = /\.(?:key|pem|p12|pfx|jks|keystore|kdbx)$/i
const sourceName = /\.(?:[cm]?[jt]sx?|rs|go|py|pyi|rb|java|kt|kts|scala|swift|c|cc|cpp|cxx|h|hh|hpp|cs|exs?|php|lua|sh|bash|zsh|fish|ps1|vue|svelte|css|scss|html|sql|proto|graphql|toml|ya?ml|jsonc?|ini|cfg|properties|xml|mdx?|rst|adoc|txt|gradle|bazel|slnx?|csproj)$/i
const projectFile = /^(?:readme|license|copying|contributing|makefile|justfile|gemfile|rakefile|dockerfile(?:\.[^.]+)?|go\.mod|procfile|workspace)$/i

function repositoryError(code, message) {
  return Object.assign(new Error(message), { code })
}

function noEvidence() {
  return repositoryError('repository-no-evidence', '当前提交没有可供解读的源码或文档。')
}

function unreadable() {
  return repositoryError('repository-file-unavailable', '无法读取此源码文件的文本。')
}

function eligiblePath(path) {
  if (typeof path !== 'string' || path.length > 512 || !path.isWellFormed() || /[\\\u0000-\u001f\u007f]/.test(path)) return false
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || sensitivePart.test(part))) return false
  const name = parts.at(-1)
  return !privateFile.test(name) && (sourceName.test(name) || projectFile.test(name))
}

function sourceText(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.trim() && !text.includes('\0')) return text.replace(/\r\n?/g, '\n')
  } catch {}
  throw unreadable()
}

function encodePath(path) {
  return path.split('/').map(part => encodeURIComponent(part)).join('/')
}

async function readGitHub(url, signal, limit, raw = false) {
  const deadline = AbortSignal.timeout(15_000)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    const response = await fetch(url, {
      signal: requestSignal, redirect: 'manual',
      headers: { Accept: raw ? 'text/plain' : 'application/vnd.github+json', 'User-Agent': 'dsh-code-wiki' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0') {
        throw repositoryError('github-rate-limited', 'GitHub 公共读取次数已达上限，请稍后重试。')
      }
      if (response.status === 409) throw noEvidence()
      if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
        if (raw) throw unreadable()
        throw repositoryError('repository-unavailable', '找不到此公开 GitHub 仓库，请检查地址。')
      }
      throw new Error(`Unexpected GitHub response ${response.status}`)
    }

    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      if (length + chunk.length > limit) {
        if (!raw) throw new Error('GitHub repository tree exceeds the read limit')
        chunks.push(chunk.subarray(0, limit - length))
        const prefix = Buffer.concat(chunks, limit)
        return sourceText(prefix.subarray(0, prefix.lastIndexOf(10) + 1))
      }
      chunks.push(chunk)
      length += chunk.length
    }
    const bytes = Buffer.concat(chunks, length)
    return raw ? sourceText(bytes) : JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    signal?.throwIfAborted()
    if (typeof error?.code === 'string' && /^(?:repository-|github-rate-limited$)/.test(error.code)) throw error
    throw repositoryError('github-request-failed', '无法读取 GitHub 仓库，请稍后重试。')
  }
}

function selectedFile(files, path) {
  if (!files.has(path)) throw repositoryError('invalid-repository-file', '请选择仓库清单中的源码文件。')
  return files.get(path)
}

async function openGitHub(repositoryUrl, signal, revision) {
  const match = typeof repositoryUrl === 'string'
    && /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]{1,100})\/?$/i.exec(repositoryUrl.trim())
  const repo = match && match[2].replace(/\.git$/i, '')
  if (!repo || repo === '.' || repo === '..') {
    throw repositoryError('invalid-repository-url', '请输入公开 GitHub 仓库地址，例如 https://github.com/openai/codex。')
  }
  const label = `${match[1]}/${repo}`
  const api = `https://api.github.com/repos/${label}`
  const head = revision
    ? await readGitHub(`${api}/git/commits/${revision}`, signal, 512 * 1024)
    : (await readGitHub(`${api}/commits?per_page=1`, signal, 512 * 1024))[0]
  const commit = head?.sha
  const treeId = (revision ? head?.tree : head?.commit?.tree)?.sha
  if (typeof commit !== 'string' || !gitHubId.test(commit) || typeof treeId !== 'string' || !gitHubId.test(treeId)) throw noEvidence()
  if (revision && commit !== revision) throw noEvidence()
  const { tree, truncated } = await readGitHub(`${api}/git/trees/${treeId}?recursive=1`, signal, treeLimit)
  const files = new Map((Array.isArray(tree) ? tree : []).filter(entry => entry.type === 'blob'
    && regularModes.has(entry.mode) && entry.size !== 0 && eligiblePath(entry.path)).map(entry => [entry.path, entry.path]))
  if (!files.size) throw noEvidence()
  return {
    label, commit, webUrl: 'https://github.com/' + label,
    paths: [...files.keys()].sort(), treeComplete: !truncated,
    read(path, readSignal = signal) {
      const trackedPath = selectedFile(files, path)
      return readGitHub(`https://raw.githubusercontent.com/${label}/${commit}/${encodePath(trackedPath)}`, readSignal, fileLimit, true)
    },
  }
}

function git(cwd, args, signal, maxBuffer = treeLimit, encoding = 'utf8') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|SSH_ASKPASS$)/i.test(key)))
  Object.assign(env, {
    GIT_ALLOW_PROTOCOL: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  })
  return execGit('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env, signal, timeout: 15_000, encoding, maxBuffer, windowsHide: true,
  }).then(({ stdout }) => stdout)
}

async function openLocal(repositoryPath, signal, revision) {
  if (typeof repositoryPath !== 'string' || !isAbsolute(repositoryPath) || repositoryPath.includes('\0')) {
    throw repositoryError('invalid-local-path', '请选择本地 Git 工作区的绝对路径。')
  }
  let root, commit, entries
  try {
    const directory = await realpath(repositoryPath)
    root = (await git(directory, ['rev-parse', '--show-toplevel'], signal)).replace(/\r?\n$/, '')
    if (!isAbsolute(root)) throw new Error('Missing worktree root')
    commit = (await git(root, ['rev-parse', '--verify', `${revision ?? 'HEAD'}^{commit}`], signal)).trim()
    if (!gitId.test(commit) || (revision && commit !== revision)) throw new Error('Unexpected Git commit')
    entries = await git(root, ['ls-tree', '-r', '-z', '--full-tree', commit], signal)
  } catch {
    signal?.throwIfAborted()
    const message = revision
      ? '无法读取目录对应的 Git 提交，请检查仓库目录或重新生成目录。'
      : '无法打开本地 Git 仓库的 HEAD 提交，请检查目录及提交状态。'
    throw repositoryError('repository-unavailable', message)
  }

  const files = new Map()
  for (const line of entries.split('\0')) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.*)$/.exec(line)
    if (match && gitId.test(match[2]) && eligiblePath(match[3])) files.set(match[3], match[2])
  }
  if (!files.size) throw noEvidence()
  return {
    label: basename(root), commit, paths: [...files.keys()].sort(), treeComplete: true,
    async read(path, readSignal = signal) {
      const oid = selectedFile(files, path)
      try {
        return sourceText(await git(root, ['cat-file', 'blob', oid], readSignal, fileLimit, 'buffer'))
      } catch (error) {
        readSignal?.throwIfAborted()
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && Buffer.isBuffer(error.stdout)) {
          return sourceText(error.stdout.subarray(0, error.stdout.lastIndexOf(10) + 1))
        }
        throw unreadable()
      }
    },
  }
}

export async function openRepository(input, signal, revision) {
  signal?.throwIfAborted()
  if (revision !== undefined && (typeof revision !== 'string' || !gitId.test(revision))) {
    throw repositoryError('invalid-repository-commit', '目录缺少有效的仓库提交，请重新生成目录。')
  }
  const commit = revision?.toLowerCase()
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : []
  if (keys.length === 1 && keys[0] === 'repositoryUrl') {
    if (commit && !gitHubId.test(commit)) throw repositoryError('invalid-repository-commit', '目录缺少有效的 GitHub 提交。')
    return openGitHub(input.repositoryUrl, signal, commit)
  }
  if (keys.length === 1 && keys[0] === 'repositoryPath') return openLocal(input.repositoryPath, signal, commit)
  throw repositoryError('invalid-repository-source', '请提供一个 GitHub 地址或本地 Git 仓库路径。')
}
