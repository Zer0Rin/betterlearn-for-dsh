import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import { Ajv } from 'ajv'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SPIKE_MODEL, SPIKE_PROVIDER, STRUCTURED_OUTPUT_TOOL } from './constants.js'
import type { ModelCallAudit } from './model-call-audit.js'

const WORKFLOW_SCRIPT = 'const value = await agent(args.prompt, { schema: args.schema })\nreturn value'

export interface ProviderCallSummary {
  index: 1 | 2 | 3
  provider: typeof SPIKE_PROVIDER
  model: typeof SPIKE_MODEL
  toolCount: 1
  toolNames: [typeof STRUCTURED_OUTPUT_TOOL]
  workflowStopReason: 'completed'
  agentsStarted: 1
  structuredPresent: true
  schemaValid: true
  semanticValid: true
  structuredSha256: string
  candidateCount: number
  evidenceCount: number
}

interface ProviderProbeOptions {
  ownedSpikeRoot: string
  fixture: string
  schema: Record<string, unknown>
  promptTemplate: string
  audit: ModelCallAudit
  signal?: AbortSignal
}

export class ProviderProbeError extends Error {
  readonly code = 'WORKFLOW_PROBE_FAILED'

  constructor(
    readonly actualCalls: number,
    readonly failureStage: 'WORKFLOW_RUNTIME' | 'OUTCOME_VALIDATION' | 'PARENT_DISPOSE',
    cause: unknown,
  ) {
    super('WORKFLOW_PROBE_FAILED', { cause })
    this.name = 'ProviderProbeError'
  }
}

interface Evidence {
  quote: string
  prefix: string
  suffix: string
}

interface Candidate {
  type: string
  title: string
  statement: string
  evidence: Evidence[]
}

interface StructuredCandidates {
  schemaVersion: number
  candidates: Candidate[]
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function semanticCounts(value: unknown, fixture: string): { candidateCount: number; evidenceCount: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STRUCTURED_VALUE_INVALID')
  }
  const structured = value as StructuredCandidates
  if (!Array.isArray(structured.candidates) || structured.candidates.length < 1) {
    throw new Error('STRUCTURED_SEMANTICS_INVALID')
  }
  let evidenceCount = 0
  let exactQuoteFound = false
  for (const candidate of structured.candidates) {
    if (
      candidate?.type !== 'concept'
      || !isNonEmpty(candidate.title)
      || !isNonEmpty(candidate.statement)
      || !Array.isArray(candidate.evidence)
      || candidate.evidence.length < 1
      || candidate.evidence.length > 3
    ) throw new Error('STRUCTURED_SEMANTICS_INVALID')
    evidenceCount += candidate.evidence.length
    for (const evidence of candidate.evidence) {
      if (
        !isNonEmpty(evidence?.quote)
        || !isNonEmpty(evidence?.prefix)
        || !isNonEmpty(evidence?.suffix)
      ) throw new Error('STRUCTURED_SEMANTICS_INVALID')
      if (fixture.includes(evidence.quote)) exactQuoteFound = true
    }
  }
  if (!exactQuoteFound) throw new Error('STRUCTURED_EVIDENCE_NOT_EXACT')
  return { candidateCount: structured.candidates.length, evidenceCount }
}

function assertWorkflowOutcome(outcome: WorkflowResult): void {
  if (outcome.stopReason !== 'completed' || outcome.agentsStarted !== 1 || outcome.value === undefined) {
    throw new Error('WORKFLOW_OUTCOME_INVALID')
  }
}

export async function runProviderProbe(
  ctx: Context,
  options: ProviderProbeOptions,
): Promise<ProviderCallSummary[]> {
  if (!options.promptTemplate.includes('{{SOURCE}}')) throw new Error('PROMPT_TEMPLATE_INVALID')
  const prompt = options.promptTemplate.replace('{{SOURCE}}', options.fixture)
  const ajv = new Ajv({ allErrors: true, strict: true })
  const validate = ajv.compile(options.schema)
  const summaries: ProviderCallSummary[] = []
  const restriction: ToolRestriction = { allow: [] }
  let liftRestriction: (() => void) | undefined
  let parent: Awaited<ReturnType<Context['agents']['create']>> | undefined
  let primaryError: ProviderProbeError | undefined

  try {
    parent = await ctx.agents.create({
      sessionId: SessionId(`nobei-phase1a-parent-${randomUUID()}`),
      meta: { cwd: options.ownedSpikeRoot },
      agentOptions: {
        provider: SPIKE_PROVIDER,
        model: SPIKE_MODEL,
        maxTokens: 2_048,
      },
      signal: options.signal,
    })
    liftRestriction = parent.agent.ctx.tools.restrict(restriction)

    for (let callIndex = 1; callIndex <= 3; callIndex += 1) {
      const auditBefore = options.audit.records.length
      const run = ctx.workflowEngine.start({
        script: WORKFLOW_SCRIPT,
        meta: {
          name: 'nobei-phase1a-candidate-probe',
          description: 'Verify one structured child-agent call through the public workflow seam.',
        },
        args: { prompt, schema: options.schema },
        parent: parent.agent,
        subagentProvider: 'spawn',
        maxTotalAgents: 1,
        signal: options.signal,
      })
      let outcome: WorkflowResult
      try {
        outcome = await run.result
      } finally {
        await run.dispose()
      }
      try {
        assertWorkflowOutcome(outcome)
        if (!validate(outcome.value)) throw new Error('STRUCTURED_SCHEMA_INVALID')
        const counts = semanticCounts(outcome.value, options.fixture)
        const auditAfter = options.audit.records
        if (auditAfter.length !== auditBefore + 1) throw new Error('LLM_CALL_COUNT_MISMATCH')
        const auditRecord = auditAfter[auditBefore]
        summaries.push({
          index: callIndex as 1 | 2 | 3,
          provider: SPIKE_PROVIDER,
          model: SPIKE_MODEL,
          toolCount: auditRecord.toolCount,
          toolNames: auditRecord.toolNames,
          workflowStopReason: 'completed',
          agentsStarted: 1,
          structuredPresent: true,
          schemaValid: true,
          semanticValid: true,
          structuredSha256: createHash('sha256')
            .update(JSON.stringify(outcome.value), 'utf8')
            .digest('hex'),
          ...counts,
        })
      } catch (error) {
        throw new ProviderProbeError(options.audit.records.length, 'OUTCOME_VALIDATION', error)
      }
    }
  } catch (error) {
    primaryError = error instanceof ProviderProbeError
      ? error
      : new ProviderProbeError(options.audit.records.length, 'WORKFLOW_RUNTIME', error)
  }

  let cleanupError: unknown
  try {
    if (parent) await parent.dispose()
  } catch (error) {
    cleanupError = error
  }
  try {
    liftRestriction?.()
  } catch (error) {
    cleanupError ??= error
  }
  if (primaryError) throw primaryError
  if (cleanupError) throw new ProviderProbeError(options.audit.records.length, 'PARENT_DISPOSE', cleanupError)
  return summaries
}
