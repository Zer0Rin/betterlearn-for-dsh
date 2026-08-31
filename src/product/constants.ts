export const CORE_PROTOCOL_VERSION = 3 as const
export const CORE_VERSION = 'phase1e' as const
export const CORE_DATABASE_KIND = 'sqlite' as const
export const CORE_DATA_ROOT_KIND = 'isolated-phase1' as const
export const CORE_CAPABILITIES = [
  'l1-text-extraction',
  'atomic-generation-commands',
  'model-selection-snapshot',
] as const

export const CORE_HANDSHAKE_TIMEOUT_MS = 5_000
export const CORE_READ_RPC_TIMEOUT_MS = 3_000
export const CORE_WRITE_RPC_TIMEOUT_MS = 10_000
export const GENERATION_FINALIZE_RPC_TIMEOUT_MS = 10_000
export const CORE_RPC_MAX_LINE_BYTES = 32 * 1024 * 1024

export const MAX_ACTIVE_GENERATIONS = 1
// Reasoning and structured output share this budget. High reasoning exhausted
// the former 8,192-token cap before producing any answer in a real L2 run.
export const GENERATION_MAX_TOKENS = 32_768
export const GENERATION_TIMEOUT_MS = 120_000
export const WORKFLOW_DISPOSE_GRACE_MS = 5_000
export const CORE_STABLE_RESET_MS = 60_000
export const CORE_MAX_AUTOMATIC_RESTARTS = 2
export const PRODUCT_BODY_LIMIT_BYTES = 8 * 1024 * 1024
export const GENERATION_TOOL_DENIAL = 'NOBEI_GENERATION_TOOL_DENIED' as const
