/** Ephemeral Host progress; never a persisted RunSnapshot or billing record. */
export interface GenerationProgress {
  phase: 'planning' | 'extracting' | 'validating'
  completedBatches: number
  totalBatches: number | null
  startedAt: number
  lastResponseAt: number | null
}
