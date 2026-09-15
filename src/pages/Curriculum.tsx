import { Link } from 'react-router-dom'
import { CHAPTERS } from '../content'
import { MODULES } from '../content/modules'
import { useProgress } from '../lib/store'
import { chapterMastery } from '../lib/mastery'
import { ProgressBar } from '../components/ui'

export default function Curriculum() {
  const p = useProgress()
  return (
    <div>
      <h1>Curriculum</h1>
      <p className="muted">35 chapters across 7 modules. Work top to bottom; each chapter builds on the last.</p>
      {MODULES.map((m) => {
        const items = CHAPTERS.filter((c) => c.module === m.id)
        return (
          <section key={m.id} style={{ marginTop: 26 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="module-dot" style={{ background: m.color }} />
              <h2 style={{ margin: 0 }}>{m.title}</h2>
              <span className="muted small">{m.tagline}</span>
            </div>
            {items.length === 0 && <div className="card muted small">Content for this module is not loaded yet.</div>}
            <div className="grid grid-2">
              {items.map((ch) => {
                const ms = chapterMastery(ch, p)
                return (
                  <Link key={ch.id} to={`/chapter/${ch.id}`} className="card chapter-card">
                    <div className="row between">
                      <span className="eyebrow">Chapter {String(ch.id).padStart(2, '0')}</span>
                      <span className="muted small">{ch.estimatedMinutes} min</span>
                    </div>
                    <h3 style={{ margin: '4px 0 6px' }}>{ch.title}</h3>
                    <p className="muted small" style={{ marginBottom: 10 }}>{ch.summary}</p>
                    <ProgressBar value={ms.overall} color={m.color} />
                    <div className="row between small muted" style={{ marginTop: 6 }}>
                      <span>{ms.overall}% mastery</span>
                      <span>{ms.dueCards} cards due</span>
                    </div>
                  </Link>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
