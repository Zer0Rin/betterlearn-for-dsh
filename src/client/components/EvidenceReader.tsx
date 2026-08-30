import { useEffect, useMemo, useRef, useState } from 'react'
import { splitEvidence } from '../evidence-view.js'
import type { EvidenceSpan } from '../types.js'

export interface EvidenceReaderProps {
  text: string
  evidence: EvidenceSpan[]
}

export function EvidenceReader({ text, evidence }: EvidenceReaderProps) {
  const [selectedSeq, setSelectedSeq] = useState(evidence[0]?.seq)
  const [flashing, setFlashing] = useState(false)
  const marker = useRef<HTMLElement>(null)
  const selected = evidence.find(item => item.seq === selectedSeq) ?? evidence[0]
  const segments = useMemo(
    () => selected === undefined ? [{ kind: 'plain' as const, start: 0, end: text.length, text }] : splitEvidence(text, selected),
    [selected, text],
  )

  useEffect(() => {
    if (selected === undefined || marker.current === null) return
    marker.current.scrollIntoView({ block: 'center' })
    setFlashing(true)
    const timer = globalThis.setTimeout(() => setFlashing(false), 900)
    return () => globalThis.clearTimeout(timer)
  }, [selected])

  return (
    <section className="nobei-client__evidence-reader" aria-labelledby="nobei-evidence-title">
      <header>
        <p className="nobei-client__eyebrow">原文证据</p>
        <h3 id="nobei-evidence-title">结论来自这里</h3>
      </header>
      <div className="nobei-client__evidence-cards" aria-label="证据列表">
        {evidence.map((item, index) => (
          <button key={item.seq} type="button" aria-pressed={item.seq === selected?.seq}
            onClick={() => setSelectedSeq(item.seq)}>证据 {index + 1}</button>
        ))}
      </div>
      <p className="nobei-client__source-text" data-testid="nobei-source-text">
        {segments.map(segment => segment.kind === 'evidence' ? (
          <mark key={`${segment.start}:${segment.end}`} ref={marker}
            data-evidence-seq={selected?.seq}
            className={flashing ? 'nobei-client__evidence-flash' : undefined}>
            {segment.text}
          </mark>
        ) : <span key={`${segment.start}:${segment.end}`}>{segment.text}</span>)}
      </p>
    </section>
  )
}
