import { readFile, writeFile } from 'node:fs/promises'
import { mockChapters } from '../src/mock-chapters.js'

const [client, styles] = (await Promise.all([
  readFile(new URL('../src/client.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wiki.css', import.meta.url), 'utf8'),
])).map(content => content.replace(/\r\n?/g, '\n'))

const bundle = `;(() => {
const mockChapters = ${JSON.stringify(mockChapters)}
const wikiStyles = ${JSON.stringify(styles)}
${client}
})()\n`

await writeFile(new URL('../client.js', import.meta.url), bundle)
