import { fromMarkdown } from 'mdast-util-from-markdown'
import { replaceChapterText } from './chapter-figures.mjs'

function embeddedDiagram(node) {
  return node.type === 'image' || node.type === 'imageReference'
    || (node.type === 'code' && /^(?:mermaid|graphviz|dot|plantuml)$/i.test(node.lang ?? ''))
    || node.children?.some(embeddedDiagram)
}

const placeholderText = [
  /^(?:本章|章节)(?:已|已经)?(?:生成|完成)(?:完成|成功|完毕)?$/u,
  /^(?:探针(?:验证|检查|测试|调试|核对|提交|成功|通过)?|(?:测试|验证|检查|调试|核对)引用(?:有效|正确|可用|成功|通过)?|引用(?:测试|验证|检查|调试|核对)(?:成功|通过)?)$/u,
  /^(?:待生成|待补充|正文待补充|暂无内容|占位(?:文字|文本)?|todo|placeholder|probe|(?:citation|reference)(?:test|check|probe)|(?:test|check|probe)(?:citation|reference))$/iu,
]
const probeLabel = /^\s*(?:探针|(?:测试|验证|检查|调试|核对)(?:源码)?引用|引用(?:测试|验证|检查|调试|核对)|(?:citation|reference)\s+(?:test|check|probe))\s*[:：]/iu

function paragraphText(node) {
  if (node.type === 'text') return node.value
  if (node.type === 'break') return '\n'
  return node.children?.map(paragraphText).join('') ?? ''
}

function hasBodyProse(node) {
  if (node.type !== 'paragraph') return node.children?.some(hasBodyProse) ?? false
  const prose = paragraphText(node).replace(/【[^】]*】|\[\[figure:-?\d+\]\]/gu, '')
  return prose.split(/\r?\n/u).some(line => {
    if (/^\s*\|.*\|\s*$/u.test(line)) return false
    return line.split(/[。！？!?]+|\.(?:\s+|$)/u).some(sentence => {
      if (probeLabel.test(sentence)) return false
      const words = sentence.replace(/[^\p{L}\p{N}]+/gu, '')
      return Boolean(words) && !placeholderText.some(pattern => pattern.test(words))
    })
  })
}

export function readWikiMarkdown(value, invalid, { label, proseError, diagramError }) {
  const markdown = typeof value === 'string' ? value.trim() : ''
  if (!markdown || !markdown.isWellFormed()) throw invalid(label + '须为有效的非空 Markdown。')
  const tree = fromMarkdown(markdown)
  if (embeddedDiagram(tree)) throw invalid(diagramError)
  if (!hasBodyProse(tree)) throw invalid(proseError)
  return { markdown, tree }
}

export function rewriteWikiCitations(markdown, tree, replace) {
  return replaceChapterText(markdown, text => text.replace(/【([^】]*)】/gu, (original, value) => {
    const reference = value.trim()
    return /^(?:[\d０-９]+|r[\d０-９]+|r[^\s:：]*\s*[:：][^\r\n]*)$/iu.test(reference)
      ? replace(reference, original) : original
  }), tree)
}
