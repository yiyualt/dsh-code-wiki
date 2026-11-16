function createCodeWikiFolderBrowser(React, primitives) {
  const { createElement: h, useEffect, useState } = React
  const { Button, IconFolderCloseRegular, Modal } = primitives

  return function FolderBrowser({ listDirectory, onPick, onClose }) {
    const [request, setRequest] = useState({ path: undefined })
    const [response, setResponse] = useState(null)
    const listing = response?.listing
    const loading = response?.request !== request
    const failed = !loading && response.failed
    const entries = listing?.entries ?? []
    const crumbs = listing?.crumbs ?? []

    useEffect(() => {
      const controller = new AbortController()
      async function browse() {
        try {
          const directory = await listDirectory(request.path, controller.signal)
          if (!controller.signal.aborted) setResponse({ request, listing: directory, failed: false })
        } catch {
          if (!controller.signal.aborted) {
            setResponse(previous => ({ request, listing: previous?.listing, failed: true }))
          }
        }
      }
      browse()
      return () => controller.abort()
    }, [listDirectory, request])

    function visit(path) {
      setRequest({ path })
    }

    const footer = h(React.Fragment, null,
      h(Button, { 'data-modal-autofocus': '', onClick: onClose }, '取消'),
      h(Button, {
        variant: 'primary',
        disabled: loading || !listing,
        onClick: () => onPick(listing.path),
      }, '选择此文件夹'))

    return h(Modal, {
      open: true,
      onClose,
      title: '选择仓库文件夹',
      closeLabel: '关闭',
      footer,
    },
    listing && h('nav', {
      'aria-label': '文件夹路径',
      style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, overflowWrap: 'anywhere' },
    }, crumbs.map(crumb => crumb.path === listing.path
      ? h('span', { key: crumb.path, 'aria-current': 'location', title: crumb.path }, crumb.name)
      : h(Button, { key: crumb.path, size: 'sm', disabled: loading, onClick: () => visit(crumb.path) }, crumb.name))),
    loading && h('p', { role: 'status' }, '正在读取文件夹…'),
    failed && h('div', { role: 'alert', style: { marginBlock: 8 } },
      '无法读取此文件夹。',
      h(Button, { size: 'sm', onClick: () => visit(request.path) }, '重试')),
    listing && h('ul', {
      'aria-label': '子文件夹',
      style: { listStyle: 'none', padding: 0, margin: '8px 0 0', maxHeight: 'min(45vh, 300px)', overflowY: 'auto' },
    }, entries.map(entry => h('li', { key: entry.path }, h(Button, {
      size: 'sm',
      icon: h(IconFolderCloseRegular, { size: 16 }),
      disabled: loading,
      style: { display: 'flex', width: '100%', justifyContent: 'start', height: 'auto', minHeight: 28, whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere' },
      onClick: () => visit(entry.path),
    }, entry.name)))),
    listing && !loading && !entries.length && h('p', null, '此文件夹没有子文件夹。'),
    listing?.truncated && h('p', null, '此处仅显示部分文件夹。'))
  }
}
