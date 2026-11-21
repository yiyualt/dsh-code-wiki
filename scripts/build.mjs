import { readFile, writeFile } from 'node:fs/promises'

const [client, folderBrowser, styles, videoScene, videoClient, videoMotion, wikiView, walkthroughData, walkthrough] = (await Promise.all([
  readFile(new URL('../src/client.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/folder-browser.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wiki-styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/video-scene.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/video-client.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/video-motion.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wiki-view.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wiki-walkthrough-data.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wiki-walkthrough.js', import.meta.url), 'utf8'),
])).map(text => text.replace(/\r\n?/g, '\n'))
const bundle = `;(() => {\nconst codeWikiStyles = ${JSON.stringify(styles)}\n${folderBrowser}\n${videoMotion.replace(/^export /gm, '')}\n${videoScene.replace(/^import .*\n/gm, '').replace(/^export /gm, '')}\n${videoClient}\n${wikiView.replace(/^export /gm, '')}\n${walkthroughData.replace(/^export /gm, '')}\n${walkthrough.replace(/^export /gm, '')}\n${client}\n})()\n`
await writeFile(new URL('../client.js', import.meta.url), bundle)
