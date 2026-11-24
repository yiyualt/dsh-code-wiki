import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeWikiCitations } from '../skills/repo-design-wiki/scripts/wiki-markdown.mjs'

test('prefers a later citation in the same sentence and keeps citations in separate sentences', () => {
  const markdown = '【1】`agents` 打开代理会话【1】。`resume` 加载会话【1】。'
  const expected = '`agents` 打开代理会话【1】。`resume` 加载会话【1】。'
  assert.equal(normalizeWikiCitations(markdown), expected)
  assert.equal(normalizeWikiCitations(expected), expected)
})

test('moves sentence-leading citations after the evidence and before punctuation', () => {
  const markdown = '- 【1】 **前端入口**调用 `select.frontend`。 【2】 返回 `Frontend`\n- 【1】 运行 `agents`!'
  const expected = '- **前端入口**调用 `select.frontend`【1】。 返回 `Frontend`【2】\n- 运行 `agents`【1】!'
  assert.equal(normalizeWikiCitations(markdown), expected)
  assert.equal(normalizeWikiCitations('【1】**前端选择**'), '**前端选择**【1】')
  assert.equal(normalizeWikiCitations('**【1】** 入口运行【1】。'), '入口运行【1】。')
  assert.equal(normalizeWikiCitations('***【1】【2】*** 入口运行【1】。'), '入口运行【1】【2】。')
})

test('moves citations placed after the final punctuation back into their sentence', () => {
  assert.equal(normalizeWikiCitations('入口选择前端【1】。返回结果。【1】'), '入口选择前端【1】。返回结果【1】。')
  assert.equal(normalizeWikiCitations('The app picks a frontend【1】.【1】【2】'), 'The app picks a frontend【1】【2】.')
})

test('maps lines to display numbers before deduplicating and skips unsupported references', () => {
  const numbers = { 1: 1, 2: 1, 3: 2 }
  const markdown = '【1】`agents` 打开会话【2】。会话会保存状态【3】。未知引用【9】。'
  const expected = '`agents` 打开会话【1】。会话会保存状态【2】。未知引用【9】。'
  assert.equal(normalizeWikiCitations(markdown, number => numbers[number]), expected)
})

test('preserves examples and authored links and keeps table cells separate', () => {
  const markdown = [
    '【1】 [文档【1】](https://example.com/x.y) 和 `字面值【1】`。',
    '```js\nconst marker = "【1】"\n```',
    '| 名称 | 说明 |\n| --- | --- |\n| 【1】入口 | 处理会话【1】 |',
    '名称 | 说明\n--- | ---\n【1】入口 | 处理会话【1】',
  ].join('\n\n')
  const expected = [
    '[文档【1】](https://example.com/x.y) 和 `字面值【1】`【2】。',
    '```js\nconst marker = "【1】"\n```',
    '| 名称 | 说明 |\n| --- | --- |\n| 【2】入口 | 处理会话【2】 |',
    '名称 | 说明\n--- | ---\n【2】入口 | 处理会话【2】',
  ].join('\n\n')
  assert.equal(normalizeWikiCitations(markdown, () => 2), expected)
})
