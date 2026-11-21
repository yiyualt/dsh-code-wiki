const walkthroughText = value => typeof value === 'string' && value.length <= 1000 && value.trim()
  && !/[\u0000-\u001f]/.test(value)
const walkthroughId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,43}$/.test(value)
const walkthroughList = (value, min, max) => Array.isArray(value) && value.length >= min && value.length <= max

// Accept only the public document fields and use the caller's source-link policy.
export function readWikiWalkthrough(raw, { nodeIds, chapterCount, readRefs }) {
  if (!walkthroughText(raw?.title) || !walkthroughText(raw.objective)
    || !walkthroughList(raw.modules, 2, 6) || !walkthroughList(raw.steps, 3, 10)
    || !walkthroughList(raw.tasks, 2, 2)) return undefined

  function references(value) {
    if (!walkthroughList(value, 1, 6)) return undefined
    const refs = readRefs(value)
    return Array.isArray(refs) && refs.length === value.length ? refs : undefined
  }

  const modules = new Set()
  const moduleRecords = raw.modules.map(module => {
    if (!walkthroughId(module?.node) || !nodeIds.has(module.node) || modules.has(module.node)
      || !walkthroughText(module.entry) || !walkthroughText(module.change)) return undefined
    const { node, chapter, entry, change } = module
    if (chapter !== undefined && (!Number.isSafeInteger(chapter) || chapter < 0 || chapter >= chapterCount)) return undefined
    const refs = references(module.refs)
    if (!refs) return undefined
    modules.add(node)
    return { node, ...(chapter !== undefined && { chapter }), entry, change, refs }
  })
  if (!moduleRecords.every(Boolean)) return undefined

  function snapshot(data) {
    if (!walkthroughText(data?.title) || !walkthroughList(data.columns, 2, 5) || !data.columns.every(walkthroughText)
      || !walkthroughList(data.rows, 1, 6) || !data.rows.every(row => Array.isArray(row) && row.length === data.columns.length
        && row.every(walkthroughText))) return undefined
    const refs = references(data.refs)
    return refs && { title: data.title, columns: data.columns, rows: data.rows, refs }
  }

  const steps = new Set(), usedModules = new Set()
  const stepRecords = raw.steps.map(step => {
    if (!walkthroughId(step?.id) || steps.has(step.id) || !modules.has(step.module)
      || ![step.title, step.action, step.outcome].every(walkthroughText)) return undefined
    const refs = references(step.refs)
    const data = step.data === undefined ? undefined : snapshot(step.data)
    if (!refs || step.data !== undefined && !data) return undefined
    steps.add(step.id)
    usedModules.add(step.module)
    return { id: step.id, module: step.module, title: step.title, action: step.action, outcome: step.outcome,
      refs, ...(data && { data }) }
  })
  if (!stepRecords.every(Boolean) || usedModules.size !== modules.size || !stepRecords[0].data
    || !stepRecords.at(-1).data || stepRecords.filter(step => step.data).length < 3) return undefined

  const kinds = new Set()
  const tasks = raw.tasks.map(task => {
    if (!['feature', 'debug'].includes(task?.kind) || kinds.has(task.kind)
      || !walkthroughText(task.title) || !walkthroughText(task.summary) || !walkthroughList(task.steps, 1, 5)
      || new Set(task.steps).size !== task.steps.length || !task.steps.every(step => steps.has(step))) return undefined
    const refs = references(task.refs)
    if (!refs) return undefined
    kinds.add(task.kind)
    return { kind: task.kind, title: task.title, summary: task.summary, steps: task.steps, refs }
  })
  if (!tasks.every(Boolean)) return undefined

  return { title: raw.title, objective: raw.objective, modules: moduleRecords, steps: stepRecords, tasks }
}
