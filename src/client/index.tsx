import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { mountFloatingWorkbench } from './floating-workbench.js'

export const name = 'nobei-phase1d-client'
export const inject = ['modelDirectories', 'sessions'] as const

export function apply(ctx: Context): () => void {
  return mountFloatingWorkbench(ctx)
}
