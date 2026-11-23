import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dagreManifest = createRequire(import.meta.url).resolve('@dagrejs/dagre/package.json')
const graphlibManifest = createRequire(dagreManifest).resolve('@dagrejs/graphlib/package.json')
const graphLicenses = await Promise.all([dagreManifest, graphlibManifest].map(manifest =>
  readFile(join(dirname(manifest), 'LICENSE'), 'utf8')))

await build({
  entryPoints: [fileURLToPath(new URL('../src/client.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../client.js', import.meta.url)),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'text' },
  legalComments: 'eof',
  footer: { js: `/* @dagrejs/dagre and @dagrejs/graphlib\n${[...new Set(graphLicenses)].join('\n')}\n*/` },
})
