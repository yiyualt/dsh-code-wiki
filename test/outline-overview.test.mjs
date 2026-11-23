import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateOutline } from '../skills/repo-design-wiki/scripts/generate-outline.mjs'

const path = 'index.js'
const repository = {
  label: 'normalize-title',
  commit: '1'.repeat(40),
  webUrl: 'https://github.com/example/normalize-title',
  paths: [path],
  read: async () => 'export const normalize = title => cleanTitle(title)\nfunction cleanTitle(title) { return title.trim() }\n',
}
const malformedTurn = { kind: 'error', text: null, modelFailed: true, malformedResponse: true }

function submissions() {
  return {
    overview: {
      mainline: '调用者把标题交给 normalize，得到去除首尾空格的标题。',
      markdown: '这个模块通过 `normalize` 入口清理标题【1】。图 1 展示标题处理职责。\n\n[[figure:1]]\n\n图 2 展示公开接口与清理函数之间的调用【1】。\n\n[[figure:2]]',
      sources: [{ path, line: 1 }],
    },
    architecture: {
      title: '标题处理职责',
      areas: [{ label: '标题标准化', components: [{ label: 'cleanTitle', responsibility: '去除标题首尾的空格', source: 1 }] }],
    },
    module_map: {
      kind: 'component', title: '公开接口调用标题清理函数',
      nodes: [{ id: 'entry', label: 'normalize', role: 'interface' }, { id: 'cleaner', label: 'cleanTitle', role: 'component' }],
      edges: [{ from: 'entry', to: 'cleaner', label: '清理标题', source: 1 }],
    },
    outline: {
      chapters: [{ title: '标题怎样被清理？', module: 'cleaner', handoff: 1, sources: [{ path, line: 2 }] }],
    },
  }
}

function authorFor(work) {
  const prompts = []
  const status = { opened: 0, disposed: 0 }
  return {
    prompts, status,
    async openAuthor({ tools }) {
      status.opened += 1
      const toolByName = new Map(tools.map(tool => [tool.name, tool]))
      async function call(name, input) {
        const tool = toolByName.get(name)
        assert.ok(tool, 'Missing tool ' + name)
        return JSON.parse((await tool.execute(input)).data)
      }
      return {
        async run(prompt) {
          prompts.push(prompt)
          const turn = prompts.length
          if (turn === 1) {
            const read = await call('wiki_read', { path, count: 2 })
            assert.equal(read.end, 2)
          }
          const outcome = await work({ call, prompt, turn })
          return { kind: 'completed', text: '', modelFailed: false, pendingTool: false, ...outcome }
        },
        async dispose() { status.disposed += 1 },
      }
    },
  }
}

async function accept(call, stage, input) {
  const outcome = await call('wiki_submit_' + stage, input)
  assert.equal(outcome.accepted, true, outcome.error)
}

async function submitAll(call, draft) {
  for (const [stage, input] of Object.entries(draft)) await accept(call, stage, input)
}

function generate(author) {
  return generateOutline({ repository, openAuthor: author.openAuthor, instructions: '' })
}

function assertRepairStages(prompt, stages) {
  const requested = new Set(prompt.match(/\bwiki_submit_[a-z_]+\b/g))
  assert.deepEqual(requested, new Set(stages.map(stage => 'wiki_submit_' + stage)))
}

function assertPinnedDiagrams(diagrams, line) {
  assert.deepEqual(diagrams.map(({ kind, slot }) => [kind, slot]), [['architecture', 1], ['component', 2]])
  for (const diagram of diagrams) {
    assert.ok(diagram.svg.startsWith('<svg'))
    assert.ok(diagram.svg.includes(`/blob/${repository.commit}/${path}#L${line}`))
    assert.ok(diagram.svg.includes(`源码【1】 ${path}:${line}`))
  }
}

test('finishes from tool submissions without parsing final assistant text', async () => {
  const draft = submissions()
  const author = authorFor(async ({ call }) => {
    await submitAll(call, draft)
    return { text: '总览与目录已经提交。' }
  })
  const result = await generate(author)
  assert.deepEqual(author.status, { opened: 1, disposed: 1 })
  assert.equal(author.prompts.length, 1)
  assert.equal(result.commit, repository.commit)
  assert.equal(result.mainline, draft.overview.mainline)
  assert.deepEqual(result.chapters, [{
    title: '标题怎样被清理？', sources: [{ path, line: 2 }], markdown: '',
    connection: { module: 'cleanTitle', from: 'normalize', to: 'cleanTitle', handoff: '清理标题' },
  }])
  assert.deepEqual(Object.keys(result.overview), ['markdown', 'sources', 'diagrams'])
  assert.equal(result.overview.markdown, draft.overview.markdown)
  assert.deepEqual(result.overview.sources, draft.overview.sources)
  assertPinnedDiagrams(result.overview.diagrams, 1)
})

test('repairs only the rejected architecture after a malformed model turn', async () => {
  const draft = submissions()
  let rejection
  const author = authorFor(async ({ call, prompt, turn }) => {
    if (turn === 1) {
      await accept(call, 'overview', draft.overview)
      const invalid = structuredClone(draft.architecture)
      invalid.areas[0].components[0].source = 2
      const outcome = await call('wiki_submit_architecture', invalid)
      assert.equal(outcome.accepted, false)
      assert.match(outcome.error, /总览逻辑架构图/u)
      rejection = outcome.error
      await accept(call, 'module_map', draft.module_map)
      await accept(call, 'outline', draft.outline)
      return malformedTurn
    }
    assert.ok(prompt.includes(rejection))
    assertRepairStages(prompt, ['architecture'])
    await accept(call, 'architecture', draft.architecture)
  })
  const result = await generate(author)
  assert.equal(author.prompts.length, 2)
  assert.deepEqual(author.status, { opened: 1, disposed: 1 })
  assert.equal(result.overview.markdown, draft.overview.markdown)
  assert.equal(result.chapters[0].connection.handoff, '清理标题')
  assertPinnedDiagrams(result.overview.diagrams, 1)
})

test('does not return partial results when the RQ still lacks a valid module handoff', async () => {
  const draft = submissions()
  draft.module_map.nodes.push({ id: 'result', label: '标题结果', role: 'interface' })
  draft.module_map.edges.push({ from: 'entry', to: 'result', source: 1, label: '返回标题' })
  draft.outline.chapters[0].handoff = 2
  let rejection
  const author = authorFor(async ({ call, prompt, turn }) => {
    if (turn === 1) {
      await accept(call, 'overview', draft.overview)
      await accept(call, 'architecture', draft.architecture)
      await accept(call, 'module_map', draft.module_map)
    } else {
      assert.ok(prompt.includes(rejection))
      assertRepairStages(prompt, ['outline'])
    }
    const outcome = await call('wiki_submit_outline', draft.outline)
    assert.equal(outcome.accepted, false)
    assert.match(outcome.error, /第 2 条交接（entry → result）须连接 module「cleaner」/u)
    rejection = outcome.error

    // The old full-JSON message contains a valid outline. It cannot supply a missing tool submission.
    const text = JSON.stringify({
      mainline: draft.overview.mainline,
      overview: { ...draft.overview, architecture: draft.architecture, diagram: draft.module_map },
      chapters: submissions().outline.chapters,
    })
    return { text }
  })
  await assert.rejects(generate(author), error => {
    assert.equal(error.code, 'wiki-outline-invalid')
    assert.ok(error.message.includes(rejection))
    return true
  })
  assert.equal(author.prompts.length, 2)
  assert.deepEqual(author.status, { opened: 1, disposed: 1 })
})

test('fails after a second malformed turn with required submissions still missing', async () => {
  const draft = submissions()
  const author = authorFor(async ({ call, prompt, turn }) => {
    if (turn === 1) await accept(call, 'overview', draft.overview)
    else assertRepairStages(prompt, ['architecture', 'module_map', 'outline'])
    return malformedTurn
  })
  await assert.rejects(generate(author), { code: 'wiki-outline-invalid' })
  assert.equal(author.prompts.length, 2)
  assert.deepEqual(author.status, { opened: 1, disposed: 1 })
})

test('keeps repairing after token exhaustion when each turn accepts another stage', async () => {
  const stages = Object.entries(submissions())
  const author = authorFor(async ({ call, prompt, turn }) => {
    const pending = stages.slice(turn - 1)
    const [[stage, input]] = pending
    if (turn > 1) assertRepairStages(prompt, pending.map(([name]) => name))
    await accept(call, stage, input)
    if (pending.length > 1) return { kind: 'max-tokens' }
  })
  const result = await generate(author)
  assert.equal(author.prompts.length, stages.length)
  assert.deepEqual(author.status, { opened: 1, disposed: 1 })
  assertPinnedDiagrams(result.overview.diagrams, 1)
  assert.equal(result.chapters[0].connection.handoff, '清理标题')
})

test('resubmits the RQ after changing its accepted module map', async () => {
  const draft = submissions()
  const revised = structuredClone(draft.module_map)
  revised.nodes[1].label = 'cleanTitle 实现'
  revised.edges[0].label = '去除首尾空格'
  const author = authorFor(async ({ call, prompt, turn }) => {
    if (turn === 1) {
      await submitAll(call, draft)
      await accept(call, 'module_map', revised)
    } else {
      assertRepairStages(prompt, ['outline'])
      await accept(call, 'outline', draft.outline)
    }
  })
  const result = await generate(author)
  assert.equal(author.prompts.length, 2)
  assert.deepEqual(result.chapters[0].connection, {
    module: 'cleanTitle 实现', from: 'normalize', to: 'cleanTitle 实现', handoff: '去除首尾空格',
  })
  assert.match(result.overview.diagrams[1].svg, /去除首尾空格/u)
  assertPinnedDiagrams(result.overview.diagrams, 1)
})

test('revalidates both diagrams and the RQ after changing overview sources', async () => {
  const draft = submissions()
  const revised = { ...draft.overview, sources: [{ path, line: 2 }] }
  const author = authorFor(async ({ call, prompt, turn }) => {
    if (turn === 1) {
      await submitAll(call, draft)
      await accept(call, 'overview', revised)
    } else {
      assertRepairStages(prompt, ['architecture', 'module_map', 'outline'])
      await accept(call, 'architecture', draft.architecture)
      await accept(call, 'module_map', draft.module_map)
      await accept(call, 'outline', draft.outline)
    }
  })
  const result = await generate(author)
  assert.equal(author.prompts.length, 2)
  assert.deepEqual(result.overview.sources, revised.sources)
  assertPinnedDiagrams(result.overview.diagrams, 2)
  for (const diagram of result.overview.diagrams) assert.ok(!diagram.svg.includes(`/${path}#L1`))
  assert.equal(result.chapters[0].connection.handoff, '清理标题')
})

test('rejects invalid overview revisions without discarding accepted stages', async () => {
  const draft = submissions()
  const author = authorFor(async ({ call }) => {
    await submitAll(call, draft)
    const duplicate = await call('wiki_submit_overview', {
      ...draft.overview,
      markdown: draft.overview.markdown.replace('[[figure:2]]', '[[figure:1]]'),
    })
    assert.equal(duplicate.accepted, false)
    assert.match(duplicate.error, /\[\[figure:1\]\].*\[\[figure:2\]\]/u)
    const unread = await call('wiki_submit_overview', { ...draft.overview, sources: [{ path, line: 3 }] })
    assert.equal(unread.accepted, false)
    assert.match(unread.error, /(?:sources|源码|wiki_read)/u)
  })
  const result = await generate(author)
  assert.equal(author.prompts.length, 1)
  assert.deepEqual(result.overview.sources, draft.overview.sources)
  assert.equal(result.overview.markdown, draft.overview.markdown)
  assert.equal(result.chapters[0].connection.handoff, '清理标题')
  assertPinnedDiagrams(result.overview.diagrams, 1)
})
