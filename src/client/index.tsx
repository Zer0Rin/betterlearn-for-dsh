import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { NobeiBlankSessionDock, NobeiClientView } from './NobeiClientView.js'
import { modelSelectionInjection } from './model-directory-bridge.js'

export const name = 'nobei-phase1d-client'
export const inject = ['modelDirectories', 'sessions', 'slots'] as const

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'nobei',
    order: 50,
    label: 'Nobei',
    inject: sessionId => modelSelectionInjection(ctx.modelDirectories as never, sessionId,
      ctx.sessions.subagentAddress(sessionId) === undefined),
  }, NobeiClientView))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'nobei-blank-import',
    order: 5,
    inject: sessionId => modelSelectionInjection(ctx.modelDirectories as never, sessionId,
      ctx.sessions.subagentAddress(sessionId) === undefined),
  }, NobeiBlankSessionDock))
}
