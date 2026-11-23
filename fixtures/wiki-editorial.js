export const wikiPlanFixture = () => ({
  audience: '首次阅读此项目的研发工程师。', goal: '理解项目用途、入口如何调用核心实现，以及可以从哪里修改行为。',
  modules: [{ id: 'entry', name: '示例入口', responsibility: '把一次调用交给核心实现。', entry: 'main.js', paths: ['main.js'] },
    { id: 'core', name: '核心实现', responsibility: '提供可重复调用的执行逻辑。', entry: 'core.js', paths: ['core.js'] }],
  chapters: [{ id: 'overview', title: '项目概览', role: 'overview', question: '项目帮助用户完成什么？' },
    { id: 'architecture', title: '系统组成', role: 'architecture', question: '系统由哪几部分组成，边界在哪里？' },
    { id: 'execution', title: '示例入口', role: 'module', module: 'entry', question: '入口如何调用核心实现？' },
    { id: 'core', title: '核心实现', role: 'module', module: 'core', question: '核心实现提供哪些能力？' }],
  research: [{ id: 'purpose', question: '文档明确说明什么用途？', evidenceType: 'documentation', paths: ['README.md'] },
    { id: 'execution', question: '入口如何调用核心实现？', evidenceType: 'implementation', paths: ['main.js', 'core.js'] }],
  views: [], viewOmission: '此测试示例仅有一次直接函数调用，总览图和真实源码足以解释，无需增加重复视图。',
})

export function wikiDiagramFixture({ docs, entry, core }, kind = 'sequence') {
  const refs = span => [{ evidence: span.evidence, start: span.start, end: span.end }]
  const scenario = kind === 'scenario'
  return { id: `${kind}_view`, type: 'diagram', claimType: scenario ? 'usage' : 'implementation', refs: refs(scenario ? docs : entry),
    kind, title: '入口与核心的协作', purpose: '解释调用入口与核心执行之间的关系。',
    nodes: [{ id: 'entry', label: scenario ? '使用者' : '入口', role: scenario ? 'actor' : 'component', refs: refs(scenario ? docs : entry) },
      { id: 'core', label: scenario ? '运行示例' : '核心执行', role: kind === 'dataflow' ? 'process' : 'component', refs: refs(scenario ? docs : core) }],
    edges: [{ from: 'entry', to: 'core', label: scenario ? '运行' : '调用', refs: refs(scenario ? docs : entry) },
      ...(kind === 'sequence' ? [{ from: 'core', to: 'entry', label: '返回结果', refs: refs(core) }] : [])] }
}

export function wikiModuleCaseFixture(id, entry, core) {
  const refs = (...spans) => spans.map(({ evidence, start, end }) => ({ evidence, start, end }))
  const base = { id: id + '_case', type: 'module-case' }
  if (id === 'core') {
    return { ...base, title: '核对核心函数的返回值', items: [
      { text: '入口触发对 run 的调用。', refs: refs(entry) },
      { text: 'run 执行返回表达式，把计算结果交给调用方。', refs: refs(core) },
    ], boundary: { condition: '调用方直接执行 run()', result: '核心函数求值并返回 42。', refs: refs(core) },
    change: { goal: '修改 run 的返回结果。', location: 'core.js 中 run 的返回表达式。', refs: refs(core) },
    verification: { action: '单独导入并调用 run()。', expected: '调用方得到数字 42。', refs: refs(core) } }
  }
  return { ...base, title: '从入口追踪一次核心调用', items: [
    { text: 'main.js 从 core.js 导入 run。', refs: refs(entry) },
    { text: '入口执行 run()，触发核心实现。', refs: refs(entry, core) },
  ], boundary: { condition: '入口文件被加载并执行。', result: 'run 在入口的调用点执行。', refs: refs(entry) },
  change: { goal: '调整入口触发的调用。', location: 'main.js 中调用 run 的表达式。', refs: refs(entry) },
  verification: { action: '在 run 上设置断点，再加载 main.js。', expected: '断点显示来自 main.js 的调用。', refs: refs(entry, core) } }
}

export function withWikiModuleCases(draft, { entry, core }) {
  return { ...draft, chapters: draft.chapters.map(chapter => ['entry', 'execution', 'core'].includes(chapter.id)
    ? { ...chapter, blocks: [...chapter.blocks, wikiModuleCaseFixture(chapter.id, entry, core)] } : chapter) }
}

const designKinds = { overview: 'scenario', architecture: 'component', entry: 'sequence', execution: 'sequence', core: 'component' }

export function withChapterDiagramPlan(plan) {
  return { ...plan, chapters: plan.chapters.map(chapter => ({ ...chapter,
    diagrams: [{ kind: designKinds[chapter.id], question: chapter.question }],
  })) }
}

export function withChapterDiagrams(draft, { docs, entry, core }) {
  const refs = (...spans) => spans.map(({ evidence, start, end }) => ({ evidence, start, end }))
  return { ...draft, chapters: draft.chapters.map(chapter => {
    const kind = designKinds[chapter.id]
    const diagram = wikiDiagramFixture({ docs, entry, core }, kind)
    const overview = chapter.id === 'overview'
    if (!overview) diagram.edges[0] = { ...diagram.edges[0], label: 'run()', refs: refs(entry, core),
      contract: { entry: 'run()', input: 'Invocation with no arguments.', output: 'Returns the number 42.' } }
    if (chapter.id === 'architecture') diagram.edges.push({ from: 'core', to: 'entry', label: 'Export run',
      refs: refs(entry, core), contract: { entry: 'export const run', input: 'Import the named binding from core.js.', output: 'The callable function.' } })
    const note = { id: chapter.id + '_design', type: 'design-note', refs: overview ? refs(docs) : refs(entry, core),
      answer: 'The entry delegates the calculation to the core export.', rules: [
        { rule: 'The call occurs in main.js.', consequence: 'Trace main.js before investigating run.', refs: refs(entry) },
        { rule: 'The core supplies the return value.', consequence: 'Changing the return only requires an edit in core.js.', refs: refs(core) },
      ] }
    return { ...chapter, blocks: [...chapter.blocks, note, { ...diagram, id: chapter.id + '_diagram' }] }
  }) }
}

export function wikiDraftFixture({ docs, entry, core }) {
  const ref = span => ({ evidence: span.evidence, start: span.start, end: span.end })
  const refs = span => [ref(span)]
  return {
    chapters: [{ id: 'overview', title: '项目概览', blocks: [
      { id: 'purpose_text', type: 'paragraph', claimType: 'purpose', text: '这个项目提供一个可重复调用的示例入口，帮助读者理解模块之间的实际调用。', refs: refs(docs) },
      { id: 'usage_steps', type: 'steps', claimType: 'usage', refs: refs(docs), items: [
        { text: '先阅读项目说明，确认示例入口的用途。', refs: refs(docs) },
        { text: '再从 main.js 的调用进入核心实现。', refs: refs(entry) },
      ] },
      { id: 'layout_table', type: 'table', claimType: 'usage', columns: ['文件', '职责'], rows: [['main.js', '调用核心函数'], ['core.js', '提供执行实现']], refs: refs(docs) },
    ] }, { id: 'architecture', title: '系统组成', blocks: [
      { id: 'architecture_text', type: 'paragraph', claimType: 'implementation', text: '入口只负责转交，核心实现独立于入口文件，样例由此形成一条单向调用。', refs: [...refs(entry), ...refs(core)] },
    ] }, { id: 'execution', title: '示例入口', blocks: [
      { id: 'execution_text', type: 'paragraph', claimType: 'implementation', text: 'main.js 导入核心函数，并在入口调用它。核心实现独立于入口文件。', inlineCode: ['main.js'], refs: refs(entry) },
      { id: 'roles', type: 'table', claimType: 'implementation', columns: ['组件', '职责'], rows: [['入口', '调用核心函数'], ['核心', '提供执行实现']], refs: [...refs(entry), ...refs(core)] },
      { id: 'core_code', type: 'code', claimType: 'implementation', caption: '以下是实际读取的核心实现。', refs: refs(core) },
    ] }, { id: 'core', title: '核心实现', blocks: [
      { id: 'core_text', type: 'paragraph', claimType: 'implementation', text: '核心文件导出 run，供入口调用并返回计算结果。', refs: refs(core) },
      { id: 'core_table', type: 'table', claimType: 'implementation', columns: ['符号', '职责'], rows: [['run', '返回计算结果'], ['helper', '转出辅助实现']], refs: refs(core) },
    ] }],
    coverage: [{ area: 'purpose', refs: refs(docs) }, { area: 'execution', refs: [...refs(entry), ...refs(core)] }],
    graph: { layers: [{ title: '入口', nodes: [{ id: 'entry', title: '入口', kind: 'entry', summary: '调用核心函数。', technology: 'JavaScript', boundary: '进程内模块', refs: refs(entry) }] },
      { title: '实现', nodes: [{ id: 'core', title: '核心', kind: 'core', summary: '提供执行实现。', technology: 'JavaScript', boundary: '进程内模块', refs: refs(core) },
        { id: 'result', title: '返回值', kind: 'data', summary: '提供核心执行结果。', technology: 'JavaScript', boundary: '进程内值', refs: refs(core) }] }],
    edges: [{ from: 'entry', to: 'core', kind: 'call', label: '导入并调用', refs: refs(entry) },
      { from: 'core', to: 'result', kind: 'data', label: '返回计算结果', refs: refs(core) }] },
  }
}

export const approvedWikiReview = () => ({ approved: true, issues: [] })
