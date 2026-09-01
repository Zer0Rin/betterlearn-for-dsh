import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('standalone learning preview', () => {
  test('builds the production learning components into a browser preview', async () => {
    const [packageText, entry, html, buildScript] = await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('preview/learning-space.tsx', 'utf8'),
      readFile('preview/learning-space.html', 'utf8'),
      readFile('scripts/build-learning-preview.mjs', 'utf8'),
    ])
    const packageJson = JSON.parse(packageText) as { scripts: Record<string, string> }

    expect(packageJson.scripts['preview:learning:build'])
      .toBe('node scripts/build-learning-preview.mjs')
    expect(entry).toContain("from '../src/client/components/LearningSpace.js'")
    expect(entry).toContain("from '../src/client/components/ResultSummary.js'")
    expect(entry).toContain("from '../src/client/components/LearningLibrary.js'")
    expect(entry).toContain('createLearningPreviewCourse')
    expect(entry).toContain("useState<'home' | 'knowledge' | 'library'>('home')")
    expect(html).toContain('<div id="root"></div>')
    expect(buildScript).toContain("outfile: 'dist/learning-preview/app.js'")
  })
})
