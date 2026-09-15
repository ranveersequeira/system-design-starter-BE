import { useEffect, useState } from 'react'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import type { Chapter } from '../content/types'
import Md from '../components/Md'
import { Callout, Diagram } from '../components/ui'
import { useProgress, update } from '../lib/store'

export default function Learn() {
  const ch = useOutletContext<Chapter>()
  const { section } = useParams()
  const nav = useNavigate()
  const p = useProgress()
  const idx = Math.min(Math.max(Number(section ?? 0) || 0, 0), ch.sections.length - 1)
  const s = ch.sections[idx]
  const read = p.sectionsRead[String(ch.id)] ?? []
  const [revealed, setRevealed] = useState(false)
  const [guess, setGuess] = useState('')

  useEffect(() => {
    setRevealed(false)
    setGuess('')
    window.scrollTo({ top: 0 })
  }, [idx, ch.id])

  function markRead() {
    update((d) => {
      const arr = d.sectionsRead[String(ch.id)] ?? []
      if (!arr.includes(s.id)) arr.push(s.id)
      d.sectionsRead[String(ch.id)] = arr
    })
  }
  function next() {
    markRead()
    if (idx + 1 < ch.sections.length) nav(`/chapter/${ch.id}/learn/${idx + 1}`)
    else nav(`/chapter/${ch.id}/quiz`)
  }
  const canAdvance = !s.checkpoint || revealed

  return (
    <div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="timeline">
          {ch.sections.map((sec, i) => (
            <Link key={sec.id} to={`/chapter/${ch.id}/learn/${i}`} title={sec.title}>
              <span className={i === idx ? 'current' : read.includes(sec.id) ? 'done' : ''} />
            </Link>
          ))}
        </div>
        <span className="muted small">Page {idx + 1} of {ch.sections.length}</span>
      </div>

      <article className="card">
        <div className="eyebrow">Section {idx + 1}</div>
        <h2>{s.title}</h2>
        <Md>{s.body}</Md>
        {s.diagram && <Diagram text={s.diagram} />}
        {s.mentalModel && (
          <Callout kind="model" title="Mental model">
            <p style={{ margin: 0 }}>{s.mentalModel}</p>
          </Callout>
        )}
        <div className="eyebrow" style={{ marginTop: 16 }}>Key points</div>
        <ul>{s.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>

        {s.checkpoint && (
          <Callout kind="check" title="Pause and predict">
            <p><strong>{s.checkpoint.question}</strong></p>
            {!revealed ? (
              <>
                <textarea rows={3} placeholder="Write your answer (even a rough one) before revealing. Committing to an answer is what makes the correction stick." value={guess} onChange={(e) => setGuess(e.target.value)} />
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setRevealed(true)}>Reveal answer</button>
                  <span className="muted small">Tip: say it out loud if you do not want to type.</span>
                </div>
              </>
            ) : (
              <>
                {guess && (<><div className="eyebrow">Your answer</div><p className="muted">{guess}</p></>)}
                <div className="eyebrow">Model answer</div>
                <Md>{s.checkpoint.answer}</Md>
              </>
            )}
          </Callout>
        )}
      </article>

      <div className="row between" style={{ marginTop: 16 }}>
        <button className="btn" disabled={idx === 0} onClick={() => nav(`/chapter/${ch.id}/learn/${idx - 1}`)}>← Previous</button>
        <div className="row">
          {!read.includes(s.id) && <button className="btn btn-ghost btn-sm" onClick={markRead}>Mark as read</button>}
          <button className="btn btn-primary" disabled={!canAdvance} onClick={next} title={canAdvance ? '' : 'Answer the checkpoint first'}>
            {idx + 1 < ch.sections.length ? 'Next page →' : 'Finish & go to quiz →'}
          </button>
        </div>
      </div>
    </div>
  )
}
