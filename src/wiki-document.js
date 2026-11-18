import { isDeepStrictEqual } from 'node:util'

export const wikiInvalid = message => Object.assign(new Error(message), { code: 'model-output-invalid' })
const check = (condition, message) => { if (!condition) throw wikiInvalid(message) }
const id = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,43}$/.test(value)
const prose = (value, maximum, field) => {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), `${field} 必须为 1–${maximum} 字符的文字。`)
  return value.trim().replace(/\s+/g, ' ')
}
const list = (value, minimum, maximum, field) => {
  check(Array.isArray(value) && value.length >= minimum && value.length <= maximum,
    `${field} 需要 ${minimum}–${maximum} 项，不能静默省略内容。`)
  return value
}
const escape = value => value.replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&')
const publicRefs = refs => refs.map(({ label, url }) => ({ label, url }))
export const wikiViewKinds = ['flow', 'sequence', 'dataflow', 'dependency', 'scenario', 'deployment']
const viewRoles = new Set(['actor', 'component', 'process', 'data', 'store'])
function inline(value, terms = []) {
  if (!terms.length) return escape(value)
  const pattern = new RegExp('(' + terms.toSorted((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g')
  return value.split(pattern).map(part => terms.includes(part) ? '`' + part + '`' : escape(part)).join('')
}

export function normalizeWikiPlan(raw, source) {
  const paths = new Set(source.tree.filter(entry => entry.type === 'blob').map(entry => entry.path))
  const directories = new Set(source.tree.filter(entry => entry.type === 'tree').map(entry => entry.path.replace(/\/$/, '')))
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
  }
  const invalidPaths = new Map()
  const chapterIds = new Set(), areaIds = new Set()
  const chapters = list(raw?.chapters, 2, 8, '研究提纲章节').map(chapter => {
    check(id(chapter?.id) && !chapterIds.has(chapter.id), '研究提纲章节编号必须唯一。')
    chapterIds.add(chapter.id)
    return { id: chapter.id, title: prose(chapter.title, 80, '章节标题'), question: prose(chapter.question, 300, '章节要回答的问题') }
  })
  const research = list(raw.research, 2, 8, '研究领域').map(area => {
    check(id(area?.id) && !areaIds.has(area.id), '研究领域编号必须唯一。')
    areaIds.add(area.id)
    check(['documentation', 'implementation'].includes(area.evidenceType), '研究领域必须说明需要项目说明还是实现证据。')
    return { id: area.id, question: prose(area.question, 300, '研究问题'), evidenceType: area.evidenceType,
      paths: list(area.paths, 1, 6, '待读文件').map(path => {
        if (!paths.has(path)) {
          const display = typeof path === 'string' ? path : String(path)
          const directory = typeof path === 'string' && directories.has(path.replace(/\/$/, ''))
          invalidPaths.set(display, `${directory ? '目录' : '不存在文件'}：${display.slice(0, 300)}`)
        }
        return path
      }) }
  })
  check(!invalidPaths.size, '研究计划只能选择当前提交中实际存在的文件。无效候选：'
    + [...invalidPaths.values()].join('；') + '。目录请先用 wiki_list 查看，再选择具体文件。')
  const kinds = new Set()
  const views = list(raw.views, 0, 3, '计划视图').map(view => {
    check(wikiViewKinds.includes(view?.kind) && !kinds.has(view.kind), '计划应选择不同且适用的软件视图类型。')
    kinds.add(view.kind)
    return { kind: view.kind, question: prose(view.question, 300, '视图要回答的问题'), why: prose(view.why, 350, '选择该视图的理由') }
  })
  const viewOmission = views.length ? undefined : prose(raw.viewOmission, 350, '不使用额外视图的理由')
  return { audience: prose(raw.audience, 250, '读者'), goal: prose(raw.goal, 350, '阅读目标'), chapters, research, views,
    ...(viewOmission && { viewOmission }) }
}

function references(raw, source, evidence, primary, field) {
  const original = list(raw, 1, 4, field).map((ref, index) => {
    const object = ref !== null && typeof ref === 'object' && !Array.isArray(ref)
    const integers = object && [ref.evidence, ref.start, ref.end].every(Number.isSafeInteger)
    const file = integers ? evidence[ref.evidence - 1] : undefined
    check(file && (!primary || file.primary)
      && ref.start >= file.start && ref.end <= file.end && ref.end >= ref.start,
    `${field}[${index}] 必须引用已读取范围内的有效${primary ? '实现' : ''}证据。请补读或修改引用，不能丢弃该结论后直接发布。`)
    return { evidence: ref.evidence, start: ref.start, end: ref.end }
  })
  const count = original.reduce((total, ref) => total + Math.ceil((ref.end - ref.start + 1) / 25), 0)
  check(count <= 4, `${field} 完整拆分为 1–25 行引用后需要 ${count} 项，最多允许 4 项。请拆分正文或缩小引用范围，不能丢弃或截断证据。`)
  const expanded = original.flatMap(ref => Array.from({ length: Math.ceil((ref.end - ref.start + 1) / 25) }, (_, index) => ({
    evidence: ref.evidence, start: ref.start + index * 25, end: Math.min(ref.end, ref.start + index * 25 + 24),
  })))
  return expanded.map(ref => {
    const file = evidence[ref.evidence - 1]
    const label = `${file.path}:${ref.start}${ref.end === ref.start ? '' : '–' + ref.end}`
    const path = file.path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,
      char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/')
    const url = source.owner
      ? `https://github.com/${source.owner}/${source.repo}/blob/${source.commit}/${path}#L${ref.start}${ref.end > ref.start ? '-L' + ref.end : ''}`
      : 'https://dsh-code-wiki.invalid/source?' + new URLSearchParams({ key: source.sourceKey, file: ref.evidence, start: ref.start, end: ref.end })
    return { evidence: ref.evidence, start: ref.start, end: ref.end, label, url }
  })
}

export function normalizeWikiDraft(raw, source, evidence, plan) {
  check(plan, '先提交研究计划，再提交草稿。')
  check(JSON.stringify(raw).length <= 70_000, '草稿过长，请集中解释主要问题。')
  const ids = new Set()
  const claim = (value, field) => {
    check(['purpose', 'usage', 'implementation'].includes(value), `${field} 的 claimType 必须为 purpose、usage 或 implementation。`)
    return value
  }
  const chapters = list(raw?.chapters, 2, 8, '草稿章节').map(chapter => {
    check(id(chapter?.id) && !ids.has(chapter.id), '章节编号必须唯一。')
    ids.add(chapter.id)
    return { id: chapter.id, title: prose(chapter.title, 80, '章节标题'), blocks: list(chapter.blocks, 1, 10, '章节正文块').map(block => {
      check(id(block?.id) && !ids.has(block.id), '正文块编号必须唯一。')
      ids.add(block.id)
      const type = block.type
      check(['paragraph', 'steps', 'code', 'table', 'diagram'].includes(type), '正文只接受 paragraph、steps、code、table、diagram。')
      const claimType = claim(block.claimType, block.id)
      const primary = claimType === 'implementation' || type === 'code' || (type === 'diagram' && block.kind !== 'scenario')
      const refs = references(block.refs, source, evidence, primary, `正文 ${block.id} 的引用`)
      const result = { id: block.id, type, claimType, refs }
      if (type === 'paragraph') result.text = prose(block.text, 1800, '段落')
      if (type === 'steps') result.items = list(block.items, 2, 7, '步骤').map(item => ({
        text: prose(item?.text, 700, '步骤说明'), refs: references(item.refs, source, evidence, primary, '步骤引用'),
      }))
      if (type === 'table') {
        result.columns = list(block.columns, 2, 5, '表格列').map(cell => prose(cell, 80, '列标题'))
        result.rows = list(block.rows, 1, 8, '表格行').map(row => {
          check(Array.isArray(row) && row.length === result.columns.length, '表格每行必须与列数一致。')
          return row.map(cell => prose(cell, 250, '表格单元格'))
        })
      }
      if (type === 'code') {
        check(refs.length === 1 && refs[0].end - refs[0].start < 20, `源码示例 ${block.id} 需要单个 1–20 行的真实范围。`)
        const ref = refs[0], file = evidence[ref.evidence - 1]
        result.caption = prose(block.caption, 350, '源码说明')
        result.path = file.path
        result.lines = file.text.split('\n').slice(ref.start - file.start, ref.end - file.start + 1)
        check(result.lines.length === ref.end - ref.start + 1, '源码示例超出已读取内容。')
      }
      if (type === 'diagram') {
        check(wikiViewKinds.includes(block.kind) && plan.views.some(view => view.kind === block.kind), '图示类型必须在研究计划中说明用途和适用理由。')
        check(block.mermaid === undefined, '图示源码由程序生成，不接收模型编写的 Mermaid。')
        const nodeIds = new Set(), connected = new Set(), edgeIds = new Set()
        result.kind = block.kind
        result.title = prose(block.title, 100, '图示标题')
        result.purpose = prose(block.purpose, 450, '图示解释的问题')
        result.nodes = list(block.nodes, 2, 8, '图示节点').map(node => {
          check(id(node?.id) && !nodeIds.has(node.id) && viewRoles.has(node.role), '图示节点需要唯一编号和明确角色。')
          nodeIds.add(node.id)
          return { id: node.id, label: prose(node.label, 60, '图示节点名称'), role: node.role,
            refs: references(node.refs, source, evidence, primary, `图示节点 ${node.id} 的引用`) }
        })
        result.edges = list(block.edges, 1, 10, '图示关系').map(edge => {
          check(nodeIds.has(edge?.from) && nodeIds.has(edge?.to) && edge.from !== edge.to, '图示关系必须指向两个不同的已有节点。')
          const label = prose(edge.label, 60, '图示关系含义')
          const key = `${edge.from}:${edge.to}:${label}`
          check(block.kind === 'sequence' || !edgeIds.has(key), '图示关系不应重复。')
          edgeIds.add(key); connected.add(edge.from); connected.add(edge.to)
          return { from: edge.from, to: edge.to, label, refs: references(edge.refs, source, evidence, primary, '图示关系引用') }
        })
        check(connected.size === nodeIds.size, '图示每个节点都应参与它要解释的关系。')
        if (block.kind === 'scenario') check(result.nodes.some(node => node.role === 'actor'), '用户场景视图需要真实的参与者角色。')
      }
      if (block.inlineCode !== undefined) {
        const content = [result.text, result.caption, ...(result.items?.map(item => item.text) ?? []),
          ...(result.columns ?? []), ...(result.rows?.flat() ?? [])].filter(Boolean).join('\n')
        result.inlineCode = [...new Set((Array.isArray(block.inlineCode) ? block.inlineCode : []).filter(term =>
          typeof term === 'string' && term.length > 0 && term.length <= 80 && !/[`|\r\n\u0000-\u001f]/.test(term)
            && content.includes(term)))].slice(0, 8)
      }
      return result
    }) }
  })
  const diagrams = chapters.flatMap(chapter => chapter.blocks.filter(block => block.type === 'diagram'))
  check(diagrams.length === plan.views.length && new Set(diagrams.map(view => view.kind)).size === plan.views.length,
    '草稿需要逐一回答计划中的视图问题；没有适用视图时应在计划说明理由。')
  const coverage = list(raw.coverage, plan.research.length, plan.research.length, '研究覆盖记录').map(item => {
    const area = plan.research.find(area => area.id === item?.area)
    check(area, '研究覆盖记录必须指向计划中的领域。')
    return { area: area.id, refs: references(item.refs, source, evidence, area.evidenceType === 'implementation', `研究覆盖 ${area.id} 的引用`) }
  })
  check(new Set(coverage.map(item => item.area)).size === plan.research.length, '每个研究领域都需要实际读取的证据，不能重复覆盖同一领域。')
  const nodeIds = new Set()
  const layers = list(raw.graph?.layers, 2, 5, '架构分组').map(layer => ({ title: prose(layer?.title, 80, '架构分组'),
    nodes: list(layer.nodes, 1, 8, '架构节点').map(node => {
      check(id(node?.id) && !nodeIds.has(node.id), '架构节点编号必须唯一。')
      nodeIds.add(node.id)
      return { id: node.id, title: prose(node.title, 80, '组件名'), summary: prose(node.summary, 160, '组件职责'),
        technology: node.technology ? prose(node.technology, 180, '实现技术') : '',
        boundary: node.boundary ? prose(node.boundary, 180, '运行边界') : '',
        refs: references(node.refs, source, evidence, true, `组件 ${node.id} 的引用`) }
    }) }))
  check(nodeIds.size >= 3 && nodeIds.size <= 24, '架构图需要 3–24 个主要组件。')
  const pairs = new Set()
  const edges = list(raw.graph.edges, 2, 24, '架构关系').map(edge => {
    const key = `${edge?.from}:${edge?.to}`
    check(nodeIds.has(edge?.from) && nodeIds.has(edge?.to) && edge.from !== edge.to && !pairs.has(key), '架构关系必须引用两个不同的已有组件，且不可重复。')
    pairs.add(key)
    return { from: edge.from, to: edge.to, label: prose(edge.label, 120, '关系描述'),
      refs: references(edge.refs, source, evidence, true, `关系 ${key} 的引用`) }
  })
  return { chapters, coverage, graph: { layers, edges } }
}

export function reviseWikiDraft(raw, revisions) {
  check(raw && revisions && typeof revisions === 'object', '定向修订需要已有草稿和 revisions。')
  const changes = list(revisions.blocks, 0, 16, '正文修订')
  check(changes.length || revisions.graph || revisions.coverage, '定向修订至少需要一项实际改动。')
  const next = structuredClone(raw)
  const insertedAfter = new Map()
  for (const change of changes) {
    const chapter = next.chapters.find(item => item.id === change?.chapter)
    const index = chapter?.blocks.findIndex(item => item.id === change?.target) ?? -1
    check(index >= 0, '修订必须指向已有章节和正文块：' + String(change?.target).slice(0, 80))
    check(['replace', 'insert_after', 'delete'].includes(change.action), '修订动作需要 replace、insert_after 或 delete。')
    if (change.action === 'delete') chapter.blocks.splice(index, 1)
    else {
      check(change.block && typeof change.block === 'object', '新增或替换正文需要完整 block。')
      check(change.action !== 'replace' || change.block.id === change.target, '替换正文应保留原来的 block.id。')
      if (change.action === 'replace') chapter.blocks.splice(index, 1, structuredClone(change.block))
      else {
        const key = chapter.id + ':' + change.target
        const previous = insertedAfter.get(key) ?? []
        const tail = previous.map(id => chapter.blocks.findIndex(item => item.id === id)).filter(position => position >= 0).at(-1) ?? index
        chapter.blocks.splice(tail + 1, 0, structuredClone(change.block))
        insertedAfter.set(key, [...previous, change.block.id])
      }
    }
  }
  if (revisions.graph !== undefined) next.graph = structuredClone(revisions.graph)
  if (revisions.coverage !== undefined) next.coverage = structuredClone(revisions.coverage)
  check(!isDeepStrictEqual(next, raw), '这次修订没有改变草稿。请在 revisions.blocks 中提交实际正文修改，或修正需要改变的图与覆盖记录。')
  return next
}

export function renderWikiDocument(draft, source) {
  const views = []
  const numbers = new Map()
  const cite = refs => refs.map(ref => {
    if (!numbers.has(ref.url)) numbers.set(ref.url, numbers.size + 1)
    return `[${numbers.get(ref.url)}](${ref.url})`
  }).join(' ')
  const chapters = draft.chapters.map(chapter => {
    const used = new Map()
    const links = refs => { for (const ref of refs) used.set(ref.url, ref); return cite(refs) }
    const blocks = chapter.blocks.map(block => {
      const citation = links(block.refs)
      if (block.type === 'paragraph') return inline(block.text, block.inlineCode) + ' ' + citation
      if (block.type === 'steps') return block.items.map((item, i) => `${i + 1}. ${inline(item.text, block.inlineCode)} ${links(item.refs)}`).join('\n')
      if (block.type === 'table') return '| ' + block.columns.map(cell => inline(cell, block.inlineCode)).join(' | ') + ' |\n| ' + block.columns.map(() => '---').join(' | ') + ' |\n'
        + block.rows.map(row => '| ' + row.map(cell => inline(cell, block.inlineCode)).join(' | ') + ' |').join('\n') + '\n\n' + citation
      if (block.type === 'diagram') {
        const view = { id: block.id, kind: block.kind, title: block.title, purpose: block.purpose,
          nodes: block.nodes.map(node => ({ ...node, refs: publicRefs(node.refs) })),
          edges: block.edges.map(edge => ({ ...edge, refs: publicRefs(edge.refs) })), mermaid: wikiViewMermaid(block) }
        views.push(view)
        const sourceRefs = [...new Map([...block.nodes.flatMap(node => node.refs), ...block.edges.flatMap(edge => edge.refs)]
          .map(ref => [ref.url, ref])).values()]
        return '### ' + escape(block.title) + '\n\n' + escape(block.purpose) + ' ' + citation
          + '\n\n```mermaid\n' + view.mermaid + '\n```\n\n' + links(sourceRefs)
      }
      const fence = '`'.repeat(Math.max(3, ...block.lines.flatMap(line => [...line.matchAll(/`+/g)].map(match => match[0].length + 1))))
      const language = ({ py: 'python', js: 'javascript', ts: 'typescript', rs: 'rust', sh: 'sh' })[block.path.split('.').at(-1)] || ''
      return inline(block.caption, block.inlineCode) + ' ' + citation + '\n\n' + fence + language + '\n' + block.lines.join('\n') + '\n' + fence
    })
    const index = [...used.values()].map(ref => `- [${numbers.get(ref.url)}](${ref.url}) ${escape(ref.label)}`).join('\n')
    return '## ' + escape(chapter.title) + '\n\n' + blocks.join('\n\n') + '\n\n### 本章引用\n\n' + index
  })
  const repository = source.owner ? source.owner + '/' + source.repo : source.repo
  const architecture = { layers: draft.graph.layers.map(layer => ({ ...layer, nodes: layer.nodes.map(node => ({ ...node, refs: publicRefs(node.refs) })) })),
    edges: draft.graph.edges.map(edge => ({ ...edge, refs: publicRefs(edge.refs) })) }
  return { markdown: '# ' + escape(repository) + ' 架构 Wiki\n\n' + chapters.join('\n\n') + '\n', architecture, views }
}

export function wikiViewMermaid(view) {
  const label = value => value.replace(/["#&;<>`{}[\]\\|]/g, char => '#' + char.codePointAt(0) + ';')
  const name = id => 'n_' + id
  if (view.kind === 'sequence') return ['sequenceDiagram', ...view.nodes.map(node =>
    `    ${node.role === 'actor' ? 'actor' : 'participant'} ${name(node.id)} as ${label(node.label)}`),
  ...view.edges.map(edge => `    ${name(edge.from)}->>${name(edge.to)}: ${label(edge.label)}`)].join('\n')
  const nodes = view.nodes.map(node => {
    const text = '"' + label(node.label) + '"'
    const shape = node.role === 'store' ? `[(${text})]` : node.role === 'actor' ? `([${text}])`
      : node.role === 'data' ? `[/${text}/]` : `[${text}]`
    return '    ' + name(node.id) + shape
  })
  return ['flowchart ' + (view.kind === 'flow' ? 'TD' : 'LR'), ...nodes,
    ...view.edges.map(edge => `    ${name(edge.from)} -->|"${label(edge.label)}"| ${name(edge.to)}`)].join('\n')
}

export function wikiTargets(draft) {
  return [...draft.chapters.flatMap(chapter => chapter.blocks.map(block => block.id)),
    ...draft.graph.layers.flatMap(layer => layer.nodes.map(node => 'node:' + node.id)),
    ...draft.graph.edges.map(edge => `edge:${edge.from}:${edge.to}`)]
}

function reviewExcerpts(selected, evidence) {
  const paths = new Map(), groups = new Map(), sourceLines = new Map()
  for (const [order, ref] of selected.entries()) {
    const file = evidence[ref.evidence - 1]
    if (!sourceLines.has(ref.evidence)) sourceLines.set(ref.evidence, file.text.split('\n'))
    const quoted = sourceLines.get(ref.evidence).slice(ref.start - file.start, ref.end - file.start + 1)
    check(quoted.length === ref.end - ref.start + 1, `审核引用 ${ref.evidence}:${ref.start}–${ref.end} 超出实际证据原文。`)
    const lines = paths.get(file.path) ?? new Map()
    paths.set(file.path, lines)
    for (const [index, text] of quoted.entries()) {
      const number = ref.start + index
      check(!lines.has(number) || lines.get(number) === text, `审核证据 ${file.path}:${number} 的重叠原文冲突，不能合并不同内容。`)
      lines.set(number, text)
    }
    // Keep evidence classifications separate; merging must not change what an evidence ID can support.
    const key = JSON.stringify([file.path, file.primary, file.kind])
    const records = groups.get(key) ?? []
    groups.set(key, records)
    records.push({ role: 'citation', id: ref.evidence, path: file.path, start: ref.start, end: ref.end,
      primary: file.primary, kind: file.kind, order })
  }
  const merged = []
  for (const records of groups.values()) {
    let current
    for (const record of records.toSorted((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)) {
      if (!current || record.start > current.end) {
        current = { start: record.start, end: record.end, records: [record] }
        merged.push(current)
      } else {
        current.end = Math.max(current.end, record.end)
        current.records.push(record)
      }
    }
  }
  return merged.map(group => {
    const records = group.records.toSorted((a, b) => a.order - b.order)
    const { order, ...first } = records[0]
    const lines = paths.get(first.path)
    const text = Array.from({ length: group.end - group.start + 1 }, (_, index) => lines.get(group.start + index)).join('\n')
    return { order, value: { ...first, start: group.start, end: group.end, text,
      ...(records.length > 1 && { citations: records.map(({ id, start, end }) => ({ id, start, end })) }) } }
  }).toSorted((a, b) => a.order - b.order).map(item => item.value)
}

export function wikiReviewMaterial(draft, plan, evidence) {
  const selected = [...new Map([...draft.coverage.flatMap(item => item.refs), ...draft.chapters.flatMap(chapter => chapter.blocks.flatMap(block =>
    [...block.refs, ...(block.items?.flatMap(item => item.refs) ?? []), ...(block.nodes?.flatMap(node => node.refs) ?? []),
      ...(block.edges?.flatMap(edge => edge.refs) ?? [])])), ...draft.graph.layers.flatMap(layer => layer.nodes.flatMap(node => node.refs)),
  ...draft.graph.edges.flatMap(edge => edge.refs)].map(ref => [`${ref.evidence}:${ref.start}:${ref.end}`, ref])).values()]
  let remaining = 65_000
  const excerpts = reviewExcerpts(selected, evidence)
  for (const excerpt of excerpts) {
    check(excerpt.text.length <= remaining, '审核材料超过预算，请合并重复引用或缩小范围。')
    remaining -= excerpt.text.length
  }
  const documentOverviews = []
  let overviewRecordsOmitted = 0
  for (const [i, file] of evidence.entries()) {
    if (file.kind !== 'documentation' && (file.kind || file.primary)) continue
    if (remaining <= 0) { overviewRecordsOmitted++; continue }
    const text = file.text.slice(0, Math.min(4_000, remaining))
    remaining -= text.length
    const characterTruncated = text.length < file.text.length
    const lastLineTruncated = characterTruncated && !text.endsWith('\n') && file.text[text.length] !== '\n'
    const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length
    documentOverviews.push({ role: 'documentation-overview', id: i + 1, path: file.path, kind: 'documentation', text,
      sourceRange: { start: file.start, end: file.end }, shownRange: { start: file.start, end: file.start + lines - 1 },
      characters: { original: file.text.length, included: text.length }, characterTruncated, lastLineTruncated })
  }
  return { plan, draft, excerpts, documentOverviews,
    citationInstructions: '同一文件中原文一致的重叠引用会合并展示；citations逐项保留原始证据id、start、end，与草稿refs中的evidence编号对应。各编号只能支持其原始引用范围，不能把合并范围当作单个编号的引用范围。没有citations时使用该摘录的id、start、end。所有引用原文均完整保留。',
    evidenceBudget: { limit: 65_000, characters: 65_000 - remaining, overviewRecordsOmitted } }
}
