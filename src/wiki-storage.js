import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { wikiChapterViewLimit, wikiCitationLimit, wikiViewEdgeLimits, wikiViewKinds, wikiViewRelations, wikiViewRoles } from './wiki-document.js'
import { readWikiWalkthrough } from './wiki-walkthrough-data.js'
import { formatWikiFileTables } from './wiki-file-tables.js'

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const documentFile = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/
const commitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const githubRepo = /^https:\/\/github\.com\/[a-z\d-]+\/[\w.-]+$/i

const timestamp = value => new Date(value).getTime()
const nonempty = value => typeof value === 'string' && Boolean(value.trim())

function validViews(views) {
  if (!Array.isArray(views) || views.length > wikiChapterViewLimit || JSON.stringify(views).length > 480_000) return false
  const ids = new Set()
  const text = (value, max) => nonempty(value) && value.length <= max
  return views.every(view => {
    if (!view || !/^[a-z][a-z0-9_-]{0,43}$/.test(view.id) || ids.has(view.id) || !wikiViewKinds.includes(view.kind)
      || (view.chapter !== undefined && (!Number.isInteger(view.chapter) || view.chapter < 0 || view.chapter >= 8))
      || !nonempty(view.title) || !nonempty(view.purpose) || !nonempty(view.mermaid)
      || !Array.isArray(view.nodes) || view.nodes.length < 2 || view.nodes.length > 8
      || !Array.isArray(view.edges) || view.edges.length < 1
      || view.edges.length > (view.kind === 'sequence' ? wikiViewEdgeLimits.sequence : wikiViewEdgeLimits.other)) return false
    ids.add(view.id)
    const nodes = new Set()
    const refs = value => Array.isArray(value) && value.length > 0 && value.length <= wikiCitationLimit
      && value.every(ref => nonempty(ref?.label) && nonempty(ref?.url))
    if (!view.nodes.every(node => {
      if (!/^[a-z][a-z0-9_-]{0,43}$/.test(node?.id) || nodes.has(node.id) || !nonempty(node.label) || !refs(node.refs)
        || (view.chapter !== undefined && !wikiViewRoles.includes(node.role))
        || (node.detail !== undefined && !text(node.detail, 120))
        || (node.members !== undefined && (!Array.isArray(node.members) || node.members.length < 1 || node.members.length > 4
          || !node.members.every(member => text(member, 100))))) return false
      nodes.add(node.id); return true
    })) return false
    return view.edges.every(edge => nodes.has(edge?.from) && nodes.has(edge?.to) && nonempty(edge.label) && refs(edge.refs)
      && (edge.relation === undefined || wikiViewRelations.includes(edge.relation))
      && (edge.contract === undefined || text(edge.contract?.entry, 120) && text(edge.contract.input, 220) && text(edge.contract.output, 220)))
  })
}

function storedWalkthrough(raw, architecture, { id, source, repoUrl, commit }) {
  if (!Array.isArray(architecture?.layers) || !Array.isArray(architecture.edges)) return undefined
  const nodeIds = new Set(architecture.layers.flatMap(layer => Array.isArray(layer?.nodes)
    ? layer.nodes.map(node => node?.id) : []))
  function readRefs(refs) {
    const result = []
    for (const ref of refs) {
      if (!nonempty(ref?.label) || ref.label.length > 600 || typeof ref.url !== 'string') return undefined
      const url = URL.parse(ref.url)
      if (!url || url.username || url.password) return undefined
      if (source === 'github') {
        if (!url.href.startsWith(repoUrl + '/blob/' + commit + '/') || !/^#L\d+(?:-L\d+)?$/.test(url.hash)) return undefined
      } else if (source !== 'local' || url.origin !== 'https://dsh-code-wiki.invalid' || url.pathname !== '/source'
        || !new RegExp('^\\?key=' + id + '&file=\\d+&start=\\d+&end=\\d+$').test(url.search)) return undefined
      result.push({ label: ref.label, url: url.href })
    }
    return result
  }
  return readWikiWalkthrough(raw, { nodeIds, chapterCount: 8, readRefs })
}

function storedReview(review) {
  if (!['approved', 'findings', 'unavailable'].includes(review?.status)) return undefined
  if (review.status === 'approved') return { status: 'approved' }
  const issues = Array.isArray(review.issues) ? review.issues.slice(0, 12).flatMap(issue => {
    if (!['semantic', 'editorial'].includes(issue?.reviewer) || typeof issue.reason !== 'string') return []
    const reason = issue.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1200)
    return reason ? [{ reviewer: issue.reviewer, reason }] : []
  }) : []
  return issues.length ? { status: review.status, issues } : { status: 'unavailable' }
}

function documentRecord(document, id) {
  if (document?.id !== id || !uuid.test(id)) return
  const { createdAt, source, repoUrl, repositoryPath, repoName, commit, markdown, model, note, files, durationMs, architecture, views, format } = document
  if ((typeof createdAt !== 'string' && typeof createdAt !== 'number')
    || !Number.isFinite(timestamp(createdAt))
    || typeof commit !== 'string' || !commitHash.test(commit)
    || !nonempty(markdown)) return
  if (model !== undefined && typeof model !== 'string') return
  if (note !== undefined && typeof note !== 'string') return
  if (repoName !== undefined && !nonempty(repoName)) return
  if (format !== undefined && format !== 'skill-markdown') return
  if (views !== undefined && !validViews(views)) return
  const walkthrough = document.walkthrough === undefined ? undefined : storedWalkthrough(document.walkthrough, architecture, document)
  if (document.walkthrough !== undefined && !walkthrough) return
  const review = storedReview(document.review)

  const metadata = { id, createdAt, source, commit, ...(repoName !== undefined && { repoName }) }
  const content = {
    markdown: format === 'skill-markdown' ? markdown : formatWikiFileTables(markdown), ...(format !== undefined && { format }),
    ...(model !== undefined && { model }), ...(note !== undefined && { note }),
    ...(Number.isSafeInteger(durationMs) && durationMs >= 0 && { durationMs }),
    ...(Array.isArray(architecture?.layers) && Array.isArray(architecture?.edges) && { architecture }),
    ...(views !== undefined && { views }),
    ...(walkthrough && { walkthrough }),
    ...(review && { review }),
  }
  if (source === 'github' && typeof repoUrl === 'string' && githubRepo.test(repoUrl)) {
    return { ...metadata, repoUrl, ...content }
  }
  if (source === 'local' && nonempty(repositoryPath) && isAbsolute(repositoryPath)) {
    if (files !== undefined && (!Array.isArray(files)
      || !files.every(file => nonempty(file?.path) && typeof file.text === 'string'))) return
    return {
      ...metadata, repositoryPath, ...content,
      ...(files !== undefined && { files: files.map(({ path, text, startLine }) => ({
        path, text, ...(Number.isSafeInteger(startLine) && startLine > 1 && { startLine }),
      })) }),
    }
  }
}

function documentSummary({ id, createdAt, source, commit, repoUrl, repositoryPath, repoName }) {
  return {
    id, createdAt, source, commit,
    ...(repoUrl !== undefined && { repoUrl }),
    ...(repositoryPath !== undefined && { repositoryPath }),
    ...(repoName !== undefined && { repoName }),
  }
}

export function createWikiStorage(directory) {
  async function get(id) {
    if (typeof id !== 'string' || !uuid.test(id)) return
    let handle
    try {
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      handle = await open(join(directory, id + '.json'), flags)
      if (!(await handle.stat()).isFile()) return
      const content = await handle.readFile('utf8')
      return documentRecord(JSON.parse(content), id)
    } catch (error) {
      if (!(error instanceof SyntaxError) && !['ENOENT', 'ELOOP', 'EISDIR'].includes(error?.code)) throw error
    } finally {
      await handle?.close()
    }
  }

  return {
    async save(document) {
      const id = document?.id
      if (typeof id !== 'string') throw new TypeError('Invalid wiki document')
      const record = documentRecord(document, id)
      if (!record) throw new TypeError('Invalid wiki document')

      await mkdir(directory, { recursive: true, mode: 0o700 })
      const destination = join(directory, id + '.json')
      const temporary = join(directory, '.' + randomUUID() + '.tmp')
      const handle = await open(temporary, 'wx', 0o600)
      try {
        try {
          await handle.writeFile(JSON.stringify(record) + '\n', 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        // Linking within the directory publishes the finished file without replacing an existing document.
        await link(temporary, destination)
      } finally {
        await unlink(temporary).catch(() => {})
      }
      return record
    },
    get,
    async remove(id) {
      if (typeof id !== 'string' || !uuid.test(id)) return false
      try {
        await unlink(join(directory, id + '.json'))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return true
    },
    async list() {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }

      const summaries = []
      for (const entry of entries) {
        if (!entry.isFile() || !documentFile.test(entry.name)) continue
        const record = await get(entry.name.slice(0, -5))
        if (record) summaries.push(documentSummary(record))
      }
      return summaries.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || a.id.localeCompare(b.id))
    },
  }
}
