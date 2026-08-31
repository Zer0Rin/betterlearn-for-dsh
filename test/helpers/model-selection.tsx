import { useMemo, useSyncExternalStore } from 'react'
import { NobeiWorkspace, NobeiClientView, type NobeiWorkspaceProps, type NobeiClientViewProps } from '../../src/client/NobeiClientView.js'
import { modelSelectionInjection, type ModelDirectoryResolverPort, type ModelDirectorySnapshot,
  type ModelSelectionInput, type ModelSelectionProps } from '../../src/client/model-directory-bridge.js'

// Component tests supply the same source-to-hook adapter as a slot renderer.
// The actual DSH renderer is checked separately in browser acceptance.
export function bindModelSelection(face: ReturnType<typeof modelSelectionInjection>): ModelSelectionProps {
  const { hooks, ...actions } = face
  return { ...actions, useModelDirectory<T>(selector: (state: ModelDirectorySnapshot | undefined) => T): T {
    return selector(useSyncExternalStore(hooks.modelDirectory.subscribe, hooks.modelDirectory.getSnapshot,
      hooks.modelDirectory.getSnapshot))
  } }
}

export function useModelSelectionProps(directories: ModelDirectoryResolverPort, sessionId: string, ordinarySession: boolean) {
  return useMemo(() => bindModelSelection(modelSelectionInjection(directories, sessionId, ordinarySession)),
    [directories, sessionId, ordinarySession])
}

export function useModelSelectionInput(directories: ModelDirectoryResolverPort, sessionId: string, ordinarySession: boolean): ModelSelectionInput {
  const { useModelDirectory, ...actions } = useModelSelectionProps(directories, sessionId, ordinarySession)
  return { ...actions, modelDirectoryState: useModelDirectory(state => state) }
}

type DirectoryProps = { modelDirectories: ModelDirectoryResolverPort; ordinarySession: boolean }
export function WorkspaceWithDirectory(props: Omit<NobeiWorkspaceProps, keyof ModelSelectionInput> & DirectoryProps) {
  const { modelDirectories, ordinarySession, ...rest } = props
  const model = useModelSelectionInput(modelDirectories, rest.sessionId, ordinarySession)
  return <NobeiWorkspace {...rest} {...model} />
}
export function ViewWithDirectory(props: Omit<NobeiClientViewProps, keyof ModelSelectionProps> & DirectoryProps) {
  const { modelDirectories, ordinarySession, ...rest } = props
  const model = useModelSelectionProps(modelDirectories, rest.sessionId, ordinarySession)
  return <NobeiClientView {...rest} {...model} />
}
