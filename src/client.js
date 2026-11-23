import wikiStyles from './wiki.css'
import { chapterSources } from './chapter-sources.js'
import { chapterFigureSlots } from '../skills/repo-design-wiki/scripts/chapter-figures.mjs'

window.__ModuleLoader__.load({
  id: 'dsh-code-wiki',
  factory(require) {
    const { createElement: h, Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = require('react')
    const { createPortal } = require('react-dom')
    const {
      Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular,
      IconCloseOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconFullscreenOutlineRegular,
      IconPlusOutlineRegular, Input, MarkdownText, Modal,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const panelId = 'dsh-code-wiki'
    const panelTitle = '代码百科'
    const overviewTitle = '总览'
    const outlineError = '无法生成目录，请重试。'
    const chapterError = '无法生成本章，请重试。'
    const chapterDataError = '章节生成返回了无法读取的数据。'
    const chapterInterrupted = '读取章节生成结果时连接中断。'
    const libraryError = '无法读取文档库，请重试。'
    const documentError = '无法打开这份文档，请重试。'
    const documentActionErrors = {
      archive: '无法归档这份 Wiki，请重试。',
      restore: '无法恢复这份 Wiki，请重试。',
      delete: '无法删除这份 Wiki，请重试。',
    }
    const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
    const documentIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
    const libraryDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
    const sourceLinkBase = `${window.location.origin}/#`
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

    function repositoryInput(repository) {
      return repository.source === 'github'
        ? { repositoryUrl: repository.location }
        : { repositoryPath: repository.location }
    }

    function hasText(value) {
      return typeof value === 'string' && Boolean(value.trim())
    }

    function validSources(sources, allowEmpty = false) {
      return Array.isArray(sources) && (allowEmpty || sources.length > 0) && sources.every(source =>
        hasText(source?.path) && source.path.isWellFormed() && !/[\\\u0000-\u001f\u007f]/.test(source.path) &&
        source.path.split('/').every(part => part && part !== '.' && part !== '..') &&
        Number.isSafeInteger(source.line) && source.line > 0)
    }

    function requestWiki(action, input, accept = 'application/json') {
      return fetch(new URL(`api/dsh-code-wiki/${action}`, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept },
        body: JSON.stringify(input),
      })
    }

    async function wikiJson(response, fallbackError) {
      const result = await response.json().catch(() => null)
      if (!response.ok) return { error: hasText(result?.error) ? result.error : fallbackError }
      return { result }
    }

    function validDocumentId(id) {
      return typeof id === 'string' && documentIdPattern.test(id)
    }

    function validChapterConnection(connection) {
      return hasText(connection?.module) && hasText(connection.from) && hasText(connection.to) &&
        hasText(connection.handoff) && (connection.module === connection.from || connection.module === connection.to)
    }

    function validOutline(outline, source, legacy = false) {
      const { mainline, commit, chapters, overview } = outline ?? {}
      return (legacy ? typeof mainline === 'string' : hasText(mainline)) &&
        typeof commit === 'string' && commitId.test(commit) && (source !== 'github' || commit.length === 40) &&
        (overview === undefined || validContent(overview)) &&
        Array.isArray(chapters) && chapters.length > 0 && chapters.every(chapter =>
          hasText(chapter?.title) && validSources(chapter.sources, legacy) &&
          (chapter.connection === undefined || validChapterConnection(chapter.connection)))
    }

    async function loadOutline(repository) {
      const response = await requestWiki('outline', repositoryInput(repository))
      const { result, error } = await wikiJson(response, outlineError)
      if (error) return { error }
      if (!validOutline(result, repository.source) || (result.id !== undefined && !validDocumentId(result.id))) {
        return { error: outlineError }
      }
      const { id = null, mainline, commit, chapters, overview } = result
      return { id, mainline: mainline.trim(), commit, chapters, overview }
    }

    function validDiagram(diagram) {
      const { label, title, width, height, svg, slot } = diagram ?? {}
      return hasText(label) && hasText(title) &&
        (slot === undefined || (Number.isSafeInteger(slot) && slot > 0)) &&
        Number.isInteger(width) && width > 0 && width <= 4096 &&
        Number.isInteger(height) && height > 0 && height <= 4096 &&
        typeof svg === 'string' && svg.length <= 160_000 && /^<svg(?:\s|>)[\s\S]*<\/svg>$/.test(svg.trim())
    }

    function validContent(content, legacy = false) {
      return hasText(content?.markdown) && validSources(content.sources, legacy) &&
        Array.isArray(content.diagrams) && content.diagrams.every(validDiagram)
    }

    function validChapterContent(content, legacy = false) {
      return validContent(content, legacy) && typeof content.handoff === 'string'
    }

    async function requestDocuments(id, fallbackError) {
      const url = new URL('api/dsh-code-wiki/documents', document.baseURI)
      if (id) url.searchParams.set('id', id)
      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
      return wikiJson(response, fallbackError)
    }

    function validDocumentSummary(summary) {
      return validDocumentId(summary?.id) && hasText(summary.title) && ['github', 'local'].includes(summary.source) &&
        (summary.archived === undefined || typeof summary.archived === 'boolean') &&
        (summary.hasOverview === undefined || typeof summary.hasOverview === 'boolean') &&
        Number.isSafeInteger(summary.chapterCount) && summary.chapterCount > 0 &&
        Number.isSafeInteger(summary.generatedCount) && summary.generatedCount >= 0 && summary.generatedCount <= summary.chapterCount
    }

    async function loadLibrary() {
      const { result, error } = await requestDocuments(null, libraryError)
      if (error) return { error }
      const summaries = result?.documents
      if (!Array.isArray(summaries) || !summaries.every(validDocumentSummary)) return { error: libraryError }
      return { summaries }
    }

    async function loadDocument(id) {
      const { result, error } = await requestDocuments(id, documentError)
      if (error) return { error }
      const { document, chapterWork, legacy, archived } = result ?? {}
      if (result?.id !== id || !hasText(document?.title) || !hasText(document.location) ||
        (document.source !== 'local' && !(document.source === 'github' && githubRepository(document.location))) ||
        (archived !== undefined && typeof archived !== 'boolean') ||
        !validOutline(document, document.source, legacy === true) ||
        !Array.isArray(chapterWork) || chapterWork.length > document.chapters.length ||
        chapterWork.some(work => work !== null && (!validChapterContent(work?.content, legacy === true) ||
          (work.warning !== undefined && typeof work.warning !== 'string')))) {
        return { error: documentError }
      }
      return { record: { id, document, chapterWork, legacy: legacy === true, archived: archived === true } }
    }

    async function changeDocument(id, action) {
      const fallback = documentActionErrors[action]
      const response = await requestWiki('documents', { id, action })
      const { result, error } = await wikiJson(response, fallback)
      if (error) return { error }
      if (result?.id !== id || (action === 'delete' ? result.deleted !== true : result.archived !== (action === 'archive'))) {
        return { error: fallback }
      }
      return { archived: result.archived }
    }

    async function* chapterLines(stream) {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let remainder = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          const lines = (remainder + decoder.decode(value, { stream: !done })).split('\n')
          remainder = lines.pop()
          for (const line of lines) if (line.trim()) yield line
          if (done) {
            if (remainder.trim()) yield remainder
            return
          }
        }
      } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }

    async function loadChapterStream(stream, onContent) {
      let content
      let remainingSlots
      try {
        for await (const line of chapterLines(stream)) {
          let message
          try {
            message = JSON.parse(line)
          } catch {
            return { error: chapterDataError }
          }
          switch (message?.type) {
            case 'body':
              if (!validChapterContent(message.content) || message.content.diagrams.length) {
                return { error: chapterDataError }
              }
              content = message.content
              const slots = chapterFigureSlots(content.markdown)
              remainingSlots = slots.length ? new Set(slots.map(({ slot }) => slot)) : undefined
              onContent(content)
              break
            case 'diagram':
              if (!content || !validDiagram(message.diagram) || !validSources(message.sources) ||
                (remainingSlots ? !remainingSlots.delete(message.diagram.slot) : message.diagram.slot !== undefined) ||
                content.sources.some(({ path, line }, index) =>
                  message.sources[index]?.path !== path || message.sources[index]?.line !== line)) {
                return { error: chapterDataError }
              }
              content = { ...content, sources: message.sources, diagrams: [...content.diagrams, message.diagram] }
              onContent(content)
              break
            case 'done':
              if (!content || (message.warning !== undefined && typeof message.warning !== 'string')) {
                return { error: chapterDataError }
              }
              return { warning: message.warning?.trim() ?? '' }
            case 'error':
              return { error: hasText(message.error) ? message.error : chapterDataError }
            default:
              return { error: chapterDataError }
          }
        }
      } catch {
        return { error: chapterInterrupted }
      }
      return { error: chapterInterrupted }
    }

    async function loadChapter(repository, documentId, chapterIndex, previousHandoff, onContent) {
      const { commit, mainline, chapters } = repository
      const { title, sources, connection } = chapters[chapterIndex]
      const previous = chapters[chapterIndex - 1]
      const next = chapters[chapterIndex + 1]
      const response = await requestWiki('chapter', {
        ...repositoryInput(repository), commit, mainline, chapter: { title, sources, connection },
        ...(documentId ? { documentId, chapterIndex } : {}),
        previous: previous ? { title: previous.title, handoff: previousHandoff } : null,
        next: next?.title ?? null,
      }, 'application/x-ndjson')
      const mimeType = response.headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (response.ok && mimeType === 'application/x-ndjson') {
        return loadChapterStream(response.body, onContent)
      }
      const fallbackError = response.status >= 400 ? `生成本章的请求失败（HTTP ${response.status}），请重试。` : chapterError
      const { result, error } = await wikiJson(response, fallbackError)
      if (error) return { error }
      return validChapterContent(result) ? { content: result } : { error: chapterError }
    }

    function generatedCount(record) {
      return record.chapterWork.filter(work => work?.content).length
    }

    function keepChapterErrors(record, cached) {
      if (!cached) return record
      const chapterWork = record.document.chapters.map((_, index) => {
        const saved = record.chapterWork[index]
        const local = cached.chapterWork[index]
        return local?.error && !saved?.warning && saved?.content?.diagrams.length === local.content?.diagrams.length
          ? { ...saved, error: local.error } : saved ?? null
      })
      return { ...record, chapterWork }
    }

    function createWikiStore(pickDirectory) {
      let snapshot = {
        draft: { source: 'github', repositoryUrl: '', repositoryPath: '' },
        view: 'library', opened: null, chapterIndex: 0, picker: null, generatingOutline: false, error: '',
        summaries: [], temporary: null, loadingLibrary: true, libraryError: '', openingId: null, openError: '',
        managingId: null,
      }
      const listeners = new Set()
      const records = new Map()
      let libraryVersion = 0
      let openVersion = 0

      function update(patch) {
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener()
      }

      function changeDraft(patch) {
        update({ draft: { ...snapshot.draft, ...patch }, picker: null, error: '' })
      }

      function withLocalProgress(summaries) {
        return summaries.map(summary => {
          const record = records.get(summary.id)
          const count = record ? generatedCount(record) : 0
          return count > summary.generatedCount ? { ...summary, generatedCount: count } : summary
        })
      }

      function showDocument(record, patch) {
        records.set(record.id, record)
        update({
          ...patch, opened: record, chapterIndex: record.document.overview ? null : 0, view: 'reader', openingId: null, openError: '',
          temporary: record.id === null ? record : snapshot.temporary,
        })
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
          openVersion++
          update({ view: snapshot.view === 'form' ? 'library' : 'form', error: '', openingId: null, openError: '' })
        },
        returnToLibrary() {
          openVersion++
          update({ view: 'library', opened: null, openingId: null, openError: '' })
        },
        async refreshLibrary() {
          const version = ++libraryVersion
          update({ loadingLibrary: true, libraryError: '' })
          const result = await loadLibrary().catch(() => ({ error: libraryError }))
          if (version !== libraryVersion) return
          update(result.error ? { loadingLibrary: false, libraryError: result.error }
            : { loadingLibrary: false, summaries: withLocalProgress(result.summaries) })
        },
        async openDocument(id = null) {
          if (snapshot.view === 'reader' || snapshot.generatingOutline || snapshot.picker ||
            (id !== null && (!validDocumentId(id) || snapshot.openingId === id || snapshot.managingId === id))) return
          const cached = records.get(id)
          if (id === null && !cached) return
          const version = ++openVersion
          if (id === null || cached?.chapterWork.some(work => work?.pending)) {
            showDocument(cached)
            return
          }

          update({ openingId: id, openError: '' })
          const result = await loadDocument(id).catch(() => ({ error: documentError }))
          if (version !== openVersion) return
          if (result.error) update({ openingId: null, openError: result.error })
          else showDocument(keepChapterErrors(result.record, cached))
        },
        async manageDocument(id, action) {
          const fallback = documentActionErrors[action]
          if (snapshot.managingId || snapshot.openingId === id || !snapshot.summaries.some(summary => summary.id === id)) {
            return { error: fallback }
          }
          if (records.get(id)?.chapterWork.some(work => work?.pending)) {
            return { error: '这份 Wiki 正在生成章节，完成后可以再操作。' }
          }

          update({ managingId: id })
          const result = await changeDocument(id, action).catch(() => ({ error: fallback }))
          if (result.error) {
            update({ managingId: null })
            return result
          }

          libraryVersion++
          let summaries
          if (action === 'delete') {
            records.delete(id)
            summaries = snapshot.summaries.filter(summary => summary.id !== id)
          } else {
            const record = records.get(id)
            if (record) records.set(id, { ...record, archived: result.archived })
            summaries = snapshot.summaries.map(summary => summary.id === id ? { ...summary, archived: result.archived } : summary)
          }
          update({ managingId: null, summaries, loadingLibrary: false, openError: '' })
          return result
        },
        selectChapter(chapterIndex) {
          const document = snapshot.opened?.document
          const section = chapterIndex === null ? document?.overview : document?.chapters[chapterIndex]
          if (section && snapshot.chapterIndex !== chapterIndex) update({ chapterIndex })
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

          openVersion++
          update({ generatingOutline: true, error: '', openingId: null, openError: '' })
          try {
            const { id, mainline, commit, chapters, overview, error } = await loadOutline(repository)
            if (error) {
              update({ generatingOutline: false, error })
              return
            }
            showDocument({ id, document: { ...repository, mainline, commit, chapters, overview }, chapterWork: [], legacy: false },
              { generatingOutline: false })
          } catch {
            update({ generatingOutline: false, error: outlineError })
          }
        },
        async generateChapter() {
          const { opened, chapterIndex, view } = snapshot
          if (view !== 'reader' || !opened || opened.legacy || chapterIndex === null) return
          const { id, document, chapterWork } = opened
          const current = chapterWork[chapterIndex]
          if (!document.chapters[chapterIndex] || current?.pending || current?.content) return

          function updateChapter(patch) {
            const record = records.get(id)
            if (record?.document !== document) return
            const chapters = [...record.chapterWork]
            const acceptedBody = patch.content && !chapters[chapterIndex]?.content
            chapters[chapterIndex] = { ...chapters[chapterIndex], ...patch }
            const updated = { ...record, chapterWork: chapters }
            records.set(id, updated)
            update({
              opened: snapshot.opened?.document === document ? updated : snapshot.opened,
              summaries: acceptedBody && id ? withLocalProgress(snapshot.summaries) : snapshot.summaries,
              temporary: id === null ? updated : snapshot.temporary,
            })
          }

          updateChapter({ pending: true, error: '', warning: '' })
          try {
            const previousHandoff = chapterWork[chapterIndex - 1]?.content?.handoff ?? ''
            const result = await loadChapter(document, id, chapterIndex, previousHandoff, content => updateChapter({ content }))
            updateChapter({ ...result, pending: false })
          } catch {
            updateChapter({ error: chapterError, pending: false })
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
      const selectedSource = useRef(null)
      const local = draft.source === 'local'
      const ready = local ? draft.repositoryPath : draft.repositoryUrl.trim()
      const busy = Boolean(picker) || generatingOutline
      useEffect(() => { selectedSource.current?.focus() }, [])

      return h('section', { id, className: 'dsh-code-wiki-form-card', 'aria-label': '新建 Wiki' },
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
            [['github', 'GitHub 地址'], ['local', '本地仓库']].map(([value, label]) => {
              const checked = draft.source === value
              return h('label', { key: value }, h('input', {
                type: 'radio', name: sourceId, value, checked, ref: checked ? selectedSource : undefined,
                onChange: () => onChange({ source: value }),
              }), h('span', null, label))
            }))),
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

    function ChapterDirectory({ chapters, chapterIndex, hasOverview, mainlineId, onSelect }) {
      const selectId = useId()
      return h('nav', { 'aria-label': '章节目录', 'aria-describedby': mainlineId, className: 'dsh-code-wiki-sidebar' },
        h('h2', { className: 'dsh-code-wiki-rail-label' }, '章节目录'),
        h('ol', { className: 'dsh-code-wiki-chapter-list', role: 'list' },
          hasOverview && h('li', { className: 'dsh-code-wiki-overview-item' },
            h('button', {
              type: 'button', className: 'dsh-code-wiki-chapter-button',
              'aria-current': chapterIndex === null ? 'page' : undefined, onClick: () => onSelect(null),
            }, h('span', { 'aria-hidden': true }, h(IconCodeOutlineRegular, { size: 14 })), overviewTitle)),
          chapters.map(({ title }, index) => h('li', { key: index },
            h('button', {
              type: 'button', className: 'dsh-code-wiki-chapter-button',
              'aria-current': index === chapterIndex ? 'page' : undefined, onClick: () => onSelect(index),
            }, h('span', { 'aria-hidden': true }, index + 1), title)))),
        h('div', { className: 'dsh-code-wiki-chapter-picker' },
          h('label', { htmlFor: selectId }, '章节'),
          h('div', null,
            h('select', { id: selectId, value: chapterIndex ?? 'overview',
              onChange: event => onSelect(event.target.value === 'overview' ? null : Number(event.target.value)) },
              hasOverview && h('option', { value: 'overview' }, overviewTitle),
              chapters.map(({ title }, index) => h('option', { key: index, value: index }, `${index + 1}. ${title}`))),
            h(IconChevronDownOutlineRegular, { size: 15, 'aria-hidden': true }))))
    }

    function ChapterSource({ repository, path, id }) {
      const label = h('code', null, path)
      const row = { id, tabIndex: -1 }
      if (repository.source === 'local') return h('li', row, label)
      const encodedPath = path.split('/').map(encodeURIComponent).join('/')
      return h('li', row, h('a', {
        href: `${repository.location}/blob/${repository.commit}/${encodedPath}`,
        target: '_blank', rel: 'noreferrer',
      }, label))
    }

    function diagramDocument(svg) {
      return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light dark">
  <style>html, body { margin: 0; overflow: hidden; } body > svg { display: block; width: 100%; height: auto; }</style>
</head>
<body>${svg}</body>
</html>`
    }

    function DiagramFrame({ diagram, zoom }) {
      const { label, title, width, height, svg } = diagram
      return h('iframe', {
        className: 'dsh-code-wiki-diagram-frame', title: `${label} ${title}`,
        style: { width: zoom === undefined ? `min(100%, ${width}px)` : `${width * zoom}px`, aspectRatio: `${width} / ${height}` },
        sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerPolicy: 'no-referrer',
        srcDoc: diagramDocument(svg),
      })
    }

    function DiagramPreview({ diagram, onClose }) {
      const viewport = useRef(null)
      const [availableWidth, setAvailableWidth] = useState(0)
      const [chosenZoom, setChosenZoom] = useState(null)
      const fit = Math.min(1, availableWidth / diagram.width)
      const zoom = Math.max(fit, chosenZoom ?? fit)
      const zoomed = zoom > fit
      const maxZoom = 4
      const zoomStep = 1.25
      const title = `${diagram.label} · ${diagram.title}`

      useLayoutEffect(() => {
        const region = viewport.current
        const measure = () => setAvailableWidth(region.clientWidth)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(region)
        return () => observer.disconnect()
      }, [])

      function changeZoom(factor) {
        const next = Math.min(maxZoom, zoom * factor)
        setChosenZoom(next > fit ? next : null)
      }

      return h(Modal, { open: true, onClose, title, headless: true, className: 'dsh-code-wiki-diagram-preview' },
        h('header', { className: 'dsh-code-wiki-diagram-preview-header' },
          h('h2', null, title),
          h(Button, { type: 'button', size: 'sm', variant: 'ghost', 'aria-label': '关闭大图', 'data-modal-autofocus': '',
            icon: h(IconCloseOutlineRegular, { size: 18 }), onClick: onClose })),
        h('div', { className: 'dsh-code-wiki-diagram-controls', role: 'group', 'aria-label': '图缩放' },
          h(Button, { type: 'button', size: 'sm', variant: 'outline', 'aria-label': '缩小', disabled: !zoomed,
            onClick: () => changeZoom(1 / zoomStep) }, '−'),
          h('output', null, `${Math.round(zoom * 100)}%`),
          h(Button, { type: 'button', size: 'sm', variant: 'outline', 'aria-label': '放大', disabled: !fit || zoom >= maxZoom,
            onClick: () => changeZoom(zoomStep) }, '+'),
          h(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: () => setChosenZoom(null) }, '适合宽度')),
        h('div', { className: 'dsh-code-wiki-diagram-viewport', ref: viewport, tabIndex: 0,
          role: 'region', 'aria-label': '图预览区域' },
          h(DiagramFrame, { diagram, zoom: zoomed ? zoom : undefined })))
    }

    function ChapterDiagram({ diagram }) {
      const { kind, label, title, slot } = diagram
      const titleId = useId()
      const [preview, setPreview] = useState(false)

      return h('figure', { className: 'dsh-code-wiki-diagram', 'aria-labelledby': titleId, 'data-diagram-kind': kind, tabIndex: -1 },
        h('figcaption', { id: titleId },
          h('span', { className: 'dsh-code-wiki-diagram-kind' }, slot === undefined ? label : `图 ${slot}`), ' ', title),
        h(Button, { type: 'button', size: 'sm', variant: 'ghost', 'aria-haspopup': 'dialog',
          icon: h(IconFullscreenOutlineRegular, { size: 15 }),
          onClick: () => setPreview(true) }, '查看大图'),
        h(DiagramFrame, { diagram }),
        preview && h(DiagramPreview, { diagram, onClose: () => setPreview(false) }))
    }

    function ChapterProse({ markdown, diagrams, pending, citationPrefix }) {
      const prose = useRef(null)
      const markerPrefix = `CodeWikiFigure${useId().replace(/[^a-z\d]/gi, '')}Slot`
      const { text, markers } = useMemo(() => {
        let prefix = markerPrefix
        while (markdown.includes(prefix)) prefix += 'X'
        const markers = new Map()
        const parts = []
        let offset = 0
        for (const { slot, start, end } of chapterFigureSlots(markdown)) {
          const marker = `${prefix}${slot}`
          markers.set(marker, slot)
          parts.push(markdown.slice(offset, start), marker)
          offset = end
        }
        return { text: parts.join('') + markdown.slice(offset), markers }
      }, [markdown, markerPrefix])
      const [mounted, setMounted] = useState(null)

      useLayoutEffect(() => {
        const rendered = prose.current.firstElementChild
        // MarkdownText renders absolute links. Convert our chapter's citation links to local fragments.
        for (const link of rendered.querySelectorAll(`a[href^="${citationPrefix}"]`)) {
          link.setAttribute('href', '#' + link.getAttribute('href').slice(sourceLinkBase.length))
          link.removeAttribute('target')
          link.removeAttribute('rel')
        }
        if (!markers.size) return
        // Keep one Markdown render so tables, code, links and footnotes share the chapter context.
        const placements = new Map()
        for (const node of [...rendered.children]) {
          const slot = node.tagName === 'P' && markers.get(node.textContent)
          if (!slot) continue
          const target = node.ownerDocument.createElement('div')
          target.className = 'dsh-code-wiki-inline-diagram'
          node.hidden = true
          node.after(target)
          placements.set(slot, { node, target })
        }
        setMounted({ text, placements })
        return () => {
          for (const { node, target } of placements.values()) {
            target.remove()
            node.hidden = false
          }
        }
      }, [text, markers, citationPrefix])

      const placements = mounted?.text === text ? mounted.placements : null
      const diagramBySlot = new Map(diagrams.filter(diagram => diagram.slot !== undefined).map(diagram => [diagram.slot, diagram]))
      return h('div', { className: 'dsh-code-wiki-prose', ref: prose },
        h(MarkdownText, { text, labels: markdownLabels, omitHtml: true }),
        placements && [...placements].map(([slot, { target }]) => {
          const diagram = diagramBySlot.get(slot)
          const figure = diagram ? h(ChapterDiagram, { diagram })
            : h('p', { className: 'dsh-code-wiki-diagram-status', role: 'status' },
              pending ? `正在生成图 ${slot}…` : `图 ${slot}未生成。`)
          return createPortal(figure, target, slot)
        }),
        diagrams.filter(diagram => diagram.slot === undefined || (placements && !placements.has(diagram.slot)))
          .map((diagram, index) => h(ChapterDiagram, { key: index, diagram })))
    }

    function ChapterContent({ repository, content, pending, title }) {
      const sourcePrefix = `dsh-code-wiki-source-${useId().replace(/[^a-z\d]/gi, '')}-`
      const citationPrefix = sourceLinkBase + sourcePrefix
      const sourceList = useRef(null)
      const { markdown, diagrams, files } = chapterSources(content, number => citationPrefix + number)
      const heading = /^#[ \t]+([^\r\n]+)\r?\n/.exec(markdown)
      const prose = heading?.[1].replace(/[ \t]+#+[ \t]*$/, '').trim() === title
        ? markdown.slice(heading[0].length).trimStart() : markdown

      function jumpToSource(event) {
        const href = event.target.closest?.('a[href]')?.getAttribute('href')
        if (!href?.startsWith('#' + sourcePrefix)) return
        const list = sourceList.current
        const row = list?.ownerDocument.getElementById(href.slice(1))
        if (row?.parentElement !== list) return

        event.preventDefault()
        event.stopPropagation()
        row.focus({ preventScroll: true })
        const scroller = row.closest('.dsh-code-wiki-page')
        if (!scroller) return
        const viewport = scroller.getBoundingClientRect()
        const position = row.getBoundingClientRect()
        const headerHeight = scroller.querySelector('.dsh-code-wiki-bar')?.offsetHeight ?? 0
        const visibleTop = viewport.top + headerHeight + 12
        if (position.top < visibleTop || position.bottom > viewport.bottom) {
          scroller.scrollTop += position.top - visibleTop
        }
      }

      return h('div', { className: 'dsh-code-wiki-chapter-content', onClickCapture: jumpToSource },
        h(ChapterProse, { markdown: prose, diagrams, pending, citationPrefix }),
        files.length > 0 && h('section', { className: 'dsh-code-wiki-sources' },
          h('h2', null, '源码位置'),
          h('ol', { ref: sourceList }, files.map((path, index) => h(ChapterSource, {
            key: path, repository, path, id: sourcePrefix + (index + 1),
          })))))
    }

    function DocumentRow({ document, opening, disabled, actionsDisabled, onOpen, onMove, onDelete }) {
      const { id, title, source, chapterCount, generatedCount, updatedAt, legacy, archived, hasOverview } = document
      const titleId = useId()
      const date = Date.parse(updatedAt)
      const draftStatus = hasOverview ? '已生成总览' : '目录草稿'
      const summary = legacy ? '历史文档' : generatedCount ? `已生成 ${generatedCount} / ${chapterCount} 章` : draftStatus
      return h('li', { className: 'dsh-code-wiki-document-row' },
        h('button', { type: 'button', className: 'dsh-code-wiki-document', disabled: disabled || opening, onClick: () => onOpen(id) },
          h('span', { className: 'dsh-code-wiki-icon', 'aria-hidden': true },
            h(source === 'local' ? IconFolderOpenOutlineRegular : IconCodeOutlineRegular, { size: 19 })),
          h('span', null, h('strong', { id: titleId }, title), h('small', { role: opening ? 'status' : undefined },
            opening ? '正在打开…' : summary,
            !opening && Number.isFinite(date) && h(Fragment, null, ' · ', h('time', { dateTime: updatedAt }, libraryDate.format(date))))),
          h(IconChevronRightOutlineRegular, { size: 16, 'aria-hidden': true })),
        id !== null && h('div', { className: 'dsh-code-wiki-document-actions' },
          h(Button, { type: 'button', size: 'sm', disabled: actionsDisabled, 'aria-describedby': titleId,
            onClick: () => onMove(document) }, archived ? '恢复' : '归档'),
          h(Button, { type: 'button', size: 'sm', disabled: actionsDisabled, 'aria-describedby': titleId,
            className: 'dsh-code-wiki-delete-action', onClick: () => onDelete(document) }, '删除')))
    }

    function ConfirmWikiDeletion({ title, busy, error, onClose, onConfirm }) {
      const confirm = useRef(null)
      useLayoutEffect(() => {
        if (!busy && error) confirm.current?.focus({ preventScroll: true })
      }, [busy, error])
      return h(Modal, {
        open: true, title: '删除 Wiki', closeLabel: '取消删除', onClose, className: 'dsh-code-wiki-delete-modal',
        description: `永久删除「${title}」及其所有章节。删除后无法恢复。`,
        onKeyDownCapture(event) {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 ||
            event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          event.preventDefault()
          event.stopPropagation()
          if (!busy && !event.repeat) void onConfirm()
        },
        footer: h(Fragment, null,
          h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: onClose }, '取消'),
          h(Button, { type: 'button', variant: 'outline', ref: confirm, className: 'dsh-code-wiki-delete-confirm',
            'aria-disabled': busy, 'data-modal-autofocus': '', onClick: onConfirm }, busy ? '正在删除…' : '删除')),
      }, error && h('p', { className: 'dsh-code-wiki-delete-error', role: 'alert' }, error))
    }

    function DocumentLibrary({ summaries, temporary, loading, loadError, openError, openingId, managingId, disabled, formOpen,
      showArchived, onShowArchived, onOpen, onRefresh, onManage }) {
      const [feedback, setFeedback] = useState(null)
      const [deleteTarget, setDeleteTarget] = useState(null)
      const [deleteError, setDeleteError] = useState('')
      const activeFilter = useRef(null)
      const busy = managingId !== null
      const actionsDisabled = disabled || busy || openingId !== null
      const documents = summaries.filter(summary => (summary.archived === true) === showArchived)
      if (temporary && !showArchived) documents.unshift({ id: null, ...temporary.document,
        hasOverview: Boolean(temporary.document.overview),
        chapterCount: temporary.document.chapters.length, generatedCount: generatedCount(temporary) })

      useLayoutEffect(() => {
        if (feedback && !feedback.error) activeFilter.current?.focus({ preventScroll: true })
      }, [feedback])

      function finishAction(text) {
        setFeedback({ text, error: false })
      }

      async function moveDocument({ id, title, archived }) {
        setFeedback(null)
        const { error } = await onManage(id, archived ? 'restore' : 'archive')
        if (error) setFeedback({ text: error, error: true })
        else finishAction(archived ? `已恢复「${title}」。` : `已归档「${title}」。`)
      }

      async function confirmDelete() {
        if (!deleteTarget || busy) return
        setDeleteError('')
        const { id, title } = deleteTarget
        const { error } = await onManage(id, 'delete')
        if (error) setDeleteError(error)
        else {
          setDeleteTarget(null)
          finishAction(`已删除「${title}」。`)
        }
      }

      return h(Fragment, null,
        h('div', { className: 'dsh-code-wiki-library-filters', role: 'group', 'aria-label': '文档状态' },
          [false, true].map(archived => h(Button, { key: String(archived), ref: showArchived === archived ? activeFilter : undefined,
            type: 'button', size: 'sm', variant: showArchived === archived ? 'primary' : 'ghost',
            'aria-pressed': showArchived === archived, disabled: actionsDisabled,
            onClick() {
              setFeedback(null)
              onShowArchived(archived)
            },
          }, archived ? '已归档' : '未归档'))),
        loadError && h('div', { className: 'dsh-code-wiki-library-feedback' },
          h('p', { className: 'dsh-code-wiki-feedback', role: 'alert' }, loadError),
          h(Button, { type: 'button', size: 'sm', onClick: onRefresh }, '重试读取')),
        openError && h('p', { className: 'dsh-code-wiki-feedback', role: 'alert' }, openError),
        feedback && h('p', { className: 'dsh-code-wiki-management-feedback', role: feedback.error ? 'alert' : 'status' }, feedback.text),
        loading && h('p', { className: documents.length ? 'dsh-code-wiki-announcement' : 'dsh-code-wiki-empty', role: 'status' }, '正在读取文档库…'),
        !loading && !loadError && !formOpen && !documents.length &&
          h('p', { className: 'dsh-code-wiki-empty' }, showArchived ? '还没有已归档的 Wiki' : '还没有未归档的 Wiki'),
        documents.length > 0 && h('ul', { className: 'dsh-code-wiki-document-list', role: 'list' },
          documents.map(document => h(DocumentRow, { key: document.id ?? 'temporary', document,
            opening: document.id !== null && document.id === openingId,
            disabled: disabled || (busy && document.id === managingId), actionsDisabled,
            onOpen, onMove: moveDocument,
            onDelete(target) {
              setFeedback(null)
              setDeleteError('')
              setDeleteTarget({ id: target.id, title: target.title })
            },
          }))),
        deleteTarget && h(ConfirmWikiDeletion, { title: deleteTarget.title, busy, error: deleteError, onConfirm: confirmDelete,
          onClose() { if (!busy) setDeleteTarget(null) },
        }))
    }

    function CodeWikiPage({ store, listDirectory }) {
      const { draft, view, opened, chapterIndex, picker, generatingOutline, error,
        summaries, temporary, loadingLibrary, libraryError, openingId, openError, managingId } = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const { document, chapterWork, legacy } = opened ?? {}
      const [showArchived, setShowArchived] = useState(false)
      const formId = useId()
      const mainlineId = useId()
      const page = useRef(null)
      const articleHeading = useRef(null)
      const showModuleDiagram = useRef(false)
      const reading = view === 'reader'
      const formOpen = view === 'form'

      useEffect(() => {
        if (view === 'library') void store.refreshLibrary()
      }, [store, view])

      useEffect(() => {
        const reader = page.current
        if (!reading || !reader) return
        if (chapterIndex !== null || !showModuleDiagram.current) {
          reader.scrollTop = 0
          articleHeading.current?.focus({ preventScroll: true })
          return
        }
        showModuleDiagram.current = false
        const frame = requestAnimationFrame(() => {
          const diagram = reader.querySelector('figure:is([data-diagram-kind="component"], [data-diagram-kind="dependency"])')
          if (!diagram) {
            reader.scrollTop = 0
            articleHeading.current?.focus({ preventScroll: true })
            return
          }
          const header = reader.querySelector('.dsh-code-wiki-bar')
          reader.scrollTop += diagram.getBoundingClientRect().top - reader.getBoundingClientRect().top - (header?.offsetHeight ?? 0) - 12
          diagram.focus({ preventScroll: true })
        })
        return () => cancelAnimationFrame(frame)
      }, [chapterIndex, reading])

      const showingOverview = chapterIndex === null
      const chapter = document?.chapters[chapterIndex]
      const title = showingOverview ? overviewTitle : chapter?.title
      const connection = chapter?.connection
      const { pending, content: chapterContent, error: chapterFailure, warning } = chapterWork?.[chapterIndex] ?? {}
      const content = showingOverview ? document?.overview : chapterContent
      const chapterNotice = chapterContent && (chapterFailure || warning || (pending && '正文已生成，正在处理配图…'))
      const chapterAnnouncement = pending ? '正在生成本章…' : chapterContent ? '本章已生成。' : ''
      return h('section', { 'aria-label': panelTitle, className: 'dsh-code-wiki-page', 'data-reading': reading ? '' : undefined, ref: page },
        h('style', null, wikiStyles),
        h('div', { className: 'dsh-code-wiki-shell' },
          h('header', { className: 'dsh-code-wiki-bar' },
            reading ? h('nav', { className: 'dsh-code-wiki-breadcrumb', 'aria-label': '当前位置' },
              h('button', { className: 'dsh-code-wiki-library-link', type: 'button', onClick: store.returnToLibrary }, '文档库'),
              h(IconChevronRightOutlineRegular, { size: 13, 'aria-hidden': true }),
              document.source === 'github'
                ? h('a', { href: document.location, target: '_blank', rel: 'noreferrer', title: '在 GitHub 打开 ' + document.title }, document.title)
                : h('span', { title: document.location }, document.title),
              opened.archived && h('span', { className: 'dsh-code-wiki-archive-status' }, '已归档'))
              : h('h1', { className: 'dsh-code-wiki-brand' },
                h('span', { className: 'dsh-code-wiki-icon', 'aria-hidden': true }, h(IconCodeOutlineRegular, { size: 20 })), '文档库'),
            !reading && h(Button, {
              type: 'button', variant: formOpen ? 'outline' : 'primary', size: 'sm', disabled: Boolean(picker) || generatingOutline || managingId !== null,
              icon: formOpen ? undefined : h(IconPlusOutlineRegular, { size: 16 }),
              'aria-expanded': formOpen, 'aria-controls': formOpen ? formId : undefined,
              onClick() {
                if (!formOpen) setShowArchived(false)
                store.toggleForm()
              },
            }, formOpen ? '取消新建' : '新建 Wiki')),
          reading ? h('div', { className: 'dsh-code-wiki-columns' },
            document.mainline.trim() && h('p', { id: mainlineId, className: 'dsh-code-wiki-mainline' },
              h('strong', null, '主线'), ' ', h('span', null, document.mainline)),
            h(ChapterDirectory, { chapters: document.chapters, chapterIndex, hasOverview: Boolean(document.overview),
              mainlineId: document.mainline.trim() ? mainlineId : undefined,
              onSelect: store.selectChapter }),
            h('article', { className: 'dsh-code-wiki-article', 'aria-label': '文档正文' },
              h('header', null,
                h('h1', { ref: articleHeading, tabIndex: -1 }, title),
                connection && h('div', { className: 'dsh-code-wiki-chapter-connection' },
                  h('p', null, '本章聚焦', h('strong', null, connection.module), '。模块图中，',
                    connection.from, '到', connection.to, '的连线标为「', connection.handoff, '」。'),
                  document.overview && h(Button, {
                    type: 'button', size: 'sm', variant: 'outline',
                    onClick() {
                      showModuleDiagram.current = true
                      store.selectChapter(null)
                    },
                  }, '查看总览模块图'))),
              !showingOverview && h('p', {
                className: chapterNotice ? 'dsh-code-wiki-feedback dsh-code-wiki-chapter-notice' : 'dsh-code-wiki-announcement',
                role: chapterNotice && chapterFailure ? 'alert' : 'status',
              }, chapterNotice || chapterAnnouncement),
              content ? h(ChapterContent, { key: chapterIndex ?? 'overview', repository: document, content, pending, title })
                : h('div', { className: 'dsh-code-wiki-chapter-action' }, legacy
                  ? h('p', { className: 'dsh-code-wiki-feedback' }, '这份历史文档未保存本章正文。')
                  : h(Fragment, null,
                    h(Button, { type: 'button', variant: 'primary', disabled: Boolean(pending), onClick: store.generateChapter },
                      pending ? '正在生成本章…' : chapterFailure ? '重试生成本章' : '生成本章'),
                    chapterFailure && h('p', { className: 'dsh-code-wiki-feedback', role: 'alert' }, chapterFailure)))))
            : h('div', { className: 'dsh-code-wiki-library' },
              formOpen && h(SourceForm, { id: formId, draft, onChange: store.changeDraft, onSubmit: store.generateDocument,
                error, picker, generatingOutline, onChooseFolder: store.chooseFolder, listDirectory }),
              h(DocumentLibrary, { summaries, temporary, loading: loadingLibrary, loadError: libraryError, openError, openingId, managingId,
                showArchived, onShowArchived: setShowArchived, formOpen, disabled: Boolean(picker) || generatingOutline,
                onOpen: store.openDocument, onRefresh: store.refreshLibrary, onManage: store.manageDocument }))))
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
