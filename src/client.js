window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const { createElement: h } = require('react')
    const { IconCodeOutlineRegular, MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
    const markdown = '__EXAMPLE_MARKDOWN__'
    const labels = {
      code: { copyLabel: '复制', copiedLabel: '已复制' },
      footnotes: '脚注',
    }

    function CodeWikiIcon({ size }) {
      return h(IconCodeOutlineRegular, { size })
    }

    function CodeWikiPage() {
      return h('section', {
        'aria-label': panelTitle,
        style: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' },
      }, h('article', {
        style: {
          boxSizing: 'border-box',
          marginInline: 'auto',
          maxWidth: 800,
          padding: 'clamp(20px, 5vw, 56px)',
        },
      }, h(MarkdownText, { text: markdown, labels, omitHtml: true })))
    }

    return {
      name: panelId,
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: panelId,
        }, CodeWikiPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: panelId,
          label: panelTitle,
          order: 10,
        }, CodeWikiIcon))
      },
    }
  },
})
