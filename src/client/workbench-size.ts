export type WorkbenchScreen = 'empty' | 'import' | 'processing' | 'review' | 'result'

export interface WorkbenchSize {
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export type ResizeAxis = 'width' | 'height' | 'both'

export const WORKBENCH_SIZE_STORAGE_KEY = 'betterlearn:floating-size:v1'

const DEFAULTS: Record<WorkbenchScreen, WorkbenchSize> = {
  empty: { width: 420, height: 420 },
  import: { width: 500, height: 720 },
  processing: { width: 460, height: 620 },
  review: { width: 900, height: Number.POSITIVE_INFINITY },
  result: { width: 460, height: 720 },
}

function finiteSize(value: unknown): value is WorkbenchSize {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return Object.keys(entry).sort().join(',') === 'height,width'
    && typeof entry.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
    && typeof entry.height === 'number' && Number.isFinite(entry.height) && entry.height > 0
}

function readStoredSizes(storage: Storage): Partial<Record<WorkbenchScreen, WorkbenchSize>> {
  try {
    const raw = storage.getItem(WORKBENCH_SIZE_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Partial<Record<WorkbenchScreen, WorkbenchSize>> = {}
    for (const screen of Object.keys(DEFAULTS) as WorkbenchScreen[]) {
      const entry = (parsed as Record<string, unknown>)[screen]
      if (finiteSize(entry)) result[screen] = { width: entry.width, height: entry.height }
    }
    return result
  } catch {
    return {}
  }
}

export function clampWorkbenchSize(size: WorkbenchSize, viewport: ViewportSize): WorkbenchSize {
  const maxWidth = Math.max(0, Math.min(1080, viewport.width - 32))
  const maxHeight = Math.max(0, viewport.height - 32)
  return {
    width: Math.min(maxWidth, Math.max(Math.min(300, maxWidth), Math.round(size.width))),
    height: Math.min(maxHeight, Math.max(Math.min(340, maxHeight), Math.round(size.height))),
  }
}

export function defaultWorkbenchSize(screen: WorkbenchScreen, viewport: ViewportSize): WorkbenchSize {
  return clampWorkbenchSize(DEFAULTS[screen], viewport)
}

export function resizeFromPointer(
  start: WorkbenchSize,
  axis: ResizeAxis,
  deltaX: number,
  deltaY: number,
  viewport: ViewportSize,
): WorkbenchSize {
  return clampWorkbenchSize({
    width: axis === 'height' ? start.width : start.width - deltaX,
    height: axis === 'width' ? start.height : start.height + deltaY,
  }, viewport)
}

export function readWorkbenchSize(storage: Storage, screen: WorkbenchScreen): WorkbenchSize | undefined {
  return readStoredSizes(storage)[screen]
}

export function writeWorkbenchSize(storage: Storage, screen: WorkbenchScreen, size: WorkbenchSize): void {
  try {
    storage.setItem(WORKBENCH_SIZE_STORAGE_KEY, JSON.stringify({
      ...readStoredSizes(storage),
      [screen]: { width: Math.round(size.width), height: Math.round(size.height) },
    }))
  } catch {
    // A blocked localStorage must not break the workbench resize interaction.
  }
}
