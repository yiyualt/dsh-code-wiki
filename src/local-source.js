import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { devNull } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { excerpt, maxBlobBytes, selectFiles } from './github-source.js'

const runGit = promisify(execFile)
const maxTreeBytes = 12 * 1024 * 1024
const readTimeout = 30_000
const batchSize = 3
const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function sourceError(code, message) {
  return Object.assign(new Error(message), { code })
}

function unavailable() {
  return sourceError('local-repository-unavailable', '无法打开本地 Git 工作区，请核对目录和访问权限。')
}

function noEvidence(message) {
  return sourceError('repository-no-evidence', message)
}

function readFailed() {
  return sourceError('local-read-failed', '无法读取本地 Git 提交，请检查仓库是否完整后重试。')
}

function createGit(signal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|SSH_ASKPASS$)/i.test(key)))
  Object.assign(env, {
    GIT_ALLOW_PROTOCOL: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  })
  const config = [
    '--no-pager',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${devNull}`,
  ]
  return async (cwd, args, { maxBuffer = maxTreeBytes, encoding = 'utf8' } = {}) => {
    const { stdout } = await runGit('git', [...config, ...args], {
      cwd, env, signal, encoding, maxBuffer, windowsHide: true,
    })
    return stdout
  }
}

async function worktreeRoot(input, git) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) {
    throw sourceError('invalid-local-path', '请输入本地 Git 工作区的绝对路径。')
  }
  let directory
  try {
    directory = await realpath(input)
    if (!(await stat(directory)).isDirectory()) throw unavailable()
  } catch {
    throw unavailable()
  }

  let root
  try {
    const output = await git(directory, ['rev-parse', '--show-toplevel'])
    root = output.replace(/\r?\n$/, '')
  } catch (error) {
    if (error.code === 128) throw unavailable()
    throw readFailed()
  }
  if (!isAbsolute(root)) throw unavailable()
  return root
}

async function headCommit(root, git) {
  let head
  try {
    head = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  } catch (error) {
    if (error.code === 128) throw noEvidence('仓库没有可读取的 HEAD 提交。')
    throw readFailed()
  }
  const commit = head.trim()
  if (!gitObjectId.test(commit)) throw readFailed()
  return commit
}

function parseTree(output) {
  const tree = []
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const separator = entry.indexOf('\t')
    const [mode, type, sha] = entry.slice(0, separator).split(' ')
    if (separator > 0 && gitObjectId.test(sha)) {
      tree.push({ mode, type, sha, path: entry.slice(separator + 1) })
    }
  }
  return tree
}

async function readFile(root, git, { path, sha }) {
  let size
  try {
    size = Number(await git(root, ['cat-file', '-s', sha]))
  } catch (error) {
    // A partial clone may not have the blob locally.
    if (error.code === 128) return null
    throw error
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBlobBytes) return null
  const content = await git(root, ['cat-file', 'blob', sha], { encoding: 'buffer', maxBuffer: maxBlobBytes })
  if (content.length !== size) throw readFailed()
  const text = excerpt(content)
  return text ? { path, text } : null
}

export async function collectLocalSource(repositoryPath, { signal } = {}) {
  const deadline = AbortSignal.timeout(readTimeout)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const git = createGit(requestSignal)
  const root = await worktreeRoot(repositoryPath, git)
  const commit = await headCommit(root, git)

  const files = []
  try {
    const output = await git(root, ['ls-tree', '-r', '-z', '--full-tree', commit])
    const candidates = selectFiles(parseTree(output))
    for (let index = 0; index < candidates.length; index += batchSize) {
      const batch = await Promise.all(candidates.slice(index, index + batchSize).map(file => readFile(root, git, file)))
      files.push(...batch.filter(Boolean))
    }
  } catch {
    throw readFailed()
  }
  if (!files.length) throw noEvidence('当前提交没有可读取的开发文档、构建配置或工作流。')
  return { repositoryPath: root, repo: basename(root), commit, files }
}
