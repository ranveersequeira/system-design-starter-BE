import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { Chapter, FeynmanPrompt } from '../content/types'
import Md from '../components/Md'
import { Callout } from '../components/ui'
import { useProgress, update } from '../lib/store'

function PromptCard({ ch, f }: { ch: Chapter; f: FeynmanPrompt }) {
  const p = useProgress()
  const key = `${ch.id}:${f.id}`
  const saved = p.feynman[key]
  const [text, setText] = useState(saved?.text ?? '')
  const [revealed, setRevealed] = useState(!!saved)
  const [ticked, setTicked] = useState<number[]>(saved?.ticked ?? [])
  const [rating, setRating] = useState<number>(saved?.rating ?? 0)
  const [editing, setEditing] = useState(!saved)

  function save(r: number) {
    setRating(r)
    update((d) => { d.feynman[key] = { text, ticked, rating: r as 1 | 2 | 3 | 4 | 5, date: new Date().toISOString() } })
  }

  return (
    <div className="card">
      <div className="row between">
        <div className="eyebrow">{f.concept}</div>
        {saved && <span className={`badge ${saved.rating >= 4 ? 'badge-ok' : 'badge-warn'}`}>self-rated {saved.rating}/5</span>}
      </div>
      <h3>{f.prompt}</h3>
      {editing ? (
        <>
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Explain it simply. No jargon unless you define it. If you get stuck, that is exactly the gap to go back and fill." />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" disabled={text.trim().length < 40} onClick={() => { setEditing(false); setRevealed(true) }}>Compare with model explanation</button>
            <span className="muted small">Write at least a few sentences first.</span>
          </div>
        </>
      ) : (
        <>
          <div className="eyebrow">Your explanation</div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
        </>
      )}
      {revealed && !editing && (
        <>
          <Callout kind="model" title="Model explanation"><Md>{f.modelExplanation}</Md></Callout>
          <div className="eyebrow">Did your explanation mention...</div>
          <div className="checklist">
            {f.mustMention.map((m, i) => (
              <label key={i}>
                <input type="checkbox" checked={ticked.includes(i)} onChange={() => setTicked((t) => t.includes(i) ? t.filter((x) => x !== i) : [...t, i])} />
                <span>{m}</span>
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="small muted">How well do you understand this now?</span>
            <div className="rating">
              {[1, 2, 3, 4, 5].map((r) => (
                <button key={r} className={`btn btn-sm ${rating === r ? 'btn-primary' : ''}`} onClick={() => save(r)}>{r}</button>
              ))}
            </div>
          </div>
          {rating > 0 && rating < 4 && <p className="small muted" style={{ marginTop: 8 }}>Below 4: re-read the relevant section, then rewrite this explanation tomorrow.</p>}
        </>
      )}
    </div>
  )
}

export default function Feynman() {
  const ch = useOutletContext<Chapter>()
  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Feynman technique</h2>
        <p className="muted" style={{ margin: 0 }}>Explain each idea as if to a smart junior who has never heard it. Then compare against the model explanation and tick the must-mention points. Anything you could not say simply is something you do not yet understand.</p>
      </div>
      <div className="stack">
        {ch.feynman.map((f) => <PromptCard key={f.id} ch={ch} f={f} />)}
      </div>
    </div>
  )
}
