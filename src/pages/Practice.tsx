import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { Chapter } from '../content/types'
import Md from '../components/Md'
import { Callout } from '../components/ui'
import { useProgress, update } from '../lib/store'

export default function Practice() {
  const ch = useOutletContext<Chapter>()
  const p = useProgress()
  const dp = ch.designPractice
  const [revealed, setRevealed] = useState<number[]>([])
  if (!dp) return <div className="card muted">No design practice for this chapter.</div>
  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Design practice</h2>
        <p><strong>{dp.problem}</strong></p>
        <p className="muted small" style={{ margin: 0 }}>Work each step as you would in an interview: write your answer first, then reveal the reference and note the differences. Your answers are saved.</p>
      </div>
      <div className="stack">
        {dp.steps.map((s, i) => {
          const key = `${ch.id}:${i}`
          const mine = p.designAnswers[key] ?? ''
          const open = revealed.includes(i)
          return (
            <div className="card" key={i}>
              <div className="eyebrow">Step {i + 1}</div>
              <h3>{s.title}</h3>
              <p className="muted">{s.prompt}</p>
              <textarea rows={6} value={mine} placeholder="Your answer..." onChange={(e) => update((d) => { d.designAnswers[key] = e.target.value })} />
              <div className="row" style={{ marginTop: 8 }}>
                {!open ? (
                  <button className="btn btn-sm btn-primary" disabled={mine.trim().length < 20} onClick={() => setRevealed((r) => [...r, i])}>Reveal reference</button>
                ) : (
                  <button className="btn btn-sm" onClick={() => setRevealed((r) => r.filter((x) => x !== i))}>Hide reference</button>
                )}
                {mine.trim().length < 20 && !open && <span className="muted small">Write your attempt first (at least a couple of lines).</span>}
              </div>
              {open && <Callout kind="model" title="Reference"><Md>{s.reference}</Md></Callout>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
