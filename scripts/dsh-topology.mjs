import { load as parseYaml } from 'js-yaml'

export const CRITICAL_PROFILE_PACKAGES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workflow',
  '@deepseek-ai/dsh-workflow-worker-thread',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-web-app',
])

export const CLIENT_SEAM_PACKAGES = Object.freeze([
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection',
])

const APPROVED_BUILDS = Object.freeze([
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
])

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export function createWorkspacePolicy(pinset) {
  if (!/^0\.1\.0-rc\.\d+$/.test(pinset?.release ?? '')) throw new TypeError('PINSET_RELEASE_INVALID')
  if (pinset?.packages === null || typeof pinset?.packages !== 'object' || Array.isArray(pinset.packages)) {
    throw new TypeError('PINSET_PACKAGES_INVALID')
  }
  for (const name of CRITICAL_PROFILE_PACKAGES) {
    if (pinset.packages[name] !== pinset.release) throw new Error(`pinset is missing ${name}`)
  }
  const overrides = Object.entries(pinset.packages)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => `  ${quote(name)}: ${quote(version)}`)
  return [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
    'overrides:',
    ...overrides,
    '',
    'allowBuilds:',
    ...APPROVED_BUILDS.map((name) => `  ${quote(name)}: true`),
    '',
  ].join('\n')
}

function coordinate(key) {
  const separator = key.lastIndexOf('@')
  if (separator <= 0) return undefined
  return { name: key.slice(0, separator), version: key.slice(separator + 1) }
}

function directVersion(importer, name, expectedVersion) {
  const entry = importer?.dependencies?.[name]
  const specifier = typeof entry === 'object' && entry !== null ? entry.specifier : entry
  const version = typeof entry === 'object' && entry !== null ? entry.version : entry
  if (specifier !== expectedVersion || typeof version !== 'string' || !version.startsWith(expectedVersion)) {
    throw new Error(`profile must directly install ${name}@${expectedVersion}`)
  }
  return version
}

export function assertProfileTopology(lockText, expectedVersion) {
  const lock = parseYaml(lockText)
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) throw new TypeError('LOCK_INVALID')
  const wrong = []
  for (const key of Object.keys(lock.packages ?? {})) {
    const parsed = coordinate(key)
    if (parsed?.name.startsWith('@deepseek-ai/dsh-') && parsed.version !== expectedVersion) {
      wrong.push(`${parsed.name}@${parsed.version}`)
    }
  }
  if (wrong.length) throw new Error(`unexpected DSH release: ${wrong.toSorted().join(', ')}`)

  const importer = lock.importers?.['.']
  const directReferences = Object.fromEntries(
    CRITICAL_PROFILE_PACKAGES.map((name) => [name, directVersion(importer, name, expectedVersion)]),
  )
  const snapshotKeys = Object.keys(lock.snapshots ?? {})
  const duplicateCriticalContexts = []
  for (const name of CRITICAL_PROFILE_PACKAGES) {
    const matches = snapshotKeys.filter((key) => key.startsWith(`${name}@${expectedVersion}`))
    if (matches.length !== 1) duplicateCriticalContexts.push({ name, contexts: matches })
  }
  if (duplicateCriticalContexts.length) {
    throw new Error(`duplicate critical peer context: ${duplicateCriticalContexts.map((entry) => entry.name).join(', ')}`)
  }
  return {
    expectedVersion,
    criticalCount: CRITICAL_PROFILE_PACKAGES.length,
    duplicateCriticalContexts,
    directReferences,
  }
}
