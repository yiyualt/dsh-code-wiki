import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadVideoCommands, loadVideoExcerpt, loadVideoMaterial, videoReferences } from '../src/video-evidence.js'

const commit = 'a'.repeat(40)
const repoUrl = 'https://github.com/example/repo'
const blob = `${repoUrl}/blob/${commit}/`
const id = 'c0389956-ab70-4df6-9048-caa83f69314a'
const local = (file, start, end) => `https://dsh-code-wiki.invalid/source?key=${id}&file=${file}&start=${start}&end=${end}`
const markdown = urls => urls.map(url => `[Citation](${url})`).join('\n')

const cite = blob + 'src/test%20file.py#L2-L14'
const graph = blob + 'src/graph.py#L5'

test('GitHub video citations only contain paths and lines from the archived repository and commit', () => {
  const document = { source: 'github', repoUrl, commit,
    markdown: markdown([cite, cite, blob + 'src/%2e%2e/token#L1', blob + 'src%2ftest#L1', blob + 'src/test#L8-L6',
      repoUrl + '/blob/main/src/test#L1', blob + 'src/test#L1-L40', 'https://example.org/src#L1']),
    architecture: { layers: [{ nodes: [{ refs: [{ url: graph }] }] }], edges: [{ refs: [{ url: cite }] }] } }
  assert.deepEqual(videoReferences(document), [
    { id: 1, label: 'src/test file.py:2–14', url: cite, path: 'src/test file.py', start: 2, end: 14 },
    { id: 2, label: 'src/graph.py:5', url: graph, path: 'src/graph.py', start: 5, end: 5 },
  ])
})

test('GitHub video excerpts fetch only cataloged pinned files and return at most eight exact lines', async t => {
  const document = { source: 'github', repoUrl, commit, markdown: markdown([cite]) }
  let calls = 0
  const lines = Array.from({ length: 15 }, (_, i) => `  line ${i + 1}`)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, `https://raw.githubusercontent.com/example/repo/${commit}/src/test%20file.py`)
    assert.equal(options.redirect, 'manual')
    assert.equal('Authorization' in options.headers, false)
    return new Response(lines.join('\r\n'))
  })
  const signal = new AbortController().signal
  assert.equal(await loadVideoExcerpt(document, { url: graph }, signal), null)
  assert.equal(await loadVideoExcerpt(document, { url: cite }, signal, { startLine: 1 }), null)
  assert.equal(calls, 0)
  const first = await loadVideoExcerpt(document, { url: cite, path: 'forged.js', end: 1_000 }, signal, { startLine: 3 })
  assert.deepEqual(first, { path: 'src/test file.py', startLine: 3, lines: lines.slice(2, 10) })
  const last = await loadVideoExcerpt(document, { url: cite }, signal, { startLine: 13 })
  assert.deepEqual(last.lines, lines.slice(12, 14))
})

test('local video excerpts use only the archived file and its original line numbers', async () => {
  const url = local(1, 12, 14)
  const document = { id, source: 'local',
    files: [{ path: 'src/config.py', startLine: 11, text: '11\r\n  12\r\n\t13\r\n14\r\n' }],
    markdown: markdown([url, local(1, 8, 10), local(1, 11, 15), local(2, 12, 14), url.replace(id, 'e'.repeat(36))]) }
  const refs = videoReferences(document)
  assert.deepEqual(refs, [{ id: 1, label: 'src/config.py:12–14', url, path: 'src/config.py', start: 12, end: 14 }])
  assert.deepEqual(await loadVideoExcerpt(document, refs[0], undefined, { startLine: 13 }), {
    path: 'src/config.py', startLine: 13, lines: ['\t13', '14'],
  })
  await assert.rejects(loadVideoExcerpt(document, refs[0], AbortSignal.abort()), { name: 'AbortError' })
})

test('video commands come from shell fences in the pinned README and prioritize the quick start', async t => {
  const document = { source: 'github', repoUrl, commit }
  const readme = [
    '# Example', '## Installation', '```bash', 'pip install example', '```',
    '## Quick-Start', '```sh', 'python run_example.py --model=BPR', '# Ignore comments', '```',
    '```console', '$ example check', 'STATUS generated output', '```',
    '```text', 'non-shell example', '```',
    '```bash', 'ignore truncated block',
  ].join('\r\n')
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `https://raw.githubusercontent.com/example/repo/${commit}/README.md`)
    assert.equal(options.redirect, 'manual')
    return new Response(readme)
  })
  const commands = await loadVideoCommands(document)
  assert.deepEqual(commands, [
    { id: 1, command: 'python run_example.py --model=BPR',
      ref: { label: 'README.md:8', url: blob + 'README.md#L8', path: 'README.md', start: 8, end: 8 } },
    { id: 2, command: 'example check',
      ref: { label: 'README.md:12', url: blob + 'README.md#L12', path: 'README.md', start: 12, end: 12 } },
    { id: 3, command: 'pip install example',
      ref: { label: 'README.md:4', url: blob + 'README.md#L4', path: 'README.md', start: 4, end: 4 } },
  ])
})

test('local video commands retain the README archive offset and never fetch anything', async () => {
  const document = { id, source: 'local', files: [
    { path: 'docs/README.md', text: '```bash\nwrong readme\n```' },
    { path: 'readme.md', startLine: 20, text: '## Usage\n~~~zsh\n$ npm run start\n~~~\n' },
  ] }
  assert.deepEqual(await loadVideoCommands(document), [
    { id: 1, command: 'npm run start', ref: { path: 'readme.md', label: 'readme.md:22', url: local(2, 22, 22), start: 22, end: 22 } },
  ])
  await assert.rejects(loadVideoCommands(document, AbortSignal.abort()), { name: 'AbortError' })
})

test('video director receives diverse cited source, bounded README, and at most three reads at a time', async t => {
  const paths = ['tests/focus.py', 'src/main.py', 'README.md', ...Array.from({ length: 12 }, (_, i) => `src/package-${i}.py`)]
  const document = { source: 'github', repoUrl, commit,
    markdown: markdown([blob + 'src/main.py#L12-L18', ...paths.map(path => blob + path + '#L2-L26')]) }
  const lines = Array.from({ length: 40 }, (_, i) => `source line ${i + 1}`)
  let pending = 0
  let peak = 0
  const reads = []
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname.split('/').slice(4).join('/')
    reads.push(path)
    peak = Math.max(peak, ++pending)
    await new Promise(resolve => setImmediate(resolve))
    pending--
    if (path === 'src/package-0.py') return new Response(null, { status: 404 })
    if (path === 'README.md') return new Response('## Usage\n```bash\npython src/main.py\n```\n\n' + 'a'.repeat(20_000))
    return new Response(lines.join('\n'))
  })
  const result = await loadVideoMaterial(document)
  assert.equal(result.readme.length, 18_000)
  assert.equal(result.commands[0].command, 'python src/main.py')
  assert.equal(result.references.length, paths.length + 1)
  assert.equal(result.excerpts[0].path, 'src/main.py')
  assert.equal(result.excerpts[0].id, 3)
  assert.deepEqual(result.excerpts[0].lines, lines.slice(1, 26))
  assert.equal(result.excerpts.some(excerpt => excerpt.path === 'tests/focus.py' || excerpt.path === 'src/package-0.py'), false)
  assert.equal(result.excerpts.length, 9)
  assert.equal(reads.filter(path => path === 'README.md').length, 1)
  assert.equal(new Set(reads).size, reads.length)
  assert.equal(peak, 3)
})

test('video director uses only locally saved excerpt ranges and preserves missing-material behavior', async () => {
  const document = { id, source: 'local',
    files: [{ path: 'src/main.py', startLine: 6, text: Array.from({ length: 25 }, (_, i) => `line ${i + 6}`).join('\n') }],
    markdown: markdown([local(1, 6, 30)]) }
  const original = await loadVideoMaterial(document)
  assert.deepEqual(original, { references: videoReferences(document), commands: [], images: [], excerpts: [
    { id: 1, path: 'src/main.py', startLine: 6, lines: document.files[0].text.split('\n') },
  ] })
  const shortened = await loadVideoExcerpt(document, original.references[0], undefined, { startLine: 25, maxLines: 30 })
  assert.deepEqual(shortened.lines, document.files[0].text.split('\n').slice(-6))
  assert.deepEqual(await loadVideoMaterial({ id, source: 'local' }), { references: [], commands: [], excerpts: [], images: [] })
  await assert.rejects(loadVideoMaterial(document, AbortSignal.abort()), { name: 'AbortError' })
})

test('video material permits only valid static image bytes at the same repository commit', async t => {
  const document = { source: 'github', repoUrl, commit }
  const raw = `https://raw.githubusercontent.com/example/repo/${commit}/`
  const readme = [
    '![Coverage](assets/check.png)', '![Logo](https://external.example/logo.png)',
    `![Newer](${raw.replace(commit, 'main')}asset/newer.png)`,
    `![Other repo](${raw.replace('/example/repo/', '/other/repo/')}asset/other.png)`,
    '![Traversal](assets/%2e%2E/demo.png)', '![Tracking](assets/track.png?key=alpha)',
    '![Active](assets/demo.svg)', '![Badge](assets/badge.png)',
    '<!-- ![Hidden](assets/hidden.png) -->', '```text', '![Fake](assets/fenced.png)', '```',
    '![Oversized](assets/big.png)', '![Wrong bytes](assets/bad.jpg)',
    '![Logo](./assets/logo.png)', `<img src="${raw}assets/demo.jpg" alt="Interface">`,
    '![Logo duplicate](assets/logo.png)', '![Unused](assets/unused.webp)',
  ].join('\n')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+VCm8AAAAASUVORK5CYII=', 'base64')
  const jpeg = Buffer.from([255, 216, 255, 217])
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert(url.startsWith(raw), 'only the pinned raw host may be fetched')
    assert.equal(options.redirect, 'manual')
    const path = url.slice(raw.length)
    calls.push(path)
    if (path === 'README.md') return new Response(readme)
    if (path === 'assets/big.png') return new Response(Buffer.alloc(2 * 1024 * 1024 + 1))
    if (path === 'assets/bad.jpg') return new Response(png)
    if (path === 'assets/logo.png') return new Response(png)
    if (path === 'assets/demo.jpg') return new Response(jpeg)
    assert.fail(`Unexpected image fetch: ${path}`)
  })
  const { images } = await loadVideoMaterial(document)
  assert.deepEqual(calls, ['README.md', 'assets/big.png', 'assets/bad.jpg', 'assets/logo.png', 'assets/demo.jpg'])
  assert.deepEqual(images, [
    { id: 'image-1', path: 'assets/logo.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
    { id: 'image-2', path: 'assets/demo.jpg', mimeType: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
  ])
})

test('video introduction documents prioritize linked project explanations with a bounded shared read pool', async t => {
  const document = { source: 'github', repoUrl, commit }
  const readme = [
    '# Project', '[Developer details](docs/developer.md)', '[Installation](docs/install.md)',
    '[Overview](docs/overview.md#purpose)', '[Features][features]', '[Use cases](./docs/use-cases.mdx)',
    '[Quick start](docs/getting-started.md)', '[Changelog](CHANGELOG.md)',
    '[Outside](https://example.org/intro.md)', '[Escape](docs/%2e%2e/secret.md)',
    '[Absolute](/docs/intro.md)', '[Query](docs/intro.md?key=bad)',
    '![Image with document suffix](docs/fake.md)',
    '<!-- [Hidden](docs/hidden.md) -->', '```md', '[Fenced](docs/fenced.md)', '```',
    '[features]: <docs/features.md>',
  ].join('\n')
  const calls = []
  let pending = 0
  let peak = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert(url.startsWith(`https://raw.githubusercontent.com/example/repo/${commit}/`))
    assert.equal(options.redirect, 'manual')
    const path = url.split(`/${commit}/`)[1]
    calls.push(path)
    peak = Math.max(peak, ++pending)
    await new Promise(resolve => setImmediate(resolve))
    pending--
    if (path === 'README.md') return new Response(readme)
    assert(['docs/overview.md', 'docs/features.md', 'docs/use-cases.mdx'].includes(path), path)
    return new Response(path + '\n' + 'purpose and audience '.repeat(500))
  })
  const material = await loadVideoMaterial(document)
  assert.deepEqual(material.documents.map(item => item.path), ['docs/overview.md', 'docs/features.md', 'docs/use-cases.mdx'])
  assert.deepEqual(material.documents.map(item => item.text.length), [6_000, 6_000, 4_000])
  assert(material.documents.every(item => item.url.startsWith(blob)))
  assert.deepEqual(calls, ['README.md', 'docs/overview.md', 'docs/features.md', 'docs/use-cases.mdx'])
  assert.equal(peak, 3)
})

test('video material reads README.rst when the Markdown readme is absent and follows its intro link', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    const path = url.split(`/${commit}/`)[1]
    calls.push(path)
    if (path === 'README.md') return new Response(null, { status: 404 })
    if (path === 'README.rst') return new Response('Project\n=======\nA tool for researchers.\n`Features <guide/intro.rst>`_')
    if (path === 'guide/intro.rst') return new Response('Features\n========\nCompares saved experiments for researchers.')
    assert.fail(`Unexpected fallback: ${path}`)
  })
  const material = await loadVideoMaterial({ source: 'github', repoUrl, commit })
  assert.match(material.readme, /A tool for researchers/)
  assert.deepEqual(material.documents, [{ path: 'guide/intro.rst',
    text: 'Features\n========\nCompares saved experiments for researchers.', url: blob + 'guide/intro.rst#L1' }])
  assert.deepEqual(calls, ['README.md', 'README.rst', 'guide/intro.rst'])
})

test('local introduction documents use only archived linked files and omit unavailable material', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Local video material must remain offline'))
  const document = { id, source: 'local', files: [
    { path: 'docs/elsewhere.md', text: 'Unlinked content must stay out.' },
    { path: 'README.rst', startLine: 10, text: 'Project\n=======\n`Use cases <docs/use-cases.md>`_\n[Missing](docs/overview.md)' },
    { path: 'docs/use-cases.md', startLine: 30, text: '# Use cases\nResearchers compare multiple experiments.' },
    { path: 'docs/overview.md', text: 'invalid\0document' },
  ] }
  const material = await loadVideoMaterial(document)
  assert.deepEqual(material.documents, [{ path: 'docs/use-cases.md',
    text: '# Use cases\nResearchers compare multiple experiments.', url: local(3, 30, 30) }])
  assert.equal(material.commands.length, 0)
  const missing = await loadVideoMaterial({ id, source: 'local', files: document.files.slice(0, 2) })
  assert.equal('documents' in missing, false)
})

test('local video material prefers canonical then English README files and retains localized archive provenance', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Archived localized README selection must stay offline'))
  const document = { id, source: 'local', files: [
    { path: 'docs/README.md', text: 'Nested README is not the project introduction.' },
    { path: 'README_CN.md', startLine: 12, text: '# 项目介绍\n工具服务研究人员。\n[功能](docs/features.md)' },
    { path: 'README.zh-CN.md', text: 'Another localized introduction.' },
    { path: 'README.en-US.md', text: 'English project introduction.' },
    { path: 'README.rst', text: 'Canonical reStructuredText introduction.' },
    { path: 'README.md', text: 'Canonical Markdown introduction.' },
    { path: 'docs/features.md', startLine: 20, text: '# Features\nSupports reproducible experiments.' },
  ] }
  const canonical = await loadVideoMaterial(document)
  assert.equal(canonical.readme, 'Canonical Markdown introduction.')
  assert.equal(canonical.readmePath, 'README.md')
  assert.equal(canonical.readmeUrl, local(6, 1, 1))
  const rst = await loadVideoMaterial({ ...document, files: document.files.filter(file => file.path !== 'README.md') })
  assert.equal(rst.readmePath, 'README.rst')
  const english = await loadVideoMaterial({ ...document, files: document.files.filter(file => !/^README\.(?:md|rst)$/.test(file.path)) })
  assert.equal(english.readmePath, 'README.en-US.md')
  const localizedFiles = document.files.filter(file => file.path !== 'README.en-US.md' && !/^README\.(?:md|rst)$/.test(file.path))
  const localized = await loadVideoMaterial({ ...document, files: localizedFiles })
  assert.equal(localized.readmePath, 'README_CN.md')
  assert.equal(localized.readmeUrl, local(2, 12, 12))
  assert.deepEqual(localized.documents, [{ path: 'docs/features.md', text: '# Features\nSupports reproducible experiments.', url: local(4, 20, 20) }])
  const reordered = await loadVideoMaterial({ ...document, files: [...localizedFiles].reverse() })
  assert.equal(reordered.readmePath, localized.readmePath)
})
