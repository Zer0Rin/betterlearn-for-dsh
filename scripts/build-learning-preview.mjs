import { build } from 'esbuild'
import { copyFile, mkdir, rm } from 'node:fs/promises'

const outputDirectory = 'dist/learning-preview'
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await copyFile('preview/learning-space.html', `${outputDirectory}/index.html`)

await build({
  entryPoints: ['preview/learning-space.tsx'],
  outfile: 'dist/learning-preview/app.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})
