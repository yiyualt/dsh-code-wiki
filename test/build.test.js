import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Script } from 'node:vm'

const exec = promisify(execFile)
const inputs = ['scripts/build.mjs', 'src/client.js', 'src/folder-browser.js', 'src/wiki-styles.css',
  'src/video-scene.js', 'src/video-client.js', 'src/video-motion.js']

test('the actual browser build produces identical valid bundles from LF and CRLF inputs', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-code-wiki-build-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const sources = await Promise.all(inputs.map(async path => [path,
    (await readFile(new URL('../' + path, import.meta.url), 'utf8')).replace(/\r\n?/g, '\n')]))
  const bundles = []
  for (const [name, newline] of [['lf', '\n'], ['crlf', '\r\n']]) {
    const directory = join(temporary, name)
    await Promise.all(['scripts', 'src'].map(path => mkdir(join(directory, path), { recursive: true })))
    await Promise.all(sources.map(([path, source]) => writeFile(join(directory, path), source.replace(/\n/g, newline))))
    const options = { cwd: directory, timeout: 30_000, windowsHide: true }
    await exec(process.execPath, [join(directory, 'scripts/build.mjs')], options)
    await exec(process.execPath, ['--check', join(directory, 'client.js')], options)
    const bundle = await readFile(join(directory, 'client.js'), 'utf8')
    new Script(bundle, { filename: 'client.js' })
    bundles.push(bundle)
  }
  assert(bundles[0] === bundles[1], 'checkout line endings must not change the browser bundle')
})
