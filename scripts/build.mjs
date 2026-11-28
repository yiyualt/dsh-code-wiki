import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectDirectory = fileURLToPath(new URL('../', import.meta.url))
const clientBundle = 'client.js'
const licenseFile = /^(?:licen[cs]e|copying)(?:[.-].+)?$/i
const noticeFile = /^notice(?:[.-].+)?$/i

function dependencyDirectory(input) {
  const segments = input.split('/')
  const start = segments.lastIndexOf('node_modules') + 1
  if (start === 0) return null

  const nameLength = segments[start].startsWith('@') ? 2 : 1
  return segments.slice(0, start + nameLength).join('/')
}

async function readDependencyNotices(directory) {
  const packageDirectory = resolve(projectDirectory, directory)
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  const packageLabel = `${manifest.name}@${manifest.version}`
  const files = await readdir(packageDirectory)
  if (!files.some((file) => licenseFile.test(file))) {
    throw new Error(`No license file found for bundled dependency ${packageLabel}`)
  }

  const notices = files.filter((file) => licenseFile.test(file) || noticeFile.test(file)).sort()
  return Promise.all(notices.map(async (file) => {
    const text = await readFile(join(packageDirectory, file), 'utf8')
    return `${packageLabel} (${file})\n\n${text}`
  }))
}

const { metafile, outputFiles: [output] } = await build({
  absWorkingDir: projectDirectory,
  entryPoints: ['src/client.js'],
  outfile: clientBundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'text' },
  legalComments: 'eof',
  metafile: true,
  write: false,
})

const dependencies = new Set(Object.entries(metafile.outputs[clientBundle].inputs)
  .filter(([, { bytesInOutput }]) => bytesInOutput > 0)
  .map(([input]) => dependencyDirectory(input))
  .filter(Boolean))
const notices = (await Promise.all([...dependencies].sort().map(readDependencyNotices))).flat()
const noticeComment = notices.length
  ? `\n/*!\nThird-party license notices\n\n${notices.join('\n').replaceAll('*/', '* /')}\n*/\n`
  : ''
await writeFile(output.path, output.text + noticeComment)
