import { readFile, writeFile } from 'node:fs/promises'

const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const markdown = await readFile(new URL('../src/example.md', import.meta.url), 'utf8')
const bundle = client.replace("'__EXAMPLE_MARKDOWN__'", () => JSON.stringify(markdown))
await writeFile(new URL('../client.js', import.meta.url), bundle)
