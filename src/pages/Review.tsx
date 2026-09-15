import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CHAPTERS } from '../content'
import Md from '../components/Md'
import { Empty } from '../components/ui'
import { useProgress, update } from '../lib/store'
import { isDue, newCardState, review } from '../lib/srs'

export default function Review() {
  const p = useProgress()
  const [session, setSession] = useState<{ key: string; chId: number; chTitle: string; front: string; back: string }[] | null>(null)
  const [i, setI] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [onlySeen, setOnlySeen] = useState(true)

  const due = useMemo(() => {
    const out: { key: string; chId: number; chTitle: string; front: string; back: string; isNew: boolean }[] = []
    for (const ch of CHAPTERS) for (const c of ch.flashcards) {
      const key = `${ch.id}:${c.id}`
      const st = p.srs[key]
      if (isDue(st)) out.push({ key, chId: ch.id, chTitle: ch.title, front: c.front, back: c.back, isNew: !st })
    }
    return out
  }, [p.srs])
  const seenDue = due.filter((d) => !d.isNew)
  const newCards = due.filter((d) => d.isNew)

  if (!session) {
    return (
      <div>
        <h1>Daily review</h1>
        <p className="muted">Spaced repetition across every chapter. Cards you have graded come back when they are due; new cards are those you have not seen yet.</p>
        <div className="grid grid-3">
          <div className="card"><div className="eyebrow">Due (seen before)</div><div className="stat">{seenDue.length}</div></div>
          <div className="card"><div className="eyebrow">New cards</div><div className="stat">{newCards.length}</div></div>
          <div className="card"><div className="eyebrow">Total scheduled</div><div className="stat">{Object.keys(p.srs).length}</div></div>
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <label className="row"><input type="checkbox" checked={onlySeen} onChange={(e) => setOnlySeen(e.target.checked)} /> Only cards I have seen before (recommended: learn new cards inside each chapter first)</label>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" disabled={(onlySeen ? seenDue : due).length === 0} onClick={() => {
              const pool = (onlySeen ? seenDue : due).slice().sort(() => Math.random() - 0.5).slice(0, 40)
              setSession(pool); setI(0); setFlipped(false)
            }}>Start session ({Math.min(40, (onlySeen ? seenDue : due).length)} cards)</button>
          </div>
        </div>
        {seenDue.length === 0 && <Empty>Nothing due right now. Go learn a new chapter or run a <Link to="/crash">quick revision</Link> revision.</Empty>}
      </div>
    )
  }

  if (i >= session.length) {
    return (
      <div className="card">
        <h2>Session complete</h2>
        <p className="muted">{session.length} cards reviewed. Come back tomorrow.</p>
        <button className="btn" onClick={() => setSession(null)}>Back</button>
      </div>
    )
  }

  const c = session[i]
  function grade(g: 0 | 1 | 2 | 3) {
    update((d) => { d.srs[c.key] = review(d.srs[c.key] ?? newCardState(), g) })
    setFlipped(false)
    setI(i + 1)
  }
  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">{i + 1} / {session.length}</span>
        <Link className="small" to={`/chapter/${c.chId}`}>Ch {c.chId}: {c.chTitle}</Link>
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
