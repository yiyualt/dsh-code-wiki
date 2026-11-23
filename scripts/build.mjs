import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

await build({
  entryPoints: [fileURLToPath(new URL('../src/client.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../client.js', import.meta.url)),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'text' },
  legalComments: 'eof',
})
