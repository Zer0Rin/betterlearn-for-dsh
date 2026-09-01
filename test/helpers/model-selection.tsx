import { useMemo, useSyncExternalStore } from 'react'
import { NobeiWorkspace, type NobeiWorkspaceProps } from '../../src/client/NobeiClientView.js'
import { modelSelectionInjection, type ModelDirectoryResolverPort, type ModelDirectorySnapshot,
  type ModelSelectionInput } from '../../src/client/model-directory-bridge.js'

// Component tests supply the same source-to-hook adapter as a slot renderer.
// The actual DSH renderer is checked separately in browser acceptance.
export function useModelSelectionInput(directories: ModelDirectoryResolverPort, sessionId: string, ordinarySession: boolean): ModelSelectionInput {
  const face = useMemo(() => modelSelectionInjection(directories, sessionId, ordinarySession),
    [directories, sessionId, ordinarySession])
  const modelDirectoryState = useSyncExternalStore(face.hooks.modelDirectory.subscribe,
    face.hooks.modelDirectory.getSnapshot, face.hooks.modelDirectory.getSnapshot)
  return { loadModelSelection: face.loadModelSelection, readModelDirectory: face.readModelDirectory,
    ordinarySession, modelDirectoryState }
}

type DirectoryProps = { modelDirectories: ModelDirectoryResolverPort; ordinarySession: boolean }
export function WorkspaceWithDirectory(props: Omit<NobeiWorkspaceProps, keyof ModelSelectionInput> & DirectoryProps) {
  const { modelDirectories, ordinarySession, ...rest } = props
  const model = useModelSelectionInput(modelDirectories, rest.sessionId, ordinarySession)
  return <NobeiWorkspace {...rest} {...model} />
}
