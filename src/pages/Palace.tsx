import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { Chapter } from '../content/types'
import { Callout } from '../components/ui'
import { useProgress, update } from '../lib/store'

export default function Palace() {
  const ch = useOutletContext<Chapter>()
  const p = useProgress()
  const [mode, setMode] = useState<'read' | 'recall'>('read')
  const [revealed, setRevealed] = useState<number[]>([])
  const custom = p.palaces[String(ch.id)] ?? ''
  const walks = p.palaceWalks[String(ch.id)] ?? 0
  const stops = ch.memoryPalace.stops

  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Memory palace</h2>
          <span className="badge">walked {walks}x</span>
        </div>
        <p className="muted">{ch.memoryPalace.setting}</p>
        <p className="small muted" style={{ margin: 0 }}>How to use: read the walk once, picturing each image as vividly and absurdly as you can. Then switch to <strong>Recall</strong>, close your eyes, walk the route and name the concept at each stop before revealing it.</p>
        <div className="row" style={{ marginTop: 10 }}>
          <button className={`btn btn-sm ${mode === 'read' ? 'btn-primary' : ''}`} onClick={() => setMode('read')}>Read the walk</button>
          <button className={`btn btn-sm ${mode === 'recall' ? 'btn-primary' : ''}`} onClick={() => { setMode('recall'); setRevealed([]) }}>Recall mode</button>
        </div>
      </div>

      <div className="card">
        {stops.map((s, i) => {
          const show = mode === 'read' || revealed.includes(i)
          return (
            <div className="palace-stop" key={i}>
              <div className="palace-num">{i + 1}</div>
              <div>
                <div className="eyebrow">{s.locus}</div>
                {show ? (
                  <>
                    <strong>{s.concept}</strong>
                    <p className="muted" style={{ margin: '4px 0 0' }}>{s.image}</p>
                  </>
                ) : (
                  <button className="btn btn-sm" onClick={() => setRevealed((r) => [...r, i])}>What is anchored here?</button>
                )}
              </div>
            </div>
          )
        })}
        {mode === 'recall' && revealed.length === stops.length && (
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn btn-primary" onClick={() => update((d) => { d.palaceWalks[String(ch.id)] = (d.palaceWalks[String(ch.id)] ?? 0) + 1 })}>Log this walk</button>
            <span className="muted small">Walk it again tomorrow, then in three days, then weekly.</span>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Your own palace (optional)</h3>
        <Callout kind="model" title="Why build your own">
          <p style={{ margin: 0 }}>Images you invent are remembered far better than images you read. Pick a place you know intimately (your home, commute, office) and anchor the same concepts to spots along a fixed route.</p>
        </Callout>
        <textarea rows={8} value={custom} placeholder={'1. Front door -> ...\n2. Hallway -> ...'} onChange={(e) => update((d) => { d.palaces[String(ch.id)] = e.target.value })} />
      </div>
    </div>
  )
}
