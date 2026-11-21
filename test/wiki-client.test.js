import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { readWikiWalkthrough } from '../src/wiki-walkthrough-data.js'
import { createWikiWalkthroughRenderer } from '../src/wiki-walkthrough.js'

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
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const primitives = new Proxy({ MarkdownText: 'markdown' }, { get: (object, key) => object[key] ?? (() => null) })
  runInNewContext(await readFile(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    document: { baseURI: 'http://localhost/' }, URL, Intl, AbortController, AbortSignal, performance,
    setTimeout: callback => { callback(); return 0 },
    codeWikiStyles: '', createCodeWikiFolderBrowser: () => () => null, createCodeWikiVideo: () => () => null,
    createWikiViewRenderer: () => function WikiView() {},
    createWikiWalkthroughRenderer, readWikiWalkthrough,
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

test('an architecture placeholder keeps the graph inside its own chapter and chapter sections become navigation', async () => {
  const data = record('# Project Wiki\n\n## 系统架构\n\n这一段说明分层依据。 [1](' + sourceUrl + ')\n\n```dsh-architecture\n```\n\n'
    + '## 数据管道\n\n### 批处理\n\n正文一段。 [1](' + sourceUrl + ')\n\n### 缓存\n\n正文两段。')
  const ref = { label: 'src/main.js:10–20', url: sourceUrl }
  data.architecture = { layers: [
    { title: '输入', nodes: [{ id: 'input', title: 'Input', kind: 'entry', summary: 'Accepts input.', refs: [ref] }] },
    { title: '输出', nodes: [{ id: 'output', title: 'Output', kind: 'data', summary: 'Returns a result.', refs: [ref] }] },
  ], edges: [{ from: 'input', to: 'output', kind: 'data', label: 'Passes input', refs: [ref] }] }
  const { wiki, Page } = await reader(data)
  const snapshot = wiki.getSnapshot()
  const articleFor = index => {
    const element = find(Page({ wiki: { ...wiki, getSnapshot: () => ({ ...snapshot, chapterIndex: index }) } }),
      node => node.type?.name === 'WikiArticle')
    return element.type(element.props)
  }

  const architecture = articleFor(0)
  assert.equal(architecture.children.filter(node => node?.props?.className === 'dsh-code-wiki-prose').length, 1,
    'the graph stays inside the architecture chapter instead of being appended after the prose')
  const graph = find(architecture, node => node?.type?.name === 'ArchitectureGraph')
  assert(graph)
  assert.equal(graph.props.graph.layers[0].nodes[0].kind, 'entry')
  assert.equal(graph.props.graph.edges[0].kind, 'data')
  const diagram = graph.type(graph.props)
  const node = find(diagram, item => item?.props?.['data-kind'] === 'entry')
  assert(node, 'architecture nodes expose their kind for the accent colour')
  assert(find(diagram, item => item?.props?.className === 'dsh-code-wiki-diagram-legend'))

  const pipeline = articleFor(1)
  const nav = pipeline.children.find(item => item?.props?.className === 'dsh-code-wiki-sections')
  assert(nav)
  assert.deepEqual(nav.children.map(button => button.children[0]), ['批处理', '缓存'])
  assert.equal(architecture.children.some(item => item?.props?.className === 'dsh-code-wiki-sections'), false,
    'a chapter without short sections does not show navigation')
})

test('only the overview mounts the linked walkthrough and every archived citation is verified and resolved', async () => {
  const local = 'https://dsh-code-wiki.invalid/source?key=' + id + '&file=2&start=10&end=20'
  const refs = [{ label: 'src/main.js:10–20', url: local }]
  const data = { ...record('# Project Wiki\n\n## Overview\n\nIntro.\n\n## Execution\n\nImplementation.'),
    source: 'local', repositoryPath: '/example/project', repoName: 'project' }
  data.architecture = { layers: [
    { title: '输入', nodes: [{ id: 'input', title: 'Input', kind: 'entry', summary: 'Accepts input.', refs }] },
    { title: '输出', nodes: [{ id: 'output', title: 'Output', kind: 'data', summary: 'Returns a result.', refs }] },
  ], edges: [{ from: 'input', to: 'output', kind: 'data', label: 'Passes input', refs }] }
  data.walkthrough = { title: 'Process one record', objective: 'Follow its data through execution.',
    modules: [{ node: 'input', entry: 'main()', change: 'Edit input parsing.', refs },
      { node: 'output', chapter: 1, entry: 'format()', change: 'Update formatting.', refs }],
    steps: ['receive', 'transform', 'output'].map((name, i) => ({ id: name,
      module: i === 0 ? 'input' : 'output', title: name, action: 'Run the operation.', outcome: 'Continue the call.', refs,
      data: { title: 'Record contents', columns: ['Field', 'Value'], rows: [['item', String(i)]], refs } })),
    tasks: [{ kind: 'feature', title: 'Change output fields', summary: 'Adjust formatting.', steps: ['output'], refs },
      { kind: 'debug', title: 'Verify input', summary: 'Inspect the first value.', steps: ['receive'], refs }] }
  const { wiki, Page } = await reader(data)
  const snapshot = wiki.getSnapshot()
  const articleFor = index => {
    const article = find(Page({ wiki: { ...wiki, getSnapshot: () => ({ ...snapshot, chapterIndex: index }) } }),
      node => node.type?.name === 'WikiArticle')
    return article.type(article.props)
  }
  const walkthrough = find(articleFor(0), node => node.type?.name === 'WikiWalkthrough')
  assert(walkthrough)
  assert.equal(walkthrough.props.chapterTitles[1], 'Execution')
  assert.equal(walkthrough.props.walkthrough.steps[0].data.refs[0].url,
    'http://localhost/api/dsh-code-wiki/source?key=' + id + '&file=2&start=10&end=20')
  assert(!find(articleFor(1), node => node.type?.name === 'WikiWalkthrough'))

  const unsafe = structuredClone(data)
  unsafe.walkthrough.steps[0].data.refs = [{ label: 'Untrusted', url: 'javascript:alert(1)' }]
  const invalid = await reader(unsafe)
  assert.equal(invalid.wiki.getSnapshot().result.walkthrough, undefined)
  assert(invalid.wiki.getSnapshot().result.architecture)
})

test('only exact approved diagram fences become controlled views and all other Mermaid stays code', async () => {
  const refs = Array.from({ length: 6 }, (_, index) => ({ label: `src/main.js:${10 + index}–20`,
    url: sourceUrl.replace('#L10-', `#L${10 + index}-`) }))
  const edges = Array.from({ length: 13 }, (_, index) => ({
    from: index % 2 ? 'store' : 'input', to: index % 2 ? 'input' : 'store', label: `Message ${index + 1}`, refs,
  }))
  const view = { id: 'input_flow', kind: 'sequence', title: 'Input processing', purpose: 'Show how the input reaches storage.',
    nodes: [{ id: 'input', label: 'Input', role: 'data', refs }, { id: 'store', label: 'Store', role: 'store', refs }],
    edges,
    mermaid: ['sequenceDiagram', '    participant n_input as Input', '    participant n_store as Store',
      ...edges.map(edge => `    n_${edge.from}->>n_${edge.to}: ${edge.label}`)].join('\n') }
  const unapproved = view.mermaid + '\n    extra[Unverified]'
  const markdown = '# Wiki\n\n## Overview\n\nApproved view.\n\n```mermaid\n' + view.mermaid
    + '\n```\n\nUnverified text.\n\n```mermaid\n' + unapproved + '\n```'
  const { wiki, Page } = await reader({ ...record(markdown), views: [view] })
  const element = find(Page({ wiki }), node => node.type?.name === 'WikiArticle')
  const article = element.type(element.props)
  const drawn = find(article, node => node.type?.name === 'WikiView')
  assert(drawn)
  assert.equal(drawn.props.view.id, view.id)
  assert.equal(drawn.props.view.edges.length, 13)
  assert.equal(drawn.props.view.edges[0].refs.length, 6)
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
  wiki.setRepositoryUrl('  ' + repoUrl.toUpperCase() + '.git/  ')
  assert.equal(submitLabel(wiki, Page), '继续生成', 'Equivalent GitHub URLs preserve the matching retry')
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

function content(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node?.children ?? []).map(content).join('')
}

test('archived AI review is advisory and displays validated issue text in a collapsed list', async () => {
  async function notice(review) {
    const { wiki, Page } = await reader({ ...record('# A saved Wiki'), review })
    const article = find(Page({ wiki }), node => node.type?.name === 'WikiArticle')
    return find(article.type(article.props), node => node.props.className === 'dsh-code-wiki-review')
  }

  assert.equal(await notice(undefined), undefined)
  assert.equal(await notice({ status: 'approved' }), undefined)
  assert.equal(await notice({ status: 'invalid' }), undefined)

  const literal = '<script>alert(1)</script>'
  const findings = await notice({ status: 'findings', issues: [
    { reviewer: 'semantic', reason: '核对返回值。' },
    { reviewer: 'editorial', reason: literal },
    { reviewer: 'unknown', reason: '隐藏无效意见。' },
  ] })
  assert.equal(findings.type, 'details')
  assert.equal(findings.props.open, undefined)
  assert.equal(content(find(findings, node => node.type === 'summary')), '审核意见待核对 · 2 条')
  assert.deepEqual(find(findings, node => node.type === 'ul').children.map(content), [
    '事实核对 核对返回值。', '编辑检查 ' + literal,
  ])
  assert.equal(find(findings, node => node.type === 'script' || node.props.dangerouslySetInnerHTML), undefined)

  const unavailable = await notice({ status: 'unavailable' })
  assert.equal(unavailable.type, 'p')
  assert.match(content(unavailable), /^内容审核未完成/)
  const partial = await notice({ status: 'unavailable', issues: [{ reviewer: 'semantic', reason: '核对返回值。' }] })
  assert.equal(partial.type, 'details')
  assert.match(content(partial), /^内容审核未完成 · 1 条/)
})

async function progressRenderer() {
  const { wiki, Page } = await client(() => Response.json({ job: null }))
  return (generation = {}, progressOffline = false) => {
    const pending = { ...wiki, getSnapshot: () => ({ ...wiki.getSnapshot(), progressOffline,
      generation: { id, repository: 'example/project', phase: 'writing', elapsedMs: 65_000,
        receivedAt: performance.now(), ...generation } }) }
    const element = find(Page({ wiki: pending }), node => node.type?.name === 'GenerationProgress')
    return element.type(element.props)
  }
}

test('Wiki progress distinguishes revision, rejected submissions and waiting for the model without changing its six stages', async () => {
  const render = await progressRenderer()
  const cases = [
    [{ step: 'drafting' }, '正在撰写初稿'],
    [{ step: 'revising', repair: 1 }, '按审核意见修订（第 1 轮）'],
    [{ step: 'revising', repair: 2 }, '按审核意见修订（第 2 轮）'],
    [{ step: 'revising', repair: 3 }, '按审核意见修订（第 3 轮）'],
    [{ step: 'submission-retry', rejections: 3 }, '提交校验未通过，正在修正（累计 3 次）'],
    [{ step: 'validating' }, '正在校验草稿'],
    [{ step: 'agent-finishing' }, '草稿已收到，等待模型结束当前回复'],
    [{ phase: 'researching', step: 'review-reading', repair: 1 }, '按审核意见补读源码（第 1 轮）'],
    [{ phase: 'reviewing', step: 'reviewing' }, '正在检查文档'],
    [{ phase: 'reviewing', step: 'submission-retry', attempt: 2, attemptLimit: 2 }, '审核反馈格式未通过，正在重新检查'],
  ]
  for (const [generation, expected] of cases) {
    const tree = render(generation)
    assert.equal(content(find(tree, node => node.props.role === 'status')), expected)
    const stages = find(tree, node => node.type === 'ol')
    assert.equal(stages.children.length, 6)
    assert.equal(stages.children.filter(node => node.props['aria-current'] === 'step').length, 1)
  }
  const retry = render({ step: 'submission-retry', rejections: 2, attempt: 2, attemptLimit: 3,
    retryMessage: '引用范围需要调整。'.repeat(40) })
  assert(content(retry).includes('草稿提交：第 2 / 3 次尝试。'))
  const feedback = find(retry, node => node.type === 'p' && content(node).startsWith('校验反馈：'))
  assert.equal(content(feedback).length, '校验反馈：'.length + 180)
  assert.equal(find(render({ step: 'agent-finishing', retryMessage: '已经解决的反馈' }),
    node => node.type === 'p' && content(node).startsWith('校验反馈：')), undefined)
  const reviewerRetry = render({ phase: 'reviewing', step: 'submission-retry', rejections: 1,
    attempt: 2, attemptLimit: 2, retryMessage: '审核补读范围需要调整。' })
  assert(content(reviewerRetry).includes('审核反馈：第 2 / 2 次尝试。'))
  assert(content(reviewerRetry).includes('校验反馈：审核补读范围需要调整。'))
  assert.doesNotMatch(content(reviewerRetry), /草稿提交/)
  assert.match(content(render({ phase: 'reviewing', step: 'reviewing' })), /审核结束后将保存文档，并附上待核对的审核意见。/)
})

test('Wiki transport retries show the upcoming or current attempt and only translated safe reasons', async () => {
  const render = await progressRenderer()
  const transport = { event: 'request-retry', requestId: 'PRIVATE_REQUEST_ID', attempt: 1, attemptLimit: 3,
    retryCode: 'TRANSPORT', url: 'https://private.invalid', error: 'PRIVATE_RAW_ERROR', providerStatus: 503 }
  const pending = render({ step: 'revising', repair: 1, transport })
  assert(content(pending).includes('按审核意见修订（第 1 轮）'))
  assert(content(pending).includes('连接暂时中断，即将重试模型请求（第 2 / 3 次尝试）。'))
  for (const event of ['request-start', 'request-receiving']) {
    assert(content(render({ transport: { ...transport, event, attempt: 2 } }))
      .includes('正在重试模型请求（第 2 / 3 次尝试）。'))
  }
  for (const [retryCode, reason] of [['TIMEOUT', '单次请求等待超时'], ['STREAM_CLOSED', '响应传输中断'],
    ['RATE_LIMIT', '模型服务请求受限'], ['SERVER', '模型服务暂时异常']]) {
    assert(content(render({ transport: { ...transport, retryCode } })).includes(reason))
  }
  const unknown = render({ transport: { ...transport, retryCode: 'PRIVATE_UNKNOWN_CODE' } })
  assert(content(unknown).includes('即将重试模型请求（第 2 / 3 次尝试）。'))
  assert.doesNotMatch(JSON.stringify([pending, unknown]), /PRIVATE_|private\.invalid|503/)
  for (const retryCode of ['__proto__', 'constructor', 'toString']) {
    assert(content(render({ transport: { ...transport, retryCode } }))
      .includes('即将重试模型请求（第 2 / 3 次尝试）。'))
    assert.doesNotMatch(content(render({ transport: { ...transport, retryCode } })), /native code|\[object Object\]/)
  }
  for (const invalid of [{ attempt: 0 }, { attempt: '1' }, { attemptLimit: 1 }, { attemptLimit: 100 }, { attempt: NaN }]) {
    assert.doesNotMatch(content(render({ transport: { ...transport, ...invalid } })), /重试模型请求/)
  }
})

test('Wiki reconnection takes precedence over stale retries and file labels distinguish previous reads from current work', async () => {
  const render = await progressRenderer()
  const generation = { step: 'submission-retry', rejections: 4, retryMessage: '先前校验反馈', attempt: 2, attemptLimit: 3,
    transport: { event: 'request-retry', attempt: 1, attemptLimit: 3, retryCode: 'TIMEOUT' },
    filesRead: 18, currentFile: 'recbole/trainer/trainer.py' }
  const online = render(generation)
  assert(content(online).includes('已读取 18 个文件 · 最近读取：recbole/trainer/trainer.py'))
  const clock = find(online, node => node.type?.name === 'GenerationClock')
  const renderedClock = clock.type(clock.props)
  assert(content(renderedClock).includes('整次耗时'))
  assert.equal(find(renderedClock, node => node.type === 'time').props['aria-label'], '生成耗时')
  const offline = render(generation, true)
  assert.equal(content(find(offline, node => node.props.role === 'status')), '正在重新连接')
  assert(content(offline).includes('稍后会同步进度'))
  assert.doesNotMatch(content(offline), /先前校验反馈|重试模型请求|提交校验未通过|草稿提交：/)
  assert(content(offline).includes('最近读取：'))
})

test('legacy progress and cancelled or completed transport events retain the existing stage fallback', async () => {
  const render = await progressRenderer()
  for (const generation of [{}, { step: 'future-step' },
    ...['request-failed', 'request-completed', 'cancelled', 'future-event'].map(event => ({
      transport: { event, attempt: 2, attemptLimit: 3, retryCode: 'PRIVATE_CODE' },
    }))]) {
    const tree = render(generation)
    assert.equal(content(find(tree, node => node.props.role === 'status')), '正在撰写文档')
    assert.doesNotMatch(content(tree), /重试模型请求|PRIVATE_CODE/)
  }
  const starting = render({ phase: 'starting' })
  assert.equal(content(find(starting, node => node.props.role === 'status')), '正在提交任务')
})

test('disposing during submission cancels polling without starting a fallback request or exposing a retry error', async () => {
  const entered = Promise.withResolvers()
  const { wiki, calls } = await client((_url, options) => new Promise((resolve, reject) => {
    entered.resolve()
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  }))
  wiki.setRepositoryUrl(repoUrl)
  const pending = wiki.generate()
  await entered.promise
  wiki.dispose()
  await pending
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(wiki.getSnapshot().retryJob, null)
  assert.equal(wiki.getSnapshot().error, '')
})
