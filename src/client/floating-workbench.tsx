import type { Context } from '@deepseek-ai/cordis'
import { createRoot } from 'react-dom/client'
import { ensureClientStyles } from './styles.js'

export function BetterLearnFloatingApp() {
  return <button data-testid="betterlearn-launcher" type="button" aria-expanded="false">BetterLearn</button>
}

export function mountFloatingWorkbench(ctx: Context): () => void {
  ensureClientStyles(document)
  const container = document.createElement('div')
  container.className = 'betterlearn-floating-root'
  container.setAttribute('data-betterlearn-floating-root', '')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<BetterLearnFloatingApp />)
  return () => {
    root.unmount()
    container.remove()
  }
}
