const videoMotion = (() => {
  const area = { x: 72, y: 105, w: 1136, h: 472 }
  const ink = '#21182d'
  const muted = '#5c4e72'
  const violet = '#7737be'
  const serif = '"Instrument Serif", "New York", Georgia, serif'
  const sans = 'Geist, "Helvetica Neue", Arial, sans-serif'
  const mono = '"Geist Mono", Menlo, Consolas, monospace'
  const clamp = value => Math.max(0, Math.min(1, value))
  const ease = value => 1 - (1 - clamp(value)) ** 3
  const blend = (a, b, amount) => a + (b - a) * amount
  const colors = {
    accent: { fill: '#e2c7ff', ink: '#492278' },
    soft: { fill: '#eee3f8', ink: '#66468b' },
    ok: { fill: '#d6f4e3', ink: '#166343' },
    bad: { fill: '#ffe3ea', ink: '#91294d' },
    plain: { fill: '#fdfaff', ink },
  }
  const syntax = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/.*|#.*|\/\*.*)|(\b(?:async|await|break|case|catch|class|const|def|elif|else|except|export|false|False|finally|fn|for|from|function|if|import|in|let|match|None|null|return|self|throw|true|True|try|var|while|with|yield)\b)|(\b\d+(?:\.\d+)?\b)/g
  const syntaxColors = ['#087253', '#695e78', '#6924ad', '#994811']
  const panels = ['command', 'code', 'browser', 'table', 'bars', 'image']
  const decodedImages = new WeakMap()
  const imageData = /^data:image\/(?:jpeg|png|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/

  async function prepare(film) {
    if (typeof Image !== 'function') return
    const elements = film.scenes.flatMap(scene => scene.motion?.elements || [])
    await Promise.all(elements.filter(element => element.kind === 'image' && !decodedImages.has(element)).map(async element => {
      const source = element.src ?? film.images?.[element.imageRef]
      if (typeof source !== 'string' || source.length > 6_000_000 || !imageData.test(source)) return
      try {
        const image = new Image()
        image.src = source
        await image.decode()
        if (image.naturalWidth * image.naturalHeight <= 35_000_000) decodedImages.set(element, image)
      } catch { /* Keep the source label visible when an old image cannot be decoded. */ }
    }))
  }

  function rounded(ctx, x, y, w, h, radius, fill, border, lineWidth = 2.5) {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, radius)
    ctx.fillStyle = fill
    ctx.fill()
    if (border) {
      ctx.strokeStyle = border
      ctx.lineWidth = lineWidth
      ctx.stroke()
    }
  }

  function font(ctx, size, weight, family) {
    ctx.font = `${weight} ${size}px ${family}`
  }

  function text(ctx, value, x, y, color) {
    ctx.fillStyle = color
    ctx.fillText(value, x, y)
  }

  function wrap(ctx, value, maxWidth) {
    const lines = []
    for (const paragraph of value.split('\n')) {
      let line = ''
      for (const word of paragraph.split(/\s+/)) {
        const next = line ? line + ' ' + word : word
        if (line && ctx.measureText(next).width > maxWidth) {
          lines.push(line)
          line = word
        } else line = next
      }
      lines.push(line)
    }
    return lines
  }

  function shorten(ctx, value, maxWidth, trailing = '') {
    const letters = Array.from(value)
    while (letters.length && ctx.measureText(letters.join('') + trailing).width > maxWidth) letters.pop()
    return letters.join('') + trailing
  }

  function fittedText(ctx, value, x, centerY, maxWidth, maxRows, { size, minimum = size, weight = 600, family = sans, color = ink }) {
    let rows
    for (; size >= minimum; size -= 2) {
      font(ctx, size, weight, family)
      rows = wrap(ctx, value, maxWidth)
      if (rows.length <= maxRows && rows.every(line => ctx.measureText(line).width <= maxWidth)) break
    }
    size = Math.max(size, minimum)
    font(ctx, size, weight, family)
    rows = wrap(ctx, value, maxWidth)
    const leading = size * 1.13
    rows.slice(0, maxRows).forEach((line, i) => {
      const overflow = ctx.measureText(line).width > maxWidth || (i === maxRows - 1 && rows.length > maxRows)
      const y = centerY + size * .34 + (i - (Math.min(rows.length, maxRows) - 1) / 2) * leading
      text(ctx, overflow ? shorten(ctx, line, maxWidth, '…') : line, x, y, color)
    })
  }

  function desiredWidth(element) {
    if (element.kind === 'chip') return Math.min(300, Math.max(138, String(element.text || element.label || '').length * 12 + 44))
    if (panels.includes(element.kind)) return ['browser', 'image'].includes(element.kind) ? 808 : 730
    if (element.kind === 'heading') return 650
    if (element.kind === 'text') return 450
    if (element.kind === 'number') return 310
    return 330
  }

  function desiredHeight(element) {
    if (element.kind === 'heading') return 150
    if (element.kind === 'text') return 103
    if (element.kind === 'chip') return 64
    if (element.kind === 'command') return 193
    if (element.kind === 'code') return Math.min(322, 112 + (element.lines?.length || 0) * 24)
    if (element.kind === 'browser' || element.kind === 'image') return 335
    if (element.kind === 'table' || element.kind === 'bars') return 270
    if (element.kind === 'number') return 150
    return 108
  }

  function layoutRows(groups, bounds, { horizontalGap = 50, verticalGap = 26 } = {}) {
    const heights = groups.map(group => Math.max(...group.map(desiredHeight)))
    const targetHeight = heights.reduce((sum, height) => sum + height, 0)
    const scaleY = Math.min(1, (bounds.h - (groups.length - 1) * verticalGap) / targetHeight)
    const totalHeight = targetHeight * scaleY + (groups.length - 1) * verticalGap
    let y = bounds.y + (bounds.h - totalHeight) / 2
    return groups.flatMap((group, i) => {
      const available = bounds.w - horizontalGap * (group.length - 1)
      const preferred = group.reduce((sum, element) => sum + desiredWidth(element), 0)
      const scaleX = Math.min(1, available / preferred)
      let x = bounds.x + (available - preferred * scaleX) / 2
      const rowHeight = heights[i] * scaleY
      const cards = group.map(element => {
        const w = desiredWidth(element) * scaleX
        const h = desiredHeight(element) * scaleY
        const card = { element, x, y: y + (rowHeight - h) / 2, w, h }
        x += w + horizontalGap
        return card
      })
      y += rowHeight + verticalGap
      return cards
    })
  }

  function cluster(elements, perRow, keepHeadings = false) {
    const chunks = []
    let row = []
    for (const el of elements) {
      const fullRow = keepHeadings && (el.kind === 'heading' || panels.includes(el.kind))
      if (row.length && (row.length === perRow || fullRow)) {
        chunks.push(row)
        row = []
      }
      if (fullRow) chunks.push([el])
      else row.push(el)
    }
    if (row.length) chunks.push(row)
    return chunks
  }

  function place(elements, layout) {
    const top = elements.filter(el => el.slot === 'top')
    const bottom = elements.filter(el => el.slot === 'bottom')
    const body = elements.filter(el => el.slot !== 'top' && el.slot !== 'bottom')
    const band = 94
    if (body.length && (top.length || bottom.length)) return [
      ...(top.length ? layoutRows(cluster(top, 3), { ...area, h: band }) : []),
      ...placeBody(body, layout, { ...area, y: area.y + (top.length ? band + 16 : 0),
        h: area.h - ((top.length ? 1 : 0) + (bottom.length ? 1 : 0)) * (band + 16) }),
      ...(bottom.length ? layoutRows(cluster(bottom, 3), { ...area, y: area.y + area.h - band, h: band }) : []),
    ]
    return placeBody(elements, layout, area)
  }

  function placeBody(elements, layout, bounds) {
    if (layout === 'split' && elements.length > 1) {
      const windows = elements.filter(el => panels.includes(el.kind))
      const left = elements.filter(el => el.slot === 'left' || (el.slot !== 'right' && !windows.includes(el)))
      const right = elements.filter(el => !left.includes(el))
      if (!right.length) right.push(...left.splice(Math.ceil(left.length / 2)))
      if (!left.length) left.push(...right.splice(0, 1))
      const leftWidth = windows.some(el => right.includes(el)) && !windows.some(el => left.includes(el)) ? 375 : 525
      return [
        ...layoutRows(cluster(left, 2, true), { ...bounds, w: leftWidth }, { horizontalGap: 14, verticalGap: 14 }),
        ...layoutRows(cluster(right, 2, true), { ...bounds, x: bounds.x + leftWidth + 48, w: bounds.w - leftWidth - 48 }, { horizontalGap: 20, verticalGap: 23 }),
      ]
    }
    if (layout === 'column') return layoutRows(cluster(elements, 1), bounds, { verticalGap: 22 })
    const windows = elements.filter(el => panels.includes(el.kind))
    if (windows.length === 1 && elements.length > 1 && !elements.some(el => el.kind === 'heading')) {
      const rest = elements.filter(el => el !== windows[0])
      return layoutRows([[windows[0]], ...cluster(rest, 3)], bounds)
    }
    const graph = elements.filter(el => el.kind === 'node').length > 1
    return layoutRows(cluster(elements, 3, true), bounds, { horizontalGap: graph ? 110 : 50 })
  }

  function visibleCards(subjects, layout, actions, progress, timeScale) {
    const events = subjects.map(element => ({ at: element.at ?? 0, element }))
    for (const action of actions) {
      if (action.do === 'exit') events.push({ at: action.at, target: action.target })
    }
    events.sort((a, b) => a.at - b.at)
    const active = new Map()
    const retiring = new Map()
    let before = []
    let after = []
    let changed = 0
    function moved(at) {
      const amount = changed === 0 ? 1 : ease((at - changed) * timeScale / .38)
      return after.map(card => {
        const earlier = before.find(item => item.element === card.element)
        if (!earlier) return card
        return { element: card.element, x: blend(earlier.x, card.x, amount), y: blend(earlier.y, card.y, amount),
          w: blend(earlier.w, card.w, amount), h: blend(earlier.h, card.h, amount) }
      })
    }
    for (let i = 0; i < events.length && events[i].at <= progress;) {
      const at = events[i].at
      before = moved(at)
      while (events[i]?.at === at) {
        const { element, target } = events[i++]
        if (element) active.set(element.id, element)
        else if (active.delete(target)) {
          const card = before.find(item => item.element.id === target)
          if (card) retiring.set(target, { ...card, exitAt: at })
        }
      }
      after = active.size ? place(subjects.filter(element => active.has(element.id)), layout) : []
      changed = at
    }
    const going = [...retiring.values()].filter(card => (progress - card.exitAt) * timeScale < .25)
    return [...going, ...moved(progress)]
  }

  function lastAction(actions, id, ...types) {
    return actions.findLast(action => action.target === id && types.includes(action.do))
  }

  function progressOf(event, progress, timeScale, duration = .35) {
    return event ? ease((progress - event.at) * timeScale / duration) : 0
  }

  function appearance(card, allActions, actions, progress, timeScale) {
    const { element } = card
    const at = element.at ?? 0
    const enter = ease((progress - at) * timeScale / .34)
    const currentDim = lastAction(actions, element.id, 'dim', 'restore')
    const change = progressOf(currentDim, progress, timeScale)
    const alpha = currentDim?.do === 'dim' ? blend(1, .27, change) : currentDim ? blend(.27, 1, change) : 1
    const glow = lastAction(actions, element.id, 'highlight', 'focus', 'restore')
    const line = lastAction(actions, element.id, 'highlight', 'restore')
    const active = ['focus', 'highlight'].includes(glow?.do)
    const replace = lastAction(actions, element.id, 'replace')
    const prior = replace && allActions.findLast(action => action.target === element.id && action.do === 'replace' && action.at < replace.at)
    const count = lastAction(actions, element.id, 'count')
    const previousCount = count && allActions.findLast(action => action.target === element.id && action.do === 'count' && action.at < count.at)
    return { enter: at <= 0 ? Math.max(.78, enter) : enter, alpha, active,
      glow, line, replace, prior, switchAmount: progressOf(replace, progress, timeScale, .28),
      count, previousCount, countAmount: progressOf(count, progress, timeScale, .8) }
  }

  function accentFor(tone, active) {
    const theme = colors[tone] || colors.plain
    return active && theme === colors.plain ? colors.accent : theme
  }

  function drawWindow(ctx, card, title, dark) {
    const { x, y, w, h } = card
    const toolbar = Math.min(43, h * .22)
    rounded(ctx, x + 6, y + 6, w, h, 11, dark ? '#7541ae' : ink)
    rounded(ctx, x, y, w, h, 11, dark ? '#20182d' : '#fffaff', ink)
    ctx.fillStyle = dark ? '#5b4769' : '#ddd0eb'
    ctx.fillRect(x + 1, y + toolbar, w - 2, 1.6)
    for (const [i, color] of ['#eb93a6', '#e6bc75', '#8ad0ad'].entries()) {
      rounded(ctx, x + 15 + i * 15, y + toolbar / 2 - 4, 8, 8, 4, color)
    }
    fittedText(ctx, title, x + 69, y + toolbar / 2, w - 84, 1, { size: 16, minimum: 13, family: mono, color: dark ? '#e7dcf4' : muted })
    return toolbar
  }

  function drawLabel(ctx, card, value, active) {
    const { element, x, y, w, h } = card
    const theme = accentFor(element.tone, active)
    if (element.kind === 'heading') {
      fittedText(ctx, value, x, y + h / 2, w, h >= 130 ? 3 : 2, {
        size: w > 525 ? 78 : 62, minimum: h < 94 ? 23 : 30, weight: 500, family: serif,
        color: active || element.tone ? theme.ink : ink,
      })
      return
    }
    if (element.kind === 'text') {
      fittedText(ctx, value, x, y + h / 2, w, h >= 90 ? 3 : 2, {
        size: 35, minimum: 20, weight: 500, color: active || element.tone ? theme.ink : muted,
      })
      return
    }
    const chip = element.kind === 'chip'
    const radius = chip ? h / 2 : 12
    rounded(ctx, x + 4, y + 4, w, h, radius, ink)
    rounded(ctx, x, y, w, h, radius, theme.fill, ink)
    const sub = !chip && element.action
    const titleSize = Math.min(chip ? 23 : 32, h * (sub ? .4 : .54))
    fittedText(ctx, value, x + 19, y + h * (sub ? .36 : .5), w - 38, sub || chip ? 1 : 2, {
      size: titleSize, minimum: Math.min(16, titleSize), weight: 650, family: chip ? mono : sans, color: theme.ink,
    })
    if (sub) {
      const actionSize = Math.min(20, h * .29)
      fittedText(ctx, sub, x + 19, y + h * .75, w - 38, 1, { size: actionSize, minimum: Math.min(13, actionSize), family: mono, color: muted })
    }
  }

  function drawCommand(ctx, card, value, typed) {
    const { x, y, w, h, element } = card
    const toolbar = drawWindow(ctx, card, 'Terminal', true)
    const size = Math.min(29, Math.max(16, Math.round(w / 23)))
    font(ctx, size, 550, mono)
    const characters = Array.from(value)
    const visible = characters.slice(0, Math.ceil(characters.length * typed)).join('')
    const width = w - 97
    const baseline = y + toolbar + Math.max(size + 12, (h - toolbar) * .31)
    const rows = wrap(ctx, visible, width).slice(0, Math.max(1, Math.floor((y + h - baseline - 10) / (size * 1.28)) + 1))
    text(ctx, '$', x + 25, baseline, '#89d9b4')
    for (const [i, row] of rows.entries()) {
      const current = i === rows.length - 1
      const cursor = current && typed < 1 ? '▏' : ''
      const line = ctx.measureText(row + cursor).width > width ? shorten(ctx, row, width, '…') : row + cursor
      text(ctx, line, x + 61, baseline + i * size * 1.28, '#f7efff')
    }
    if (element.ref && h >= 135) fittedText(ctx, element.ref.label || element.ref.path || '', x + 24, y + h - 18, w - 48, 1, {
      size: 14, minimum: 12, family: mono, color: '#c7b3df',
    })
  }

  function sourceRows(lines) {
    const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.match(/^\s*/u)[0].length))
    return lines.map(line => line.slice(indent).replace(/\t/g, '    '))
  }

  function drawSyntax(ctx, value, x, y) {
    let index = 0
    for (const token of value.matchAll(syntax)) {
      if (token.index > index) text(ctx, value.slice(index, token.index), x + ctx.measureText(value.slice(0, index)).width, y, ink)
      const color = syntaxColors[token.slice(1).findIndex(group => group !== undefined)]
      text(ctx, token[0], x + ctx.measureText(value.slice(0, token.index)).width, y, color)
      index = token.index + token[0].length
    }
    if (index < value.length) text(ctx, value.slice(index), x + ctx.measureText(value.slice(0, index)).width, y, ink)
  }

  function drawCode(ctx, card, state) {
    const { x, y, w, h, element } = card
    const title = element.ref?.path || element.ref?.label || element.label || 'Source'
    const toolbar = drawWindow(ctx, card, title, false)
    if (!element.lines?.length) {
      fittedText(ctx, title, x + 25, y + (h + toolbar) / 2, w - 50, 2, { size: 26, minimum: 17, family: mono })
      return
    }
    const start = element.startLine ?? 1
    const event = state.line
    const line = event?.line ?? element.focusLine ?? start
    const lineEnd = event?.lineEnd ?? line
    const size = Math.floor(Math.min(22, Math.max(10, ((h - toolbar - 17) / Math.min(10, element.lines.length)) - 6)))
    const leading = size + 6
    const maxRows = Math.max(1, Math.floor((h - toolbar - 14) / leading))
    const offset = Math.max(0, Math.min(element.lines.length - maxRows, line - start - 2))
    const lines = sourceRows(element.lines.slice(offset, offset + maxRows))
    const gutter = Math.max(43, 18 + String(start + offset + lines.length).length * size * .67)
    ctx.fillStyle = '#e2d7eb'
    ctx.fillRect(x + gutter, y + toolbar + 6, 1, h - toolbar - 12)
    for (const [i, content] of lines.entries()) {
      const row = y + toolbar + 7 + i * leading
      const number = start + offset + i
      if ((state.active || element.focusLine) && number >= line && number <= lineEnd) rounded(ctx, x + 8, row, w - 16, leading - 1, 4, '#e5cdfa')
      font(ctx, size - 2, 500, mono)
      ctx.textAlign = 'right'
      text(ctx, String(number), x + gutter - 9, row + size, muted)
      ctx.textAlign = 'left'
      font(ctx, size, 500, mono)
      const available = w - gutter - 29
      const visible = ctx.measureText(content).width > available ? shorten(ctx, content, available, '…') : content
      drawSyntax(ctx, visible, x + gutter + 13, row + size)
    }
  }

  function drawBrowser(ctx, card) {
    const { x, y, w, h, element } = card
    const toolbar = drawWindow(ctx, card, element.address || element.title || element.text || 'Browser', false)
    const inset = Math.min(15, h * .1)
    const items = element.items || []
    if (!items.length) return
    const columns = items.length === 1 ? 1 : 2
    const rows = Math.ceil(items.length / columns)
    const gap = Math.min(12, h * .06)
    const sw = (w - inset * 2 - (columns - 1) * gap) / columns
    const sh = (h - toolbar - inset * 2 - (rows - 1) * gap) / rows
    for (const [i, label] of items.entries()) {
      const sx = x + inset + (i % columns) * (sw + gap)
      const sy = y + toolbar + inset + Math.floor(i / columns) * (sh + gap)
      rounded(ctx, sx, sy, sw, sh, 8, '#f3e9fd', '#cbbbdc', 1.5)
      const size = Math.min(23, sh * .65)
      fittedText(ctx, label, sx + 12, sy + sh * .5, sw - 24, 1, { size, minimum: Math.min(12, size) })
    }
  }

  function drawImage(ctx, card) {
    const { x, y, w, h, element } = card
    const title = element.label || 'Repository image'
    const toolbar = drawWindow(ctx, card, title, false)
    const source = decodedImages.get(element)
    if (!source) {
      fittedText(ctx, title, x + 25, y + (h + toolbar) / 2, w - 50, 2, { size: 25, minimum: 15, family: mono, color: muted })
      return
    }
    const inset = 11
    const scale = Math.min((w - inset * 2) / source.naturalWidth, (h - toolbar - inset * 2) / source.naturalHeight)
    const imageWidth = source.naturalWidth * scale
    const imageHeight = source.naturalHeight * scale
    ctx.drawImage(source, x + (w - imageWidth) / 2, y + toolbar + (h - toolbar - imageHeight) / 2, imageWidth, imageHeight)
  }

  function drawTable(ctx, card, state) {
    const { x, y, w, h, element } = card
    const toolbar = drawWindow(ctx, card, element.title || element.label || 'Table', false)
    const header = element.columns
    if (!header?.length) return
    const rows = [header, ...(element.rows || [])]
    const sw = (w - 18) / header.length
    const rowH = (h - toolbar - 12) / rows.length
    for (const [i, row] of rows.entries()) {
      const sy = y + toolbar + 6 + i * rowH
      const focused = state.active && i === (state.line?.row ?? state.line?.line)
      if (!i || i % 2 === 0 || focused) {
        ctx.fillStyle = focused ? '#e5cdfa' : '#f1e8fa'
        ctx.fillRect(x + 9, sy, w - 18, rowH)
      }
      for (const [j, item] of row.slice(0, header.length).entries()) {
        fittedText(ctx, item, x + 17 + j * sw, sy + rowH / 2, sw - 16, 1,
          { size: Math.min(i ? 18 : 19, Math.max(11, rowH * .55)), minimum: 10, weight: i ? 500 : 700, family: i ? mono : sans })
      }
    }
  }

  function drawBars(ctx, card, state, age) {
    const { x, y, w, h, element } = card
    const toolbar = drawWindow(ctx, card, element.title || element.label || 'Comparison', false)
    const items = element.items || []
    const maximum = Math.max(1, ...items.map(item => Math.abs(item.value)))
    const barX = x + w * .31
    const available = w * .54
    const rowH = (h - toolbar - 38) / Math.max(1, items.length)
    for (const [i, item] of items.entries()) {
      const cy = y + toolbar + 19 + rowH * (i + .5)
      const height = Math.max(4, Math.min(29, rowH * .55))
      const animated = ease((age - i * .09) / .58)
      const width = Math.abs(item.value) / maximum * available * animated
      fittedText(ctx, item.label, x + 20, cy, w * .26, 1, { size: 18, minimum: 11 })
      rounded(ctx, barX, cy - height / 2, available, height, 4, '#efe6f7')
      if (width > 2) rounded(ctx, barX, cy - height / 2, width, height, 4,
        state.active && i === (state.line?.row ?? state.line?.line ?? 1) - 1 ? '#9660d3' : '#c6a0f0', '#5d397a', 1.3)
      if (animated > .36) fittedText(ctx, String(item.value) + (element.unit || ''), barX + available + 10, cy,
        w * .15 - 15, 1, { size: 17, minimum: 10, family: mono })
    }
  }

  function drawNumber(ctx, card, state) {
    const { x, y, w, h, element } = card
    const from = state.previousCount?.value ?? element.value ?? 0
    const to = state.count?.value ?? from
    const number = blend(from, to, state.countAmount)
    const decimals = Number.isInteger(to) && Number.isInteger(from) ? 0 : Math.min(2, String(to).split('.')[1]?.length || 1)
    const label = state.replace?.text ?? element.label
    const theme = accentFor(element.tone || 'accent', state.active)
    const value = number.toLocaleString('en-US', { maximumFractionDigits: decimals }) + (element.suffix || '')
    fittedText(ctx, value, x, y + h * (label ? .39 : .52), w, 1, {
      size: h >= 100 ? 78 : 61, minimum: 26, weight: 500, family: serif, color: theme.ink,
    })
    if (label) fittedText(ctx, label, x + 2, y + h * .77, w - 4, 2, { size: 20, minimum: 13, color: muted })
  }

  function drawElement(ctx, card, state, progress, timeScale) {
    if (!state.enter) return
    const { element } = card
    const content = element.command || element.text || element.label || ''
    const current = state.replace?.text ?? content
    const old = state.prior?.text ?? content
    ctx.save()
    const exit = card.exitAt == null ? 1 : 1 - ease((progress - card.exitAt) * timeScale / .25)
    ctx.globalAlpha *= state.enter * state.alpha * exit
    ctx.translate(0, (1 - state.enter) * 14)
    if (element.kind === 'code') drawCode(ctx, card, state)
    else if (element.kind === 'browser') drawBrowser(ctx, card)
    else if (element.kind === 'image') drawImage(ctx, card)
    else if (element.kind === 'table') drawTable(ctx, card, state)
    else if (element.kind === 'bars') drawBars(ctx, card, state, (progress - (element.at ?? 0)) * timeScale)
    else if (element.kind === 'number') drawNumber(ctx, card, state)
    else if (element.kind === 'command') {
      const since = (progress - (state.replace?.at ?? element.at ?? 0)) * timeScale
      const typed = clamp((since + .07) / Math.max(.4, Math.min(1, current.length / 32)))
      drawCommand(ctx, card, current, typed)
    } else {
      const switchover = state.switchAmount < .5
      const moving = state.replace && state.switchAmount < 1
      if (moving) {
        ctx.globalAlpha *= .5 + Math.abs(state.switchAmount - .5)
        ctx.translate(switchover ? -16 * state.switchAmount : 16 * (1 - state.switchAmount), 0)
      }
      drawLabel(ctx, card, moving && switchover ? old : current, state.active)
    }
    ctx.restore()
  }

  function center(card) {
    return [card.x + card.w / 2, card.y + card.h / 2]
  }

  function routeAroundCards(preferred, from, to, obstacles, horizontal) {
    const boxes = [...obstacles.map(card => [card, 8]), [from, 0], [to, 0]].map(([card, padding]) => ({
      left: card.x - padding, right: card.x + card.w + padding,
      top: card.y - padding, bottom: card.y + card.h + padding,
    }))
    const blocked = ([ax, ay], [bx, by]) => boxes.some(box => ax === bx
      ? ax > box.left && ax < box.right && Math.max(ay, by) > box.top && Math.min(ay, by) < box.bottom
      : ay > box.top && ay < box.bottom && Math.max(ax, bx) > box.left && Math.min(ax, bx) < box.right)
    if (preferred.slice(1).every((point, i) => !blocked(preferred[i], point))) return preferred

    const start = preferred[0]
    const end = preferred.at(-1)
    const axis = horizontal ? 0 : 1
    const sign = Math.sign(end[axis] - start[axis])
    const xs = [...new Set([start[0], end[0], ...boxes.flatMap(box => [box.left, box.right])])].sort((a, b) => a - b)
    const ys = [...new Set([start[1], end[1], ...boxes.flatMap(box => [box.top, box.bottom])])].sort((a, b) => a - b)
    const points = xs.flatMap(x => ys.map(y => [x, y]))
    const first = xs.indexOf(start[0]) * ys.length + ys.indexOf(start[1])
    const last = xs.indexOf(end[0]) * ys.length + ys.indexOf(end[1])
    const costs = Array(points.length * 2).fill(Infinity)
    const previous = Array(costs.length).fill(-1)
    const visited = new Set()
    costs[first * 2 + axis] = 0
    // The grid is bounded by at most six visible cards. Keep the endpoint ports
    // and prefer fewer bends while finding a clear orthogonal route.
    for (;;) {
      let current = -1
      for (let i = 0; i < costs.length; i++) {
        if (!visited.has(i) && costs[i] < (current < 0 ? Infinity : costs[current])) current = i
      }
      if (current < 0) return []
      const index = Math.floor(current / 2)
      if (index === last) {
        const route = []
        for (let state = current; state >= 0; state = previous[state]) route.push(points[Math.floor(state / 2)])
        route.reverse()
        return route.filter((point, i) => !i || i === route.length - 1
          || ![0, 1].some(axis => route[i - 1][axis] === point[axis] && point[axis] === route[i + 1][axis]))
      }
      visited.add(current)
      const x = Math.floor(index / ys.length)
      const y = index % ys.length
      const neighbors = [x > 0 ? index - ys.length : -1, x + 1 < xs.length ? index + ys.length : -1,
        y > 0 ? index - 1 : -1, y + 1 < ys.length ? index + 1 : -1]
      for (const [direction, next] of neighbors.entries()) {
        if (next < 0 || next === first) continue
        const nextAxis = direction < 2 ? 0 : 1
        if ((index === first || next === last)
          && (nextAxis !== axis || Math.sign(points[next][axis] - points[index][axis]) !== sign)) continue
        if (blocked(points[index], points[next])) continue
        const state = next * 2 + nextAxis
        const distance = Math.abs(points[next][0] - points[index][0]) + Math.abs(points[next][1] - points[index][1])
        const cost = costs[current] + distance + (nextAxis === current % 2 ? 0 : 12)
        if (cost < costs[state]) { costs[state] = cost; previous[state] = current }
      }
    }
  }

  function edgePoints(from, to, obstacles) {
    const [ax, ay] = center(from)
    const [bx, by] = center(to)
    const dx = bx - ax
    const dy = by - ay
    if (dx === 0 && dy === 0) return []
    const horizontalGap = dx > 0 ? to.x - from.x - from.w : from.x - to.x - to.w
    const verticalGap = dy > 0 ? to.y - from.y - from.h : from.y - to.y - to.h
    if (horizontalGap > 8 && (verticalGap <= 8 || Math.abs(dx) >= Math.abs(dy) * .7)) {
      const sign = Math.sign(dx)
      const start = ax + sign * (from.w / 2 + 1)
      const end = bx - sign * (to.w / 2 + 3)
      const middle = (start + end) / 2
      const crowded = Math.abs(dy) < 6 && obstacles.some(card =>
        card.x > Math.min(start, end) && card.x + card.w < Math.max(start, end)
        && ay >= card.y && ay <= card.y + card.h)
      if (!crowded && Math.abs(dy) < 6) return routeAroundCards([[start, ay], [end, by]], from, to, obstacles, true)
      if (!crowded) return routeAroundCards([[start, ay], [middle, ay], [middle, by], [end, by]], from, to, obstacles, true)
      const lane = Math.max(from.y + from.h, to.y + to.h) + 38
      return routeAroundCards([[start, ay], [start + sign * 18, ay], [start + sign * 18, lane],
        [end - sign * 18, lane], [end - sign * 18, by], [end, by]], from, to, obstacles, true)
    }
    if (!dy) return []
    const sign = Math.sign(dy)
    const start = ay + sign * (from.h / 2 + 1)
    const end = by - sign * (to.h / 2 + 3)
    if (Math.abs(dx) < 4) return routeAroundCards([[ax, start], [bx, end]], from, to, obstacles, false)
    const middle = (start + end) / 2
    return routeAroundCards([[ax, start], [ax, middle], [bx, middle], [bx, end]], from, to, obstacles, false)
  }

  function pointAt(points, lengths, distance) {
    for (const [i, length] of lengths.entries()) {
      if (length > 0 && distance <= length) {
        const ratio = distance / length
        return { x: blend(points[i][0], points[i + 1][0], ratio), y: blend(points[i][1], points[i + 1][1], ratio), i }
      }
      distance -= length
    }
    const [x, y] = points.at(-1)
    return { x, y, i: lengths.length - 1 }
  }

  function drawArrow(ctx, arrow, from, to, cards, actions, progress, timeScale) {
    const at = Math.max(arrow.at ?? 0, from.element.at ?? 0, to.element.at ?? 0)
    const age = (progress - at) * timeScale
    if (age <= 0) return
    const points = edgePoints(from, to, cards.filter(card => card !== from && card !== to))
    if (points.length < 2) return
    const lengths = points.slice(1).map(([x, y], i) => Math.hypot(x - points[i][0], y - points[i][1]))
    const total = lengths.reduce((sum, length) => sum + length, 0)
    const grow = ease(age / .44)
    const head = pointAt(points, lengths, total * grow)
    const focused = lastAction(actions, arrow.id, 'highlight', 'focus')
    const color = focused || arrow.tone === 'accent' ? violet : ink
    const exit = Math.min(from.exitAt ?? Infinity, to.exitAt ?? Infinity, lastAction(actions, arrow.id, 'exit')?.at ?? Infinity)
    const opacity = 1 - ease((progress - exit) * timeScale / .25)
    if (!opacity) return
    ctx.save()
    ctx.globalAlpha *= opacity
    ctx.strokeStyle = color
    ctx.lineWidth = 2.9
    ctx.lineJoin = 'round'
    ctx.beginPath()
    points.slice(0, head.i + 1).forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y))
    ctx.lineTo(head.x, head.y)
    ctx.stroke()
    const [ax, ay] = points[head.i]
    const [bx, by] = points[head.i + 1]
    const direction = Math.atan2(by - ay, bx - ax)
    ctx.beginPath()
    ctx.moveTo(head.x, head.y)
    ctx.lineTo(head.x - 10 * Math.cos(direction - .54), head.y - 10 * Math.sin(direction - .54))
    ctx.lineTo(head.x - 10 * Math.cos(direction + .54), head.y - 10 * Math.sin(direction + .54))
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    const flow = lastAction(actions, arrow.id, 'flow')
    if ((flow || age < 1.5) && grow >= .96) {
      const distance = flow ? (progress - flow.at) * timeScale : age - .44
      if (distance >= 0 && distance < 2.4) {
        const ping = pointAt(points, lengths, total * ((distance / .83) % 1))
        rounded(ctx, ping.x - 5, ping.y - 5, 10, 10, 5, '#a75ce7', ink, 1)
      }
    }
    const label = lastAction(actions, arrow.id, 'replace')?.text ?? arrow.label ?? arrow.text
    const longHorizontal = points.slice(1).flatMap(([x, y], i) => y === points[i][1] && lengths[i] >= 30
      ? [{ x: (x + points[i][0]) / 2, y, width: lengths[i] }] : [])
      .sort((a, b) => b.width - a.width)[0]
    if (label && longHorizontal && grow > .9) {
      const { x, y, width } = longHorizontal
      ctx.textAlign = 'center'
      fittedText(ctx, label, x, y - 17, Math.max(58, width - 6), 2, { size: 16, minimum: 12, color })
    }
    ctx.restore()
  }

  function focusCamera(ctx, cards, actions, progress, timeScale) {
    const event = actions.findLast(action => action.do === 'focus' || action.do === 'reset')
    const target = event && cards.find(card => card.element.id === event.target)
    const amount = progressOf(event, progress, timeScale, .5)
    const priorEvent = event && actions.findLast(action => action.at < event.at && ['focus', 'reset'].includes(action.do))
    const prior = priorEvent?.do === 'focus' && cards.find(card => card.element.id === priorEvent.target)
    const left = Math.min(...cards.map(card => card.x))
    const top = Math.min(...cards.map(card => card.y))
    const right = Math.max(...cards.map(card => card.x + card.w)) + 7
    const bottom = Math.max(...cards.map(card => card.y + card.h)) + 7
    const limit = (value, low, high) => Math.max(low, Math.min(high, value))
    const camera = card => {
      if (!card) return [1, 0, 0]
      const [x, y] = center(card)
      const scale = Math.min(1.09, 1192 / (right - left), 512 / (bottom - top))
      const dx = limit((640 - x) * .14, 44 - 640 - (left - 640) * scale, 1236 - 640 - (right - 640) * scale)
      const dy = limit((340 - y) * .16, 83 - 340 - (top - 340) * scale, 595 - 340 - (bottom - 340) * scale)
      return [scale, dx, dy]
    }
    const [scale, x, y] = camera(event?.do === 'focus' && target).map((value, i) => blend(camera(prior)[i], value, amount))
    ctx.translate(640 + x, 340 + y)
    ctx.scale(scale, scale)
    ctx.translate(-640, -340)
  }

  function draw(ctx, scene, progress, localSeconds) {
    const motion = scene.motion
    const elements = motion.elements.filter(element => element.kind !== 'arrow')
    if (!elements.length) return
    const timeScale = Math.max(.01, scene.speechSeconds || scene.duration || 1)
    const actions = (motion.actions || []).toSorted((a, b) => a.at - b.at)
    const current = actions.filter(action => action.at <= progress)
    const cards = visibleCards(elements, motion.layout, current, progress, timeScale)
    if (!cards.length) return
    const byId = new Map(cards.map(card => [card.element.id, card]))
    ctx.save()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    const enter = ease(localSeconds / .38)
    if (motion.transition === 'slide') ctx.translate((1 - enter) * 52, 0)
    if (motion.transition === 'push') {
      ctx.translate(640, 340)
      ctx.scale(.95 + enter * .05, .95 + enter * .05)
      ctx.translate(-640, -340)
    }
    focusCamera(ctx, cards, current, progress, timeScale)
    for (const arrow of motion.elements.filter(element => element.kind === 'arrow')) {
      const from = byId.get(arrow.from)
      const to = byId.get(arrow.to)
      if (from && to) drawArrow(ctx, arrow, from, to, cards, current, progress, timeScale)
    }
    for (const card of cards) drawElement(ctx, card, appearance(card, actions, current, progress, timeScale), progress, timeScale)
    ctx.restore()
  }

  return { draw, prepare }
})()

export function drawMotionScene(ctx, scene, progress, localSeconds) {
  videoMotion.draw(ctx, scene, progress, localSeconds)
}

export async function prepareMotionImages(film) {
  await videoMotion.prepare(film)
}
