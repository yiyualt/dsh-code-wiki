import assert from 'node:assert/strict'
import test from 'node:test'
import { maxWikiMarkdownLength, readMarkdownReply, resolveMarkdownCitations, savedWikiHeadings } from '../skills/repo-design-wiki/scripts/markdown.mjs'

const commit = 'f'.repeat(40)
const github = { owner: 'owner', repo: 'project', commit }
const evidence = [
  { path: 'src/name (v2)#!.js', start: 10, end: 80 },
  { path: 'config.yaml', start: 3, end: 3 },
]
const invalid = { code: 'model-output-invalid' }

test('reads a final standalone status marker and preserves Markdown content', () => {
  assert.deepEqual(readMarkdownReply('# 设计\r\n章节内容  \r\n\r\n<!-- wiki:continue -->\r\n'), {
    markdown: '# 设计\n章节内容  ', complete: false,
  })
  assert.deepEqual(readMarkdownReply('~~~mermaid\nflowchart LR\nA --> B\n~~~\n<!-- wiki:complete -->'), {
    markdown: '~~~mermaid\nflowchart LR\nA --> B\n~~~', complete: true,
  })
  const quote = '> ```text\n> 示例\n> ```'
  assert.deepEqual(readMarkdownReply(quote + '\n<!-- wiki:complete -->'), { markdown: quote, complete: true })
})

test('keeps control-looking text inside code and requires a visible final marker', () => {
  const markdown = '# 设计\n```text\n<!-- wiki:continue -->\n```\n`示例\n<!-- wiki:complete -->\n续`'
  assert.deepEqual(readMarkdownReply(markdown + '\n<!-- wiki:complete -->'), { markdown, complete: true })
  for (const text of [null, '\u0000\n<!-- wiki:complete -->', 'x'.repeat(maxWikiMarkdownLength + 1),
    '纯正文', '正文 <!-- wiki:complete -->', '正文\n<!-- wiki:complete -->\n尾注', ' \n<!-- wiki:complete -->',
    '正文\n<!-- wiki:continue -->\n<!-- wiki:complete -->', '# 设计\n```text\n<!-- wiki:complete -->',
    '```markdown\n正文\n```\n<!-- wiki:complete -->', '~~~text\n正文\n~~~\n<!-- wiki:continue -->',
    '正文\n\n    <!-- wiki:complete -->']) {
    assert.throws(() => readMarkdownReply(text), invalid)
  }
})

test('resolves pinned GitHub evidence and splits line ranges without gaps', () => {
  const base = `https://github.com/owner/project/blob/${commit}/src/name%20%28v2%29%23%21.js`
  const label = 'src/name \\(v2\\)\\#\\!.js'
  assert.equal(resolveMarkdownCitations('接口 [E1:10-61]，配置 [E2:3]。', github, evidence),
    `接口 [${label}:10–34](${base}#L10-L34) [${label}:35–59](${base}#L35-L59) [${label}:60–61](${base}#L60-L61)，配置 [config.yaml:3](https://github.com/owner/project/blob/${commit}/config.yaml#L3)。`)
})

test('resolves evidence for the current local job', () => {
  const sourceKey = '0448e62c-df30-44ca-8031-8bfb4709a899'
  assert.equal(resolveMarkdownCitations('[E2:3]', { sourceKey }, evidence),
    `[config.yaml:3](https://dsh-code-wiki.invalid/source?key=${sourceKey}&file=2&start=3&end=3)`)
})

test('rejects invalid evidence and any range outside its exact read', () => {
  for (const token of ['[E03:3]', '[E0:3]', '[E-2:3]', '[E 2:3]', '[E2:+3]', '[E2:0]', '[E2:3.0]', '[E2:3-]',
    '[E2:3-2]', '[E2:2-3]', '[E2:3-4]', '[E1:9007199254740993]', '[E9007199254740993:3]', '[E3:3]']) {
    assert.throws(() => resolveMarkdownCitations(token, github, evidence), invalid, token)
  }
  assert.throws(() => resolveMarkdownCitations('[E1:1]', github, [{ path: '../outside', start: 1, end: 10 }]), invalid)
})

test('preserves fence, indented and inline code and escaped examples', () => {
  const examples = [
    '`[E9:1]` 和 `` `[E9:2]` `` 和 \\[E9:3]',
    '代码跨行 `前半\n[E9:4]`。',
    '第一个反引号转义 \\``[E9:4]`。',
    '```mermaid\nA --> B: [E9:5]\n```',
    '> ~~~~text\n> [E9:6]\n> ~~~~',
    '- ```js\n  const sample = "[E9:7]"\n  ```',
    '    [E9:8]\n    [E9:9]',
  ].join('\n\n')
  assert.equal(resolveMarkdownCitations(examples + '\n\n实际引用 [E2:3]', github, evidence), examples
    + `\n\n实际引用 [config.yaml:3](https://github.com/owner/project/blob/${commit}/config.yaml#L3)`)
  assert.equal(resolveMarkdownCitations('- ```\n  [E9:10]\n\n[E2:3]', github, evidence), '- ```\n  [E9:10]\n\n'
    + `[config.yaml:3](https://github.com/owner/project/blob/${commit}/config.yaml#L3)`)
  assert.throws(() => resolveMarkdownCitations('未闭合 ` 后面的 [E9:10]', github, evidence), invalid)
})

test('archives images as link text and derives saved titles outside code', () => {
  const markdown = '# Overview\n\n![Report](https://example.test/chart.png)\n\n```python\n# Example\n```\n\n## Next `step`'
  assert.equal(resolveMarkdownCitations(markdown, github, evidence), markdown.replace('![Report]', '\\![Report]'))
  assert.equal(savedWikiHeadings(markdown), '# Overview\n## Next `step`')
})
