import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { Chapter } from '../content/types'
import Md from '../components/Md'
import { useProgress, update } from '../lib/store'
import { newCardState, review } from '../lib/srs'

export default function Flashcards() {
  const ch = useOutletContext<Chapter>()
  const p = useProgress()
  const [i, setI] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [done, setDone] = useState(false)
  const cards = ch.flashcards
  const c = cards[i]

  function grade(g: 0 | 1 | 2 | 3) {
    update((d) => {
      const key = `${ch.id}:${c.id}`
      d.srs[key] = review(d.srs[key] ?? newCardState(), g)
    })
    setFlipped(false)
    if (i + 1 < cards.length) setI(i + 1)
    else setDone(true)
  }

  if (done) {
    return (
      <div className="card">
        <h2>First pass complete</h2>
        <p className="muted">These cards are now scheduled. They will appear on the Review page when due. Grade honestly: "Again" cards come back in 10 minutes, "Easy" cards in a few days.</p>
        <button className="btn" onClick={() => { setI(0); setDone(false) }}>Go through again</button>
      </div>
    )
  }

  const st = p.srs[`${ch.id}:${c.id}`]
  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">Card {i + 1} of {cards.length}</span>
        <span className="muted small">{st ? `seen ${st.reps}x · interval ${st.interval}d` : 'new card'}</span>
      </div>
      <div className="card flashcard" onClick={() => setFlipped((f) => !f)}>
        <div className="side">{flipped ? 'Answer' : 'Question — click to flip'}</div>
        {flipped ? <Md>{c.back}</Md> : <strong>{c.front}</strong>}
      </div>
      {flipped ? (
        <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
          <button className="btn" style={{ borderColor: 'var(--bad)' }} onClick={() => grade(0)}>Again</button>
          <button className="btn" style={{ borderColor: 'var(--warn)' }} onClick={() => grade(1)}>Hard</button>
          <button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={() => grade(2)}>Good</button>
          <button className="btn" style={{ borderColor: 'var(--ok)' }} onClick={() => grade(3)}>Easy</button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={() => setFlipped(true)}>Show answer</button>
        </div>
      )}
    </div>
  )
}
