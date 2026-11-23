import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseWikiMermaid } from '../src/wiki-mermaid.js'
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
    createWikiViewRenderer: () => function WikiView() {}, parseWikiMermaid,
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

test('the sidebar shows numbered topics only and the narrow picker keeps full chapter titles', async () => {
  const data = { ...record('# RecBole\n\n## 1. 仓库形态：配置驱动的四层骨架\n\nOverview.\n\n'
    + '## 2. **数据层**：`Dataset`、`DataLoader` 与 `Interaction` 的契约\n\nInterfaces.\n\n'
    + '## 评估指标\n\nMetrics.\n\n## `name: value` 配置\n\nExample.'), format: 'skill-markdown' }
  const { wiki, Page } = await reader(data)
  const directory = () => {
    const nav = find(Page({ wiki }), node => node.type?.name === 'ChapterDirectory')
    return nav.type(nav.props)
  }
  const nav = directory()
  const items = find(nav, node => node.type === 'ol').children.map(item => item.children[0])
  const copy = (button, name) => find(button, node => node.props.className === 'dsh-code-wiki-chapter-' + name)?.children[0]
  assert.deepEqual(Array.from(items, button => copy(button, 'number')), [1, 2, 3, 4])
  assert.equal(copy(items[0], 'title'), '仓库形态')
  assert.equal(copy(items[1], 'title'), '数据层')
  assert(items.every(button => button.children.length === 2), 'the sidebar shows only each number and topic')
  assert.equal(copy(items[3], 'title'), 'name: value 配置')
  assert.equal(items[0].props['aria-current'], 'page')
  const select = find(nav, node => node.type === 'select')
  assert.equal(select.children[1].children[0], '2. 数据层：Dataset、DataLoader 与 Interaction 的契约')
  items[1].props.onClick()
  assert.equal(find(directory(), node => node.props['aria-current'] === 'page').children[0].children[0], 2)
  const article = find(Page({ wiki }), node => node.type?.name === 'WikiArticle')
  assert.equal(find(article.type(article.props), node => node.type === 'h1').children[0],
    '2. 数据层：Dataset、DataLoader 与 Interaction 的契约')
  select.props.onChange({ target: { value: '2' } })
  assert.equal(wiki.getSnapshot().chapterIndex, 2)
})

test('older saved headings and single-section documents keep a usable chapter label', async () => {
  const data = record('# Wiki\n\n## 1\\. 错误处理: handle\\_error\\(\\)\n\nDescription.\n\n'
    + '## 2.3 compatibility\n\nAnother section.')
  const legacy = await reader(data)
  const [first, second] = legacy.wiki.getSnapshot().result.chapters
  assert.equal(first.directoryTitle, '错误处理')
  assert.equal(first.directoryDetail, 'handle_error()')
  assert.equal(second.directoryTitle, '2.3 compatibility')
  assert.equal(second.directoryDetail, undefined)
  const single = await reader(record('# Plain guide\n\nOne paragraph.'))
  const nav = find(single.Page({ wiki: single.wiki }), node => node.type?.name === 'ChapterDirectory')
  assert.equal(find(nav.type(nav.props), node => node.type === 'option').children[0], '1. Plain guide')
})

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
  assert.equal(find(rendered, node => node.props.role === 'status').children[0], '正在读取源码')
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

test('plain Skill chapters render supported diagrams while legacy and unsupported fences stay as code', async () => {
  const source = 'flowchart LR\n  A[入口] -->|dispatch(job)| B[任务]'
  const unsupported = source + '\n  click A "https://example.test/"'
  const citation = '[src/main\\.js\\:10–20](' + sourceUrl + ')'
  const fence = input => '\n\n```mermaid\n' + input + '\n```'
  const markdown = '# Wiki\n\n## 接口\n\n调用入口记录任务。' + citation + fence(source) + fence(unsupported)
  for (const format of ['skill-markdown', undefined]) {
    const { wiki, Page } = await reader({ ...record(markdown), format })
    const element = find(Page({ wiki }), node => node.type?.name === 'WikiArticle')
    const article = element.type(element.props)
    const drawn = find(article, node => node.type?.name === 'WikiView')
    assert.equal(drawn?.props.view.edges[0].label, format ? 'dispatch(job)' : undefined)
    assert(find(article, node => node.type === 'markdown' && node.props.text.includes('[1](' + sourceUrl + ')')))
    const fallback = find(article, node => node.type === 'markdown' && node.props.text.includes('click A'))
    assert(fallback.props.text.includes('```text\n' + unsupported + '\n```'))
    assert(!fallback.props.text.includes('```mermaid'))
  }

  for (const literal of ['<!--' + fence(source) + '\n-->', '\n```mermaid\n' + source + '\n> ```']) {
    const { wiki, Page } = await reader({ ...record('# Wiki\n\n## 接口\n\n接口详情。\n\n' + literal), format: 'skill-markdown' })
    const element = find(Page({ wiki }), node => node.type?.name === 'WikiArticle')
    const article = element.type(element.props)
    assert.equal(find(article, node => node.type?.name === 'WikiView'), undefined)
  }
})

test('chapter diagrams retain repeated kinds across sections and show validated interface contracts', async () => {
  const refs = [{ label: 'src/main.js:10–20', url: sourceUrl }]
  const names = ['Overview', 'Lifecycle', 'Job', 'Retry']
  const views = names.map((title, chapter) => ({
    id: 'lifecycle_' + chapter, chapter, kind: 'state', title, purpose: 'Show the state change at the boundary.',
    mermaid: `%% wiki-view:lifecycle_${chapter}\nflowchart TD\n    first --> second`,
    nodes: [{ id: 'first', label: 'Ready', role: 'start', refs },
      { id: 'second', label: 'Accepted', role: 'end', detail: 'Job has an identifier', members: ['jobId'], refs }],
    edges: [{ from: 'first', to: 'second', label: 'accept', refs,
      contract: { entry: 'openJob(options)', input: 'options.repo identifies the project', output: 'returns jobId' } }],
  }))
  const fence = view => '\n```mermaid\n' + view.mermaid + '\n```\n\n'
    + `<!-- dsh-wiki-interfaces:${view.id} -->\n\n**图中接口**\n\n- portable interface ${view.id}\n\n`
    + `<!-- /dsh-wiki-interfaces:${view.id} -->\n`
  const markdown = '# Wiki\n' + names.map((title, index) => '\n## ' + title + '\n' + fence(views[index])
    + (index === 0 ? fence(views[1]) : '')).join('\n')
  const { wiki, Page } = await reader({ ...record(markdown), views })
  const snapshot = wiki.getSnapshot()
  assert.equal(snapshot.result.views.length, 4, 'the same kind can be useful in multiple chapters')
  for (let chapterIndex = 0; chapterIndex < names.length; chapterIndex++) {
    const element = find(Page({ wiki: { ...wiki, getSnapshot: () => ({ ...snapshot, chapterIndex }) } }),
      node => node.type?.name === 'WikiArticle')
    const article = element.type(element.props)
    const drawn = find(article, node => node.type?.name === 'WikiView')
    assert.equal(drawn.props.view.chapter, chapterIndex)
    assert.equal(drawn.props.view.nodes[1].detail, 'Job has an identifier')
    assert.equal(drawn.props.view.edges[0].contract.entry, 'openJob(options)')
    assert(!find(article, node => node.type === 'markdown' && node.props.text.includes('portable interface ' + drawn.props.view.id)),
      'the reader shows the contract card without the generated Markdown duplicate')
    if (chapterIndex === 0) assert(find(article, node => node.type === 'markdown'
      && node.props.text.includes('```text\n' + views[1].mermaid) && node.props.text.includes('portable interface ' + views[1].id)),
    'an untrusted diagram leaves its readable Markdown interface intact')
  }
  const malformed = structuredClone(views)
  malformed[1].edges[0].contract.output = 'x'.repeat(221)
  const invalid = await reader({ ...record(markdown), views: malformed })
  assert.equal(invalid.wiki.getSnapshot().result.views.some(view => view.chapter === 1), false)

  const misplaced = await reader({ ...record(markdown.replace('<!-- dsh-wiki-interfaces:lifecycle_0 -->',
    'A paragraph between the diagram and the portable list.\n\n<!-- dsh-wiki-interfaces:lifecycle_0 -->')), views })
  const misplacedElement = find(misplaced.Page({ wiki: misplaced.wiki }), node => node.type?.name === 'WikiArticle')
  assert(find(misplacedElement.type(misplacedElement.props), node => node.type === 'markdown'
    && node.props.text.includes('portable interface lifecycle_0')), 'only an adjacent portable list belongs to the diagram')
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

test('saved Wikis open directly to the article regardless of archived review status', async () => {
  const reason = '请核对函数返回值。'
  for (const review of [undefined, { status: 'approved' }, { status: 'unavailable' },
    { status: 'findings', issues: [{ reviewer: 'semantic', reason }] }]) {
    const { wiki, Page } = await reader({ ...record('# A saved Wiki\n\n## 概览\n\n这里是正文。'), review })
    const article = find(Page({ wiki }), node => node.type?.name === 'WikiArticle')
    const tree = article.type(article.props)
    assert.match(find(tree, node => node.type === 'markdown').props.text, /这里是正文。/)
    assert.doesNotMatch(content(tree), /审核意见待核对|内容审核未完成|请核对函数返回值。/)
  }
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

test('Wiki progress presents four technical stages and hides editorial feedback and counters', async () => {
  const render = await progressRenderer()
  const labels = ['读取仓库', '读取源码', '生成文档', '保存文档']
  const cases = [
    [{ phase: 'reading' }, 0],
    [{ phase: 'researching' }, 1],
    [{ step: 'drafting' }, 2],
    [{ phase: 'saving' }, 3],
    [{ phase: 'planning' }, 1],
    [{ phase: 'reviewing' }, 2],
    [{ phase: 'researching', step: 'review-reading', repair: 1 }, 1],
    [{ step: 'submission-retry', reasonCategory: 'review', rejections: 2, attempt: 2, attemptLimit: 3,
      retryMessage: '引用范围需要调整。' }, 2],
  ]
  for (const [generation, index] of cases) {
    const tree = render(generation)
    assert.equal(content(find(tree, node => node.props.role === 'status')), '正在' + labels[index])
    const stages = find(tree, node => node.type === 'ol')
    assert.deepEqual(stages.children.map(content), labels)
    assert.deepEqual(stages.children.map(node => node.props['data-state']),
      labels.map((_, i) => i < index ? 'done' : i === index ? 'active' : 'waiting'))
    assert.equal(stages.children[index].props['aria-current'], 'step')
    assert.doesNotMatch(content(tree), /审核|草稿|校验|引用范围需要调整/)
  }
  const retry = render({ step: 'submission-retry', reasonCategory: 'model-response', retryMessage: '不展示内部反馈。' })
  assert.match(content(retry), /正在重新请求模型回复/)
  assert.doesNotMatch(content(retry), /不展示内部反馈/)
})

test('Wiki transport retries show the upcoming or current attempt and only translated safe reasons', async () => {
  const render = await progressRenderer()
  const transport = { event: 'request-retry', requestId: 'PRIVATE_REQUEST_ID', attempt: 1, attemptLimit: 3,
    retryCode: 'TRANSPORT', url: 'https://private.invalid', error: 'PRIVATE_RAW_ERROR', providerStatus: 503 }
  const pending = render({ step: 'revising', repair: 1, transport })
  assert(content(pending).includes('正在生成文档'))
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
    assert.equal(content(find(tree, node => node.props.role === 'status')), '正在生成文档')
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
