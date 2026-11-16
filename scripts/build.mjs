import { readFile, writeFile } from 'node:fs/promises'

const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const folderBrowser = await readFile(new URL('../src/folder-browser.js', import.meta.url), 'utf8')
const bundle = `;(() => {\n${folderBrowser}\n${client}\n})()\n`
await writeFile(new URL('../client.js', import.meta.url), bundle)
