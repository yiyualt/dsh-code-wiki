window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const { createElement: h, Fragment, useEffect, useId, useRef, useState, useSyncExternalStore } = require('react')
    const {
      Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular,
      IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, Input, MarkdownText, Modal,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
    const outlineError = '无法生成目录，请重试。'
    const markdownLabels = {
      code: { copyLabel: '复制', copiedLabel: '已复制' },
      footnotes: '脚注',
    }

    function githubRepository(input) {
      const match = /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]{1,100})\/?$/i.exec(input.trim())
      if (!match) return null
      const [, owner, name] = match
      const repo = name.replace(/\.git$/i, '')
      if (!repo || repo === '.' || repo === '..') return null
      return { source: 'github', title: `${owner}/${repo}`, location: `https://github.com/${owner}/${repo}` }
    }

    function localRepository(location) {
      if (!location) return null
      const title = location.split(/[\\/]/).filter(Boolean).at(-1) || location
      return { source: 'local', title, location }
    }

    async function loadOutline(repository) {
      const input = repository.source === 'github'
        ? { repositoryUrl: repository.location }
        : { repositoryPath: repository.location }
      const response = await fetch(new URL('api/dsh-code-wiki/outline', document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok) {
        return { error: typeof result?.error === 'string' && result.error.trim() ? result.error : outlineError }
      }
      const chapters = result?.chapters
      if (!Array.isArray(chapters) || !chapters.length || chapters.some(chapter =>
        typeof chapter?.title !== 'string' || !chapter.title.trim() || typeof chapter.markdown !== 'string')) {
        return { error: outlineError }
      }
      return { chapters }
    }

    function createWikiStore(pickDirectory) {
      let snapshot = {
        draft: { source: 'github', repositoryUrl: '', repositoryPath: '' },
        view: 'library', document: null, chapterIndex: 0, picker: null, generatingOutline: false, error: '',
      }
      const listeners = new Set()

      function update(patch) {
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener()
      }

      function changeDraft(patch) {
        update({ draft: { ...snapshot.draft, ...patch }, picker: null, error: '' })
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        changeDraft,
        toggleForm() {
          if (snapshot.generatingOutline) return
          update({ view: snapshot.view === 'form' ? 'library' : 'form', error: '' })
        },
        returnToLibrary: () => update({ view: 'library' }),
        openDocument: () => update({ chapterIndex: 0, view: 'reader' }),
        selectChapter(chapterIndex) {
          if (snapshot.document?.chapters[chapterIndex] && snapshot.chapterIndex !== chapterIndex) update({ chapterIndex })
        },
        async chooseFolder() {
          if (snapshot.picker || snapshot.generatingOutline) return
          update({ picker: 'native', error: '' })
          const failure = { picker: null, error: '无法打开文件夹选择器，请重试。' }
          try {
            const result = await pickDirectory()
            if (result.ok) changeDraft(result.value ? { repositoryPath: result.value } : {})
            else if (result.error.code === 'directory-picker/unavailable') update({ picker: 'browser' })
            else update(failure)
          } catch {
            update(failure)
          }
        },
        async generateDocument() {
          const { draft, picker, generatingOutline } = snapshot
          if (picker || generatingOutline) return
          const local = draft.source === 'local'
          const repository = local ? localRepository(draft.repositoryPath) : githubRepository(draft.repositoryUrl)
          if (!repository) {
            update({ error: local ? '请选择本地仓库文件夹。' : '请输入公开 GitHub 仓库地址，例如 https://github.com/openai/codex。' })
            return
          }

          update({ generatingOutline: true, error: '' })
          try {
            const { chapters, error } = await loadOutline(repository)
            if (error) {
              update({ generatingOutline: false, error })
              return
            }
            update({ document: { ...repository, chapters }, chapterIndex: 0, view: 'reader', generatingOutline: false })
          } catch {
            update({ generatingOutline: false, error: outlineError })
          }
        },
      }
    }

    function FolderBrowser({ listDirectory, onPick, onClose }) {
      const [request, setRequest] = useState({ path: undefined })
      const [result, setResult] = useState(null)
      const loading = result?.request !== request
      const failed = !loading && result.failed
      const listing = result?.listing
      const visit = path => setRequest({ path })

      useEffect(() => {
        const controller = new AbortController()
        async function browse() {
          try {
            const directory = await listDirectory(request.path, controller.signal)
            if (!controller.signal.aborted) setResult({ request, listing: directory })
          } catch {
            if (!controller.signal.aborted) {
              setResult(previous => ({ request, listing: previous?.listing, failed: true }))
            }
          }
        }
        void browse()
        return () => controller.abort()
      }, [listDirectory, request])

      return h(Modal, {
        open: true, onClose, title: '选择仓库文件夹', closeLabel: '关闭',
        footer: h(Fragment, null,
          h(Button, { 'data-modal-autofocus': '', onClick: onClose }, '取消'),
          h(Button, { variant: 'primary', disabled: loading || !listing, onClick: () => onPick(listing.path) }, '选择此文件夹')),
      },
      listing && h('nav', { 'aria-label': '文件夹路径', className: 'dsh-code-wiki-folder-crumbs' },
        listing.crumbs.map(crumb => crumb.path === listing.path
          ? h('span', { key: crumb.path, 'aria-current': 'location' }, crumb.name)
          : h(Button, { key: crumb.path, size: 'sm', disabled: loading, onClick: () => visit(crumb.path) }, crumb.name))),
      loading && h('p', { role: 'status' }, '正在读取文件夹…'),
      failed && h('div', { role: 'alert' }, '无法读取此文件夹。',
        h(Button, { size: 'sm', onClick: () => visit(request.path) }, '重试')),
      listing && h('ul', { 'aria-label': '子文件夹', className: 'dsh-code-wiki-folder-list' },
        listing.entries.map(entry => h('li', { key: entry.path }, h(Button, {
          size: 'sm', icon: h(IconFolderCloseRegular, { size: 16 }),
          disabled: loading, onClick: () => visit(entry.path),
        }, entry.name)))),
      listing && !loading && !listing.entries.length && h('p', null, '此文件夹没有子文件夹。'),
      listing?.truncated && h('p', null, '此处仅显示部分文件夹。'))
    }

    function SourceForm({ id, draft, onChange, onSubmit, error, picker, generatingOutline, onChooseFolder, listDirectory }) {
      const sourceId = useId()
      const titleId = useId()
      const heading = useRef(null)
      const local = draft.source === 'local'
      const ready = local ? draft.repositoryPath : draft.repositoryUrl.trim()
      const busy = Boolean(picker) || generatingOutline
      useEffect(() => { heading.current?.focus() }, [])

      return h('section', { id, className: 'dsh-code-wiki-form-card', 'aria-labelledby': titleId },
        h('h2', { id: titleId, ref: heading, tabIndex: -1 }, '新建 Wiki'),
        h('form', {
          className: 'dsh-code-wiki-form',
          'aria-busy': generatingOutline,
          onSubmit(event) {
            event.preventDefault()
            onSubmit()
          },
        },
        h('fieldset', { disabled: busy },
          h('legend', null, '仓库来源'),
          h('div', { className: 'dsh-code-wiki-source-options' },
            [['github', 'GitHub 地址'], ['local', '本地仓库']].map(([value, label]) => h('label', { key: value },
              h('input', { type: 'radio', name: sourceId, value, checked: draft.source === value, onChange: () => onChange({ source: value }) }),
              h('span', null, label))))),
        local ? h('div', { className: 'dsh-code-wiki-field' },
          h('span', null, '本地 Git 仓库'),
          h('div', { className: 'dsh-code-wiki-folder-field' },
            h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: onChooseFolder },
              draft.repositoryPath ? '更换文件夹' : '选择文件夹'),
            draft.repositoryPath && h('span', { title: draft.repositoryPath }, draft.repositoryPath)))
          : h('label', { className: 'dsh-code-wiki-field' },
            h('span', null, '公开 GitHub 仓库地址'),
            h(Input, { type: 'url', name: 'repositoryUrl', value: draft.repositoryUrl, required: true, disabled: busy,
              autoComplete: 'off', spellCheck: false, onChange: event => onChange({ repositoryUrl: event.target.value }) })),
        h(Button, { type: 'submit', variant: 'primary', disabled: !ready || busy }, generatingOutline ? '正在生成目录…' : '生成文档'),
        picker === 'native' && h('p', { role: 'status', className: 'dsh-code-wiki-feedback' }, '正在打开文件夹选择器…'),
        error && h('p', { role: 'alert', className: 'dsh-code-wiki-feedback' }, error),
        picker === 'browser' && h(FolderBrowser, {
          listDirectory, onPick: repositoryPath => onChange({ repositoryPath }), onClose: () => onChange({}),
        })))
    }

    function ChapterDirectory({ chapters, chapterIndex, onSelect }) {
      const selectId = useId()
      return h('nav', { 'aria-label': '章节目录', className: 'dsh-code-wiki-sidebar' },
        h('h2', { className: 'dsh-code-wiki-rail-label' }, '章节目录'),
        h('ol', { className: 'dsh-code-wiki-chapter-list', role: 'list' },
          chapters.map(({ title }, index) => h('li', { key: index },
            h('button', {
              type: 'button', className: 'dsh-code-wiki-chapter-button',
              'aria-current': index === chapterIndex ? 'page' : undefined, onClick: () => onSelect(index),
            }, h('span', { 'aria-hidden': true }, index + 1), title)))),
        h('div', { className: 'dsh-code-wiki-chapter-picker' },
          h('label', { htmlFor: selectId }, '章节'),
          h('div', null,
            h('select', { id: selectId, value: chapterIndex, onChange: event => onSelect(Number(event.target.value)) },
              chapters.map(({ title }, index) => h('option', { key: index, value: index }, `${index + 1}. ${title}`))),
            h(IconChevronDownOutlineRegular, { size: 15, 'aria-hidden': true }))))
    }

    function CodeWikiPage({ store, listDirectory }) {
      const { draft, view, document, chapterIndex, picker, generatingOutline, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const formId = useId()
      const page = useRef(null)
      const articleHeading = useRef(null)
      const reading = view === 'reader'
      const formOpen = view === 'form'

      useEffect(() => {
        if (reading) {
          if (page.current) page.current.scrollTop = 0
          articleHeading.current?.focus({ preventScroll: true })
        }
      }, [chapterIndex, reading])

      const chapter = document?.chapters[chapterIndex]
      return h('section', { 'aria-label': panelTitle, className: 'dsh-code-wiki-page', 'data-reading': reading ? '' : undefined, ref: page },
        h('style', null, wikiStyles),
        h('div', { className: 'dsh-code-wiki-shell' },
          h('header', { className: 'dsh-code-wiki-bar' },
            reading ? h('nav', { className: 'dsh-code-wiki-breadcrumb', 'aria-label': '当前位置' },
              h('button', { className: 'dsh-code-wiki-library-link', type: 'button', onClick: store.returnToLibrary }, '文档库'),
              h(IconChevronRightOutlineRegular, { size: 13, 'aria-hidden': true }),
              document.source === 'github'
                ? h('a', { href: document.location, target: '_blank', rel: 'noreferrer', title: '在 GitHub 打开 ' + document.title }, document.title)
                : h('span', { title: document.location }, document.title))
              : h('h1', { className: 'dsh-code-wiki-brand' },
                h('span', { className: 'dsh-code-wiki-icon', 'aria-hidden': true }, h(IconCodeOutlineRegular, { size: 20 })), '文档库'),
            !reading && h(Button, {
              type: 'button', variant: formOpen ? 'outline' : 'primary', size: 'sm', disabled: Boolean(picker) || generatingOutline,
              icon: formOpen ? undefined : h(IconPlusOutlineRegular, { size: 16 }),
              'aria-expanded': formOpen, 'aria-controls': formOpen ? formId : undefined,
              onClick: store.toggleForm,
            }, formOpen ? '取消新建' : '新建 Wiki')),
          reading ? h('div', { className: 'dsh-code-wiki-columns' },
            h(ChapterDirectory, { chapters: document.chapters, chapterIndex, onSelect: store.selectChapter }),
            h('article', { className: 'dsh-code-wiki-article', 'aria-label': '文档正文' },
              h('header', null, h('h1', { ref: articleHeading, tabIndex: -1 }, chapter.title)),
              chapter.markdown.trim() && h('div', { className: 'dsh-code-wiki-prose' },
                h(MarkdownText, { text: chapter.markdown, labels: markdownLabels, omitHtml: true }))))
            : h('div', { className: 'dsh-code-wiki-library' },
              formOpen && h(SourceForm, { id: formId, draft, onChange: store.changeDraft, onSubmit: store.generateDocument,
                error, picker, generatingOutline, onChooseFolder: store.chooseFolder, listDirectory }),
              document ? h('button', { type: 'button', className: 'dsh-code-wiki-document', disabled: generatingOutline, onClick: store.openDocument },
                h('span', { className: 'dsh-code-wiki-icon', 'aria-hidden': true },
                  h(document.source === 'local' ? IconFolderOpenOutlineRegular : IconCodeOutlineRegular, { size: 19 })),
                h('span', null, h('strong', null, document.title), h('small', null, '目录草稿')),
                h(IconChevronRightOutlineRegular, { size: 16, 'aria-hidden': true }))
                : !formOpen && h('p', { className: 'dsh-code-wiki-empty' }, '还没有 Wiki'))))
    }

    return {
      name: panelId,
      inject: ['slots', 'uiWorkspace', 'remote', 'remote.directoryPicker'],
      apply(ctx) {
        const store = createWikiStore(() => ctx.remote.directoryPicker.pick())
        const listDirectory = (path, signal) => ctx.uiWorkspace.listDirectory(path, signal)
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: panelId, inject: () => ({ store, listDirectory }),
        }, CodeWikiPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: panelId, label: panelTitle, order: 10,
        }, IconCodeOutlineRegular))
      },
    }
  },
})
