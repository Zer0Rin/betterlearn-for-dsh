import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
})
const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
  id: "@nobei/dsh-phase1",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
${body}
    return module.exports;
  }
});\n`

await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', wrapped, 'utf8')
