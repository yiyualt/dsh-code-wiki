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

function reply() {
  return {
    mainline: '调用者把标题交给 normalize，得到去除首尾空格的标题。',
    chapters: [{ title: '标题怎样被清理？', module: 'cleaner', handoff: 1, sources: [{ path, line: 2 }] }],
    overview: {
      markdown: '这个模块通过 `normalize` 入口清理标题【1】。图 1 展示标题处理职责。\n\n[[figure:1]]\n\n图 2 展示公开接口与清理函数之间的调用【1】。\n\n[[figure:2]]',
      sources: [{ path, line: 1 }],
      architecture: {
        title: '标题处理职责',
        areas: [{ label: '标题标准化', components: [{ label: 'cleanTitle', responsibility: '去除标题首尾的空格', source: 1 }] }],
      },
      diagram: {
        kind: 'component', title: '公开接口调用标题清理函数',
        nodes: [{ id: 'entry', label: 'normalize', role: 'interface' }, { id: 'cleaner', label: 'cleanTitle', role: 'component' }],
        edges: [{ from: 'entry', to: 'cleaner', label: '清理标题', source: 1 }],
      },
    },
  }
}

function authorFor(respond) {
  const prompts = []
  const status = { opened: 0, disposed: 0 }
  return {
    prompts, status,
    async openAuthor({ tools }) {
      status.opened += 1
      const read = tools.find(tool => tool.name === 'wiki_read')
      return {
        async reply(prompt) {
          prompts.push(prompt)
          if (prompts.length === 1) await read.execute({ path, count: 2 })
          return JSON.stringify(respond(prompts.length))
        },
        async dispose() { status.disposed += 1 },
      }
    },
  }
}

test('generates both source-backed diagrams and maps RQs to their module handoff in one turn', async () => {
  const author = authorFor(reply)
  const result = await generateOutline({ repository, openAuthor: author.openAuthor, instructions: '' })
  assert.deepEqual(author.status, { opened: 1, disposed: 1 })
  assert.equal(author.prompts.length, 1)
  assert.deepEqual(result.chapters, [{
    title: '标题怎样被清理？', sources: [{ path, line: 2 }], markdown: '',
    connection: { module: 'cleanTitle', from: 'normalize', to: 'cleanTitle', handoff: '清理标题' },
  }])
  assert.deepEqual(Object.keys(result.overview), ['markdown', 'sources', 'diagrams'])
  assert.equal(result.overview.markdown, reply().overview.markdown)
  assert.deepEqual(result.overview.sources, [{ path, line: 1 }])
  assert.equal(result.commit, repository.commit)
  assert.deepEqual(result.overview.diagrams.map(({ kind, slot }) => [kind, slot]), [['architecture', 1], ['component', 2]])
  for (const diagram of result.overview.diagrams) {
    assert.ok(diagram.svg.startsWith('<svg'))
    assert.ok(diagram.svg.includes(`/blob/${repository.commit}/${path}#L1`))
    assert.match(diagram.svg, /源码【1】 index\.js:1/u)
  }
})

test('asks for a correction in the same session when an overview source was never read', async () => {
  const author = authorFor(turn => {
    const result = reply()
    if (turn === 1) result.overview.sources[0].line = 3
    return result
  })
  const result = await generateOutline({ repository, openAuthor: author.openAuthor, instructions: '' })
  assert.equal(author.prompts.length, 2)
  assert.match(author.prompts[1], /overview\.sources/u)
  assert.deepEqual(author.status, { opened: 1, disposed: 1 })
  assert.equal(result.overview.sources[0].line, 1)
})

test('requires a valid module diagram and preserves the precise error after retry', async () => {
  const author = authorFor(() => {
    const result = reply()
    result.overview.diagram.edges[0].source = 2
    return result
  })
  await assert.rejects(generateOutline({ repository, openAuthor: author.openAuthor, instructions: '' }), {
    code: 'wiki-outline-invalid', message: /总览模块交接图/u,
  })
  assert.equal(author.prompts.length, 2)
  assert.deepEqual(author.status, { opened: 1, disposed: 1 })
})

test('corrects an RQ whose chosen physical edge does not touch its module', async () => {
  const author = authorFor(turn => {
    const result = reply()
    result.overview.diagram.nodes.push({ id: 'result', label: '标题结果', role: 'interface' })
    result.overview.diagram.edges.push({ from: 'entry', to: 'result', source: 1, label: '返回标题' })
    if (turn === 1) result.chapters[0].handoff = 2
    return result
  })
  const result = await generateOutline({ repository, openAuthor: author.openAuthor, instructions: '' })
  assert.equal(author.prompts.length, 2)
  assert.match(author.prompts[1], /第 2 条交接（entry → result）须连接 module「cleaner」/u)
  assert.equal(result.chapters[0].connection.handoff, '清理标题')
})

test('requires the logical and physical diagrams at distinct ordered Markdown slots', async () => {
  const author = authorFor(() => {
    const result = reply()
    result.overview.markdown = result.overview.markdown.replace('[[figure:2]]', '[[figure:1]]')
    return result
  })
  await assert.rejects(generateOutline({ repository, openAuthor: author.openAuthor, instructions: '' }), {
    code: 'wiki-outline-invalid', message: /\[\[figure:1\]\].*\[\[figure:2\]\]/u,
  })
})
