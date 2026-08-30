/** Compatibility lifecycle helper retained for the completed Phase 1A spike tests. */
export class OwnedSpikeWork {
  readonly #abort = new AbortController()
  readonly #active = new Set<Promise<unknown>>()
  #disposing = false

  get signal(): AbortSignal {
    return this.#abort.signal
  }

  track<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#disposing) return Promise.reject(new Error('SPIKE_PLUGIN_DISPOSING'))
    const promise = Promise.resolve(task(this.signal))
    this.#active.add(promise)
    void promise.finally(() => this.#active.delete(promise)).catch(() => undefined)
    return promise
  }

  async dispose(): Promise<void> {
    if (!this.#disposing) {
      this.#disposing = true
      this.#abort.abort()
    }
    await Promise.allSettled([...this.#active])
  }
}
