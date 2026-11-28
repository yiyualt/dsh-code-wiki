import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execGit = promisify(execFile)
const githubTreeLimit = 12 * 1024 * 1024
const folderEntryLimit = 100_000
const fileLimit = 128 * 1024
const pathLimit = 512
const treeEntryLimit = pathLimit * 3 + '100644 blob \t'.length + 64
const gitArgs = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
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

function eligiblePath(path, isDirectory = false) {
  if (typeof path !== 'string' || path.length > pathLimit || !path.isWellFormed() || /[\\\u0000-\u001f\u007f]/.test(path)) return false
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || sensitivePart.test(part))) return false
  if (isDirectory) return true
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
  try {
    const response = await fetch(url, {
      signal, redirect: 'manual',
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
  const { tree, truncated } = await readGitHub(`${api}/git/trees/${treeId}?recursive=1`, signal, githubTreeLimit)
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

function folderError(error) {
  if (['EACCES', 'EPERM'].includes(error?.code)) {
    return repositoryError('local-directory-forbidden', 'DSH 没有读取所选文件夹的权限，请检查目录访问权限。')
  }
  return repositoryError('local-directory-unavailable', 'DSH 找不到或无法打开所选目录，请重新选择文件夹。')
}

async function readFolderTree(root, signal) {
  const files = new Map()
  const pending = ['']
  let visited = 0
  while (pending.length) {
    signal?.throwIfAborted()
    const relative = pending.pop()
    const directory = relative ? join(root, ...relative.split('/')) : root
    try {
      if (await realpath(directory) !== directory) throw folderError()
      const entries = await opendir(directory)
      try {
        if (await realpath(directory) !== directory) throw folderError()
        for (let entry; (entry = await entries.read());) {
          signal?.throwIfAborted()
          if (++visited > folderEntryLimit) {
            throw repositoryError('local-directory-too-large', '所选目录包含的文件过多，请选择更具体的源码目录。')
          }
          const path = relative ? `${relative}/${entry.name}` : entry.name
          if (entry.isDirectory() && eligiblePath(path, true)) pending.push(path)
          if (entry.isFile() && eligiblePath(path)) files.set(path, join(directory, entry.name))
        }
      } finally {
        await entries.close()
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error.code === 'local-directory-too-large') throw error
      if (!relative || !['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM', 'local-directory-unavailable'].includes(error.code)) {
        throw folderError(error)
      }
    }
  }
  return files
}

async function readFolderFile(path, signal) {
  try {
    signal?.throwIfAborted()
    if (await realpath(path) !== path) throw unreadable()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await file.stat()
      const current = await lstat(path)
      if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino
        || await realpath(path) !== path) throw unreadable()

      const buffer = Buffer.alloc(fileLimit + 1)
      let length = 0
      while (length < buffer.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      signal?.throwIfAborted()
      if (length > fileLimit) {
        const prefix = buffer.subarray(0, fileLimit)
        length = prefix.lastIndexOf(10) + 1
      }
      return sourceText(buffer.subarray(0, length))
    } finally {
      await file.close()
    }
  } catch {
    signal?.throwIfAborted()
    throw unreadable()
  }
}

async function openLocalFolder(repositoryPath, signal) {
  let root
  try {
    root = await realpath(repositoryPath)
  } catch (error) {
    signal?.throwIfAborted()
    throw folderError(error)
  }
  const files = await readFolderTree(root, signal)
  signal?.throwIfAborted()
  if (!files.size) throw repositoryError('repository-no-evidence', '所选目录没有可供解读的源码或文档。')
  return {
    label: basename(root) || root, commit: null, paths: [...files.keys()].sort(), treeComplete: true,
    read(path, readSignal = signal) {
      return readFolderFile(selectedFile(files, path), readSignal)
    },
  }
}

function gitOptions(cwd, signal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|SSH_ASKPASS$)/i.test(key)))
  Object.assign(env, {
    LC_ALL: 'C',
    GIT_ALLOW_PROTOCOL: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  })
  return { cwd, env, signal, windowsHide: true }
}

function git(cwd, args, signal, maxBuffer, encoding = 'utf8') {
  return execGit('git', [...gitArgs, ...args], {
    ...gitOptions(cwd, signal), encoding, ...(maxBuffer !== undefined && { maxBuffer }),
  }).then(({ stdout }) => stdout)
}

function localGitEnvironmentError(error) {
  if (['ENOENT', 'ENOEXEC'].includes(error?.code)) {
    return repositoryError('local-git-unavailable', 'DSH 无法启动 Git，请检查运行 DSH 的环境是否已安装 Git。')
  }
  const stderr = String(error?.stderr ?? '')
  if (/detected dubious ownership|unsafe repository/i.test(stderr)) {
    return repositoryError('local-git-forbidden', 'Git 拒绝读取此仓库，请检查仓库所有者是否与运行 DSH 的用户一致。')
  }
  if (['EACCES', 'EPERM'].includes(error?.code) || /permission denied|operation not permitted/i.test(stderr)) {
    return repositoryError('local-git-forbidden', 'DSH 没有读取此 Git 仓库所需的权限，请检查目录和 Git 的访问权限。')
  }
  return null
}

async function localRepositoryRoot(directory, signal) {
  try {
    return (await git(directory, ['rev-parse', '--show-toplevel'], signal)).replace(/\r?\n$/, '')
  } catch (error) {
    if (!String(error.stderr ?? '').includes('must be run in a work tree')) throw error
    if ((await git(directory, ['rev-parse', '--is-bare-repository'], signal)).trim() !== 'true') throw error
    return (await git(directory, ['rev-parse', '--absolute-git-dir'], signal)).replace(/\r?\n$/, '')
  }
}

async function collectTreeFiles(stdout) {
  const files = new Map()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const empty = Buffer.alloc(0)
  let remainder = empty
  let skipEntry = false
  for await (const chunk of stdout) {
    let start = 0
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      const bytes = chunk.subarray(start, end)
      if (!skipEntry && remainder.length + bytes.length <= treeEntryLimit) {
        let entry
        try {
          entry = decoder.decode(remainder.length ? Buffer.concat([remainder, bytes]) : bytes)
        } catch {
          entry = ''
        }
        const match = /^(?:100644|100755) blob ([a-f0-9]+)\t(.*)$/.exec(entry)
        if (match && gitId.test(match[1]) && eligiblePath(match[2])) files.set(match[2], match[1])
      }
      remainder = empty
      skipEntry = false
      start = end + 1
    }
    const tail = chunk.subarray(start)
    // An entry longer than the longest eligible path can be skipped through its next NUL.
    skipEntry ||= remainder.length + tail.length > treeEntryLimit
    remainder = skipEntry ? empty : remainder.length ? Buffer.concat([remainder, tail]) : tail
  }
  return { files, complete: !skipEntry && remainder.length === 0 }
}

async function readLocalTree(root, commit, signal) {
  const child = spawn('git', [...gitArgs, 'ls-tree', '-r', '-z', '--full-tree', commit], {
    ...gitOptions(root, signal), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk.slice(0, 4096 - stderr.length) })
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(Object.assign(new Error('Git ls-tree failed'), { code, stderr }))
    })
  })
  try {
    const [, { files, complete }] = await Promise.all([exit, collectTreeFiles(child.stdout)])
    if (!complete) throw new Error('Incomplete Git tree entry')
    return files
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

async function openLocalGit(repositoryPath, signal, revision) {
  let directory
  try {
    directory = await realpath(repositoryPath)
    if (!(await stat(directory)).isDirectory()) throw new Error('Expected a directory')
  } catch (error) {
    signal?.throwIfAborted()
    if (['EACCES', 'EPERM'].includes(error.code)) throw localGitEnvironmentError(error)
    throw repositoryError('local-directory-unavailable', 'DSH 找不到或无法打开所选目录，请重新选择仓库文件夹。')
  }

  let root
  try {
    root = await localRepositoryRoot(directory, signal)
    if (!isAbsolute(root)) throw new Error('Missing Git repository root')
  } catch (error) {
    signal?.throwIfAborted()
    throw localGitEnvironmentError(error) ?? repositoryError('local-not-git-repository',
      '无法从所选目录定位 Git 仓库，请选择实际的 Git 仓库文件夹。')
  }

  let commit
  try {
    commit = (await git(root, ['rev-parse', '--verify', `${revision}^{commit}`], signal)).trim()
    if (commit !== revision) throw new Error('Unexpected Git commit')
  } catch (error) {
    signal?.throwIfAborted()
    throw localGitEnvironmentError(error) ?? repositoryError('local-git-commit-unavailable',
      '本地仓库缺少这份 Wiki 对应的 Git 提交。请确认该版本在本地可用，或从当前版本生成一份新 Wiki。')
  }

  let files
  try {
    files = await readLocalTree(root, commit, signal)
  } catch (error) {
    signal?.throwIfAborted()
    throw localGitEnvironmentError(error) ?? repositoryError('local-git-tree-unavailable',
      'Git 已找到提交，但无法列出该提交中的文件，请确认本地仓库的 Git 对象完整且可读取。')
  }
  signal?.throwIfAborted()
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
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : []
  const local = keys.length === 1 && keys[0] === 'repositoryPath'
  if (revision !== undefined && !(revision === null && local) && (typeof revision !== 'string' || !gitId.test(revision))) {
    throw repositoryError('invalid-repository-commit', '目录缺少有效的仓库提交，请重新生成目录。')
  }
  const commit = revision?.toLowerCase()
  if (keys.length === 1 && keys[0] === 'repositoryUrl') {
    if (commit && !gitHubId.test(commit)) throw repositoryError('invalid-repository-commit', '目录缺少有效的 GitHub 提交。')
    return openGitHub(input.repositoryUrl, signal, commit)
  }
  if (local) {
    const { repositoryPath } = input
    if (typeof repositoryPath !== 'string' || !isAbsolute(repositoryPath) || repositoryPath.includes('\0')) {
      throw repositoryError('invalid-local-path', '请选择本地文件夹的绝对路径。')
    }
    return commit ? openLocalGit(repositoryPath, signal, commit) : openLocalFolder(repositoryPath, signal)
  }
  throw repositoryError('invalid-repository-source', '请提供一个 GitHub 地址或本地文件夹路径。')
}
