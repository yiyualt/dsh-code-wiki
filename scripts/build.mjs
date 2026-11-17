import { readFile, writeFile } from 'node:fs/promises'

const [client, folderBrowser, styles] = await Promise.all([
  readFile(new URL('../src/client.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/folder-browser.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wiki-styles.css', import.meta.url), 'utf8'),
])
const bundle = `;(() => {\nconst codeWikiStyles = ${JSON.stringify(styles)}\n${folderBrowser}\n${client}\n})()\n`
await writeFile(new URL('../client.js', import.meta.url), bundle)
