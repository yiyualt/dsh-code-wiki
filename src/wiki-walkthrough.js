export function createWikiWalkthroughRenderer(React) {
  const { createElement: h, useId } = React
  const taskLabels = { feature: '功能开发', debug: '调试排查' }
  const relationLabels = { call: '调用', data: '数据流', dependency: '依赖' }

  function SourceRefs({ refs, label }) {
    const byUrl = new Map(refs.map(ref => [ref.url, ref]))
    return h('div', { className: 'dsh-walk-sources', role: 'group', 'aria-label': label },
      [...byUrl.values()].map(ref => h('a', { key: ref.url, href: ref.url, target: '_blank', rel: 'noreferrer' }, ref.label)))
  }

  function DataTable({ data, label }) {
    return h('div', { className: 'dsh-walk-table-scroll', role: 'region', 'aria-label': label, tabIndex: 0 },
      h('table', { 'aria-label': data.title },
        h('thead', null, h('tr', null, data.columns.map((column, i) => h('th', { scope: 'col', key: i }, column)))),
        h('tbody', null, data.rows.map((row, i) => h('tr', { key: i }, row.map((cell, j) => h('td', { key: j }, cell)))))))
  }

  function DataSnapshot({ steps, stepIndex }) {
    const snapshots = steps.slice(0, stepIndex + 1).flatMap((step, i) => step.data ? [{ data: step.data, i }] : [])
    const current = snapshots.at(-1)
    const previous = snapshots.at(-2)
    if (!current) return null
    return h('section', { className: 'dsh-walk-data' },
      h('div', { className: 'dsh-walk-card-heading' },
        h('h4', null, current.data.title),
        h('span', null, '示例数据 · 第 ' + (current.i + 1) + ' 步')),
      current.i < stepIndex && h('p', { className: 'dsh-walk-held' }, '此阶段沿用上一次的数据快照。'),
      h(DataTable, { data: current.data, label: '当前示例数据' }),
      h(SourceRefs, { refs: current.data.refs, label: '当前数据所依据的源码' }),
      current.i === stepIndex && previous && h('details', { key: stepIndex, className: 'dsh-walk-previous' },
        h('summary', null, '对照第 ' + (previous.i + 1) + ' 步 · ' + previous.data.title),
        h(DataTable, { data: previous.data, label: '先前示例数据' }),
        h(SourceRefs, { refs: previous.data.refs, label: '先前数据所依据的源码' })))
  }

  function ModuleView({ graph, modules, selected, selectModule, onSelectChapter, chapterTitles }) {
    const nodes = new Map(graph.layers.flatMap(layer => layer.nodes.map(node => [node.id, node])))
    const selectedModule = modules.find(module => module.node === selected)
    const relations = graph.edges.filter(edge => edge.from === selected || edge.to === selected)
    const selectable = new Set(modules.map(module => module.node))
    const relationNode = node => selectable.has(node) && node !== selected
      ? h('button', { type: 'button', onClick: () => selectModule(node) }, nodes.get(node).title)
      : h('span', { 'data-active': node === selected || undefined }, nodes.get(node).title)
    return h('section', { className: 'dsh-walk-modules' },
      h('div', { className: 'dsh-walk-card-heading' }, h('h4', null, '架构模块')),
      h('ul', { className: 'dsh-walk-module-picker', 'aria-label': '跳转到模块参与的阶段' },
        modules.map(module => h('li', { key: module.node },
          h('button', { type: 'button', 'aria-pressed': module.node === selected,
            onClick: () => selectModule(module.node) }, nodes.get(module.node).title)))),
      h('dl', { className: 'dsh-walk-module-properties' },
        h('div', null, h('dt', null, '实现入口'), h('dd', null, h('code', null, selectedModule.entry))),
        h('div', null, h('dt', null, '修改位置'), h('dd', null, selectedModule.change))),
      relations.length > 0 && h('ul', { className: 'dsh-walk-relations', 'aria-label': '当前模块的架构关系' },
        relations.map((edge, i) => h('li', { key: i },
          h('div', { className: 'dsh-walk-edge' }, relationNode(edge.from),
            h('span', { className: 'dsh-walk-edge-arrow' }, '→'), relationNode(edge.to)),
          h('div', { className: 'dsh-walk-edge-label' }, relationLabels[edge.kind] + ' · ' + edge.label)))),
      h(SourceRefs, { refs: selectedModule.refs, label: '当前模块的源码' }),
      selectedModule.chapter !== undefined && h('button', { className: 'dsh-walk-chapter-link', type: 'button',
        onClick: () => onSelectChapter(selectedModule.chapter) }, '阅读章节 · ' + chapterTitles[selectedModule.chapter]))
  }

  return function WikiWalkthrough({ walkthrough, graph, chapterTitles, onSelectChapter, selection, setSelection }) {
    const titleId = useId()
    const selectId = useId()
    const stageId = useId()
    const { modules, steps, tasks } = walkthrough
    const { index, task } = selection
    const step = steps[index]
    const activeTask = tasks.find(item => item.kind === task)
    const taskSteps = new Set(activeTask?.steps)

    function selectStep(next) {
      setSelection(current => ({ ...current, index: next }))
    }

    function selectModule(node) {
      if (node === step.module) return
      const recommended = steps.findIndex(item => item.module === node && taskSteps.has(item.id))
      selectStep(recommended === -1 ? steps.findIndex(item => item.module === node) : recommended)
    }

    function selectTask(item) {
      setSelection(current => current.task === item.kind ? { ...current, task: null }
        : { task: item.kind, index: steps.findIndex(itemStep => itemStep.id === item.steps[0]) })
    }

    return h('section', { className: 'dsh-code-wiki-walkthrough', 'aria-labelledby': titleId },
      h('header', { className: 'dsh-walk-header' },
        h('h2', { id: titleId }, walkthrough.title),
        h('p', null, walkthrough.objective)),
      h('div', { className: 'dsh-walk-task-area' },
        h('div', { className: 'dsh-walk-tasks', role: 'group', 'aria-label': '按研发任务阅读' },
          tasks.map(item => h('button', { type: 'button', key: item.kind, 'aria-pressed': item.kind === task,
            'aria-controls': stageId, onClick: () => selectTask(item) },
          h('span', null, taskLabels[item.kind]), h('strong', null, item.title)))),
        activeTask && h('div', { className: 'dsh-walk-task-summary' },
          h('p', null, activeTask.summary), h(SourceRefs, { refs: activeTask.refs, label: '任务参考源码' }))),
      h('div', { className: 'dsh-walk-grid' },
        h('nav', { className: 'dsh-walk-timeline', 'aria-label': '执行顺序' },
          h('h3', null, '执行顺序'),
          h('ol', null, steps.map((item, i) => h('li', { key: item.id },
            h('button', { type: 'button', 'aria-current': index === i ? 'step' : undefined,
              'aria-controls': stageId, 'data-recommended': taskSteps.has(item.id) || undefined,
              onClick: () => selectStep(i) }, h('span', { className: 'dsh-walk-step-number', 'aria-hidden': true }, i + 1),
            h('span', null, item.title, taskSteps.has(item.id) && h('small', null, '建议查看'))))))),
        h('div', { className: 'dsh-walk-mobile-picker' },
          h('label', { htmlFor: selectId }, '执行阶段'),
          h('select', { id: selectId, value: index, 'aria-controls': stageId, onChange: event => selectStep(Number(event.target.value)) },
            steps.map((item, i) => h('option', { key: item.id, value: i },
              (i + 1) + '. ' + item.title + (taskSteps.has(item.id) ? ' · 建议查看' : ''))))),
        h('div', { id: stageId, className: 'dsh-walk-stage' },
          h('header', { className: 'dsh-walk-stage-header' },
            h('span', null, '第 ' + (index + 1) + ' / ' + steps.length + ' 步'),
            h('h3', { 'aria-live': 'polite' }, step.title)),
          h('dl', { className: 'dsh-walk-stage-properties' },
            h('div', null, h('dt', null, '操作'), h('dd', null, step.action)),
            h('div', null, h('dt', null, '结果'), h('dd', null, step.outcome))),
          h(SourceRefs, { refs: step.refs, label: '当前执行阶段的源码' }),
          h('div', { className: 'dsh-walk-stage-cards' },
            h(DataSnapshot, { steps, stepIndex: index }),
            h(ModuleView, { graph, modules, selected: step.module, selectModule, onSelectChapter, chapterTitles })),
          h('div', { className: 'dsh-walk-pager' },
            h('button', { type: 'button', disabled: index === 0, onClick: () => selectStep(index - 1) }, '← 上一步'),
            h('button', { type: 'button', disabled: index === steps.length - 1, onClick: () => selectStep(index + 1) }, '下一步 →')))))
  }
}
