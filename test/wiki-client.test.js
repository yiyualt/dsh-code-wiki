import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const id = '12345678-1234-1234-1234-123456789abc'
const commit = 'a'.repeat(40)
const repoUrl = 'https://github.com/example/project'
const sourceUrl = repoUrl + '/blob/' + commit + '/src/main.js#L10-L20'
const record = markdown => ({ id, createdAt: '2026-01-01T00:00:00Z', source: 'github', repoUrl, commit, markdown })

async function client(fetchRequest) {
  let definition, wiki, Page
  const requests = [], calls = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: Symbol('fragment'), useEffect() {}, useId: () => 'test-id', useRef: () => ({ current: null }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const primitives = new Proxy({ MarkdownText: 'markdown' }, { get: (object, key) => object[key] ?? (() => null) })
  runInNewContext(await readFile(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    document: { baseURI: 'http://localhost/' }, URL, Intl, AbortController, AbortSignal, performance,
    setTimeout: callback => { callback(); return 0 },
    codeWikiStyles: '', createCodeWikiFolderBrowser: () => () => null, createCodeWikiVideo: () => () => null,
    createWikiViewRenderer: () => function WikiView() {},
    fetch: async (url, options = {}) => { requests.push(String(url)); calls.push({ url: String(url), ...options }); return fetchRequest(new URL(url), options) },
  })
  const plugin = definition.factory(name => name === 'react' ? React : primitives)
  plugin.apply({ uiWorkspace: {}, remote: {}, effect: install => install(), slots: {
    inject(_name, install) { install() },
    register(options, Component) {
      if (options.key === 'dsh-code-wiki') { wiki = options.inject().wiki; Page = Component }
    },
  } })
  return { wiki, Page, requests, calls }
}

async function reader(document) {
  const instance = await client(() => Response.json(document))
  await instance.wiki.openDocument(document.id)
  assert(instance.wiki.getSnapshot().result, instance.wiki.getSnapshot().historyError)
  return instance
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const match = find(child, predicate)
    if (match) return match
  }
}

test('legacy Wiki citations become compact sources while code, links and chapter introductions retain their meaning', async () => {
  const citation = '[src/main\\.js\\:10–20](' + sourceUrl + ')'
  const code = '```js\nconst source = "' + citation + '"\n## Inside code\n```'
  const quoted = '> ```text\n> ' + citation + '\n> ```'
  const listed = '- ```text\n  ' + citation + '\n  ```'
  const titled = '[src/main\\.js\\:10–20](' + sourceUrl + ' "Source range")'
  const data = record('# Project Wiki\n\nShared introduction.\n\n## Overview\n\nA complete paragraph. ' + citation
    + '\n\n1. Read the input.\n2. Return the result.\n\n' + code + '\n\n`' + citation + '`\n\n'
    + quoted + '\n\n' + listed + '\n\n' + titled + '\n\n'
    + '| Kind | Value |\n| --- | --- |\n| Input | Text |\n\n## Extension\n\nReuse it. ' + citation
    + '\n\n[External guide](https://example.com/guide "Guide title")')
  const { wiki, requests } = await reader(data)
  const [first, second] = wiki.getSnapshot().result.chapters
  assert.match(first.markdown, /Shared introduction/)
  assert.doesNotMatch(second.markdown, /Shared introduction/)
  assert(first.markdown.includes('[1](' + sourceUrl + ')'))
  assert(first.markdown.includes(code), 'code fences and their headings must stay intact')
  assert(first.markdown.includes('`' + citation + '`'), 'inline code must stay intact')
  assert(first.markdown.includes(quoted), 'quoted code fences must stay intact')
  assert(first.markdown.includes(listed), 'code fences inside lists must stay intact')
  assert(first.markdown.includes('[1](' + sourceUrl + ' "Source range")'), 'source link titles must survive compaction')
  assert(first.markdown.includes('1. Read the input.\n2. Return the result.'))
  assert(first.markdown.includes('| Kind | Value |'))
  assert(second.markdown.includes('[1](' + sourceUrl + ')'), 'the same source keeps its global number')
  assert(second.markdown.includes('[External guide](https://example.com/guide "Guide title")'))
  assert.equal(first.referenceCount, 1)
  assert(first.references.includes('src/main\\.js\\:10–20'))
  assert.equal(requests.length, 1, 'opening a Wiki only reads that saved document')
  assert.equal(data.markdown.includes('[1]('), false, 'reading must not rewrite the stored record')
})

test('new numbered sources retain their numbers and local target when moved into the chapter source list', async () => {
  const local = 'https://dsh-code-wiki.invalid/source?key=' + id + '&file=2&start=10&end=20'
  const code = '```text\n[7](' + local + ')\n```'
  const data = { ...record('# Project Wiki\n\n## Overview\n\nExplanation. [7](' + local + ' "Local source")\n\n' + code + '\n\n'
    + '### 本章引用\n\n- [7](' + local + ') src/main.js:10–20'),
    source: 'local', repositoryPath: '/example/project', repoName: 'project' }
  const { wiki } = await reader(data)
  const chapter = wiki.getSnapshot().result.chapters[0]
  const target = 'http://localhost/api/dsh-code-wiki/source?key=' + id + '&file=2&start=10&end=20'
  assert(chapter.markdown.includes('[7](' + target + ' "Local source")'))
  assert(chapter.markdown.includes(code), 'resolving local sources must not alter code examples')
  assert.doesNotMatch(chapter.markdown, /本章引用/)
  assert.equal(chapter.referenceCount, 1)
  assert.equal(chapter.references, '- [7](' + target + ') src/main.js:10–20')
})

test('the first chapter introduces the system before its graph and keeps source details closed', async () => {
  const data = record('# Project Wiki\n\n## Overview\n\n### Purpose\n\nThe system accepts input. [1](' + sourceUrl + ')\n\n'
    + '### Components\n\nThe worker returns a result.\n\n'
    + '### 本章引用\n\n- [1](' + sourceUrl + ') src/main.js:10–20')
  const ref = { label: 'src/main.js:10–20', url: sourceUrl }
  data.architecture = { layers: [
    { title: 'Input', nodes: [{ id: 'input', title: 'Input', summary: 'Accepts input.', refs: [ref] }] },
    { title: 'Output', nodes: [{ id: 'output', title: 'Output', summary: 'Returns a result.', refs: [ref] }] },
  ], edges: [{ from: 'input', to: 'output', label: 'Passes input', refs: [ref] }] }
  const { wiki, Page } = await reader(data)
  const articleElement = find(Page({ wiki }), node => node.type?.name === 'WikiArticle')
  const article = articleElement.type(articleElement.props)
  const prose = article.children.findIndex(node => node?.props?.className === 'dsh-code-wiki-prose')
  const graph = article.children.findIndex(node => node?.type?.name === 'ArchitectureGraph')
  assert(prose >= 0 && graph > prose)
  assert(find(article.children[prose], node => node.type === 'markdown').props.text.includes('The system accepts input.'))
  assert.equal(find(article.children[prose], node => node.type === 'markdown').props.text.includes('Components'), false)
  const remaining = article.children.findIndex((node, index) => index > graph && node?.props?.className === 'dsh-code-wiki-prose')
  assert(remaining > graph)
  assert(find(article.children[remaining], node => node.type === 'markdown').props.text.includes('The worker returns a result.'))
  const details = find(article, node => node.type === 'details')
  assert(details)
  assert.equal(details.props.open, undefined)
  assert.equal(find(article, node => node.type === 'markdown').props.omitHtml, true)

  const pending = { ...wiki, getSnapshot: () => ({ ...wiki.getSnapshot(),
    generation: { id: 'pending', repository: 'example/project', phase: 'researching', elapsedMs: 0 } }) }
  const progress = find(Page({ wiki: pending }), node => node.type?.name === 'GenerationProgress')
  const rendered = progress.type(progress.props)
  assert.equal(find(rendered, node => node.props.role === 'status').children[0], '正在核对源码')
})

test('only exact approved diagram fences become controlled views and all other Mermaid stays code', async () => {
  const refs = [{ label: 'src/main.js:10–20', url: sourceUrl }]
  const view = { id: 'input_flow', kind: 'flow', title: 'Input processing', purpose: 'Show how the input reaches storage.',
    nodes: [{ id: 'input', label: 'Input', role: 'data', refs }, { id: 'store', label: 'Store', role: 'store', refs }],
    edges: [{ from: 'input', to: 'store', label: 'Writes input', refs }],
    mermaid: 'flowchart TD\n    n_input[/"Input"/]\n    n_store[("Store")]\n    n_input -->|"Writes input"| n_store' }
  const unapproved = view.mermaid + '\n    extra[Unverified]'
  const markdown = '# Wiki\n\n## Overview\n\nApproved view.\n\n```mermaid\n' + view.mermaid
    + '\n```\n\nUnverified text.\n\n```mermaid\n' + unapproved + '\n```'
  const { wiki, Page } = await reader({ ...record(markdown), views: [view] })
  const element = find(Page({ wiki }), node => node.type?.name === 'WikiArticle')
  const article = element.type(element.props)
  const drawn = find(article, node => node.type?.name === 'WikiView')
  assert(drawn)
  assert.equal(drawn.props.view.id, view.id)
  assert.equal(drawn.props.view.nodes[0].refs[0].href, sourceUrl)
  const code = find(article, node => node.type === 'markdown' && node.props.text.includes('extra[Unverified]'))
  assert(code.props.text.includes('```text\n' + unapproved + '\n```'))
  assert.equal(code.props.text.includes('```mermaid'), false)

  const wrongSource = structuredClone(view)
  wrongSource.nodes[0].refs[0].url = 'https://github.com/other/project/blob/' + commit + '/main.js#L10-L20'
  const fallback = await reader({ ...record(markdown), views: [wrongSource] })
  const fallbackElement = find(fallback.Page({ wiki: fallback.wiki }), node => node.type?.name === 'WikiArticle')
  assert.equal(find(fallbackElement.type(fallbackElement.props), node => node.type?.name === 'WikiView'), undefined)
})


const nextId = '87654321-4321-4321-4321-cba987654321'
function failedJob(target = { repositoryUrl: repoUrl }, resumable = false) {
  return { id, repository: 'example/project', elapsedMs: 5000, phase: 'failed', commit, ...target,
    canResume: resumable, error: '连接暂时中断，请重试。' }
}
function form(wiki, Page) {
  const element = find(Page({ wiki }), node => node.type?.name === 'GenerationForm')
  assert(element, 'The failed attempt keeps its generation form available')
  return element.type(element.props)
}
const submitLabel = (wiki, Page) => find(form(wiki, Page), node => node.props.type === 'submit').children[0]
const tick = () => new Promise(resolve => setImmediate(resolve))

async function retryClient(job, history = []) {
  let posts = 0
  const completed = { ...record('# Project Wiki\n\n## Overview\n\nFinished document.'), id: nextId }
  const instance = await client((url, options) => {
    if (url.pathname.endsWith('/documents')) return Response.json(url.searchParams.has('id') ? completed : { documents: history })
    if (options.method === 'POST') {
      posts++
      return Response.json({ job: posts === 1 ? job : { id: nextId, repository: 'example/project', elapsedMs: 100,
        phase: 'completed', result: completed } }, { status: 202 })
    }
    return Response.json({ job: null })
  })
  instance.wiki.setFormOpen(true)
  if (job.repositoryPath) {
    instance.wiki.changeSource('local')
    instance.wiki.selectFolder(job.repositoryPath)
  } else instance.wiki.setRepositoryUrl(job.repositoryUrl)
  await instance.wiki.generate()
  await tick()
  return instance
}

test('a failure without saved progress offers a fresh retry and refreshes the actual document history', async () => {
  const saved = { ...record('# Earlier Wiki'), id: nextId }
  const { wiki, Page, calls } = await retryClient(failedJob(), [saved])
  assert.equal(wiki.getSnapshot().loading, false)
  assert.equal(wiki.getSnapshot().error, '连接暂时中断，请重试。')
  assert.equal(wiki.getSnapshot().retryJob.canResume, false)
  assert.equal(submitLabel(wiki, Page), '重新尝试')
  assert.equal(wiki.getSnapshot().documents[0].id, nextId, 'Failure rereads history rather than presenting a stale empty library')
  assert(calls.some(call => call.url.endsWith('/documents') && call.method === undefined))
  assert(!JSON.stringify(form(wiki, Page)).includes(id), 'Internal job ids never appear in the form')
  await wiki.generate()
  const bodies = calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body))
  assert.deepEqual(bodies, [{ repositoryUrl: repoUrl }, { repositoryUrl: repoUrl }])
  assert.equal(wiki.getSnapshot().retryJob, null)
  assert.equal(wiki.getSnapshot().result.id, nextId)
})

test('a resumable GitHub failure keeps one continue action and pins the original repository commit', async () => {
  const { wiki, Page, calls } = await retryClient(failedJob({ repositoryUrl: repoUrl }, true))
  assert.equal(submitLabel(wiki, Page), '继续生成')
  wiki.setFormOpen(false)
  wiki.setFormOpen(true)
  wiki.setRepositoryUrl('  ' + repoUrl + '/  ')
  assert.equal(submitLabel(wiki, Page), '继续生成', 'Closing the form or normalizing a trailing slash preserves the matching retry')
  await wiki.generate()
  const bodies = calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body))
  assert.deepEqual(bodies[1], { repositoryUrl: repoUrl, resumeFrom: id, commit })
  assert.equal(wiki.getSnapshot().retryJob, null)
})

test('editing the repository or switching its source never sends a previous repository resume id', async () => {
  const edited = await retryClient(failedJob({ repositoryUrl: repoUrl }, true))
  edited.wiki.setRepositoryUrl('https://github.com/other/repository')
  assert.equal(submitLabel(edited.wiki, edited.Page), '生成文档')
  assert.equal(edited.wiki.getSnapshot().error, '')
  await edited.wiki.generate()
  assert.deepEqual(JSON.parse(edited.calls.filter(call => call.method === 'POST')[1].body), { repositoryUrl: 'https://github.com/other/repository' })

  const switched = await retryClient(failedJob({ repositoryUrl: repoUrl }, true))
  switched.wiki.changeSource('local')
  switched.wiki.selectFolder('/different/local-project')
  assert.equal(submitLabel(switched.wiki, switched.Page), '生成文档')
  await switched.wiki.generate()
  assert.deepEqual(JSON.parse(switched.calls.filter(call => call.method === 'POST')[1].body), { repositoryPath: '/different/local-project' })
})

test('local continuation requires the same path and opening a saved document clears the failed retry', async () => {
  const local = await retryClient(failedJob({ repositoryPath: '/example/project' }, true))
  assert.equal(submitLabel(local.wiki, local.Page), '继续生成')
  await local.wiki.generate()
  assert.deepEqual(JSON.parse(local.calls.filter(call => call.method === 'POST')[1].body), { repositoryPath: '/example/project', resumeFrom: id })

  const changed = await retryClient(failedJob({ repositoryPath: '/example/project' }, true))
  changed.wiki.selectFolder('/example/another-project')
  assert.equal(submitLabel(changed.wiki, changed.Page), '生成文档')
  await changed.wiki.generate()
  assert.deepEqual(JSON.parse(changed.calls.filter(call => call.method === 'POST')[1].body), { repositoryPath: '/example/another-project' })

  const opened = await retryClient(failedJob({ repositoryUrl: repoUrl }, true))
  await opened.wiki.openDocument(nextId)
  assert.equal(opened.wiki.getSnapshot().retryJob, null)
})

test('an incomplete resume identity falls back to a fresh retry and stale history cannot overwrite the failure refresh', async () => {
  const invalid = await retryClient({ ...failedJob({ repositoryUrl: repoUrl }, true), commit: 'main' })
  assert.equal(submitLabel(invalid.wiki, invalid.Page), '重新尝试')
  await invalid.wiki.generate()
  assert.deepEqual(JSON.parse(invalid.calls.filter(call => call.method === 'POST')[1].body), { repositoryUrl: repoUrl })

  let finishOld, historyReads = 0
  const saved = record('# Earlier document')
  const { wiki } = await client((url, options) => {
    if (options.method === 'POST') return Response.json({ job: failedJob() }, { status: 202 })
    if (url.pathname.endsWith('/documents')) {
      if (++historyReads === 1) return new Promise(resolve => { finishOld = () => resolve(Response.json({ documents: [] })) })
      return Response.json({ documents: [saved] })
    }
    return Response.json({ job: null })
  })
  const initial = wiki.loadHistory()
  wiki.setRepositoryUrl(repoUrl)
  await wiki.generate()
  await tick()
  assert.equal(historyReads, 2)
  assert.equal(wiki.getSnapshot().documents[0].id, id)
  finishOld()
  await initial
  assert.equal(wiki.getSnapshot().documents[0].id, id, 'The aborted stale empty list cannot replace the refreshed saved documents')
})
