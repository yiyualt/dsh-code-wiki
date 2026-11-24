import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chapterSources } from '../src/chapter-sources.js'

test('saved chapters cite each file once per sentence across inline code', () => {
  const content = {
    markdown: 'CLI 先读取调用参数【1】，再从配置中加载默认值【3】，随后由 `agents` 决定使用哪个前端【2】。下一次调用也检查入口参数【1】。',
    sources: [
      { path: 'cli/main.rs', line: 21 },
      { path: 'cli/main.rs', line: 48 },
      { path: 'core/config.rs', line: 8 },
    ],
    diagrams: [],
  }
  const linked = chapterSources(content, number => `#source-${number}`)
  assert.equal(linked.markdown,
    'CLI 先读取调用参数，再从配置中加载默认值[【2】](#source-2)，随后由 `agents` 决定使用哪个前端[【1】](#source-1)。下一次调用也检查入口参数[【1】](#source-1)。')
  assert.deepEqual(linked.files, ['cli/main.rs', 'core/config.rs'])
})
