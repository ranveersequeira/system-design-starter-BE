import { Link } from 'react-router-dom'
import { CHAPTERS } from '../content'
import { MODULES } from '../content/modules'
import { useProgress, streak } from '../lib/store'
import { chapterMastery } from '../lib/mastery'
import { ProgressBar } from '../components/ui'

export default function Dashboard() {
  const p = useProgress()
  const masteries = CHAPTERS.map((ch) => ({ ch, m: chapterMastery(ch, p) }))
  const overall = masteries.length ? Math.round(masteries.reduce((a, x) => a + x.m.overall, 0) / masteries.length) : 0
  const due = masteries.reduce((a, x) => a + x.m.dueCards, 0)
  const next = masteries.find((x) => x.m.overall < 70) ?? masteries[0]
  const weak = masteries
    .filter((x) => (p.quizAttempts[String(x.ch.id)]?.length ?? 0) > 0)
    .sort((a, b) => a.m.quiz - b.m.quiz)
    .slice(0, 3)
  const totalWrong = Object.values(p.quizAttempts).reduce((a, arr) => a + (arr.at(-1)?.wrongIds.length ?? 0), 0)

  return (
    <div>
      <div className="hero">
        <div className="eyebrow">Welcome back</div>
        <h1>Build a deep mental model of system design</h1>
        <p className="muted">
          Learn page by page, predict before you reveal, quiz yourself, explain it Feynman-style, walk the memory palace, and review on schedule.
        </p>
        <div className="row">
          {next && (
            <Link className="btn btn-primary" to={`/chapter/${next.ch.id}`}>
              Continue: {String(next.ch.id).padStart(2, '0')} {next.ch.title}
            </Link>
          )}
          <Link className="btn" to="/review">Review {due} due cards</Link>
          <Link className="btn" to="/crash">Quick revision</Link>
        </div>
      </div>

      <div className="grid grid-3">
        <div className="card"><div className="eyebrow">Overall mastery</div><div className="stat">{overall}%</div><ProgressBar value={overall} /></div>
        <div className="card"><div className="eyebrow">Day streak</div><div className="stat">{streak(p.activeDays)}</div><div className="muted small">Study a little every day</div></div>
        <div className="card"><div className="eyebrow">Chapters loaded</div><div className="stat">{CHAPTERS.length}<span className="muted" style={{ fontSize: '1rem' }}>/35</span></div><div className="muted small">{p.completed.length} marked complete</div></div>
        <div className="card"><div className="eyebrow">Cards due</div><div className="stat">{due}</div><div className="muted small">Spaced repetition queue</div></div>
        <div className="card"><div className="eyebrow">Open mistakes</div><div className="stat">{totalWrong}</div><div className="muted small"><Link to="/mistakes">Review them</Link></div></div>
      </div>

      <h2 style={{ marginTop: 28 }}>Progress by module</h2>
      <div className="grid grid-2">
        {MODULES.map((m) => {
          const items = masteries.filter((x) => x.ch.module === m.id)
          if (!items.length) return null
          const avg = Math.round(items.reduce((a, x) => a + x.m.overall, 0) / items.length)
          return (
            <div className="card" key={m.id}>
              <div className="row between">
                <div className="row"><span className="module-dot" style={{ background: m.color }} /><strong>{m.title}</strong></div>
                <span className="muted small">{avg}%</span>
              </div>
              <div className="muted small" style={{ marginBottom: 8 }}>{m.tagline}</div>
              <ProgressBar value={avg} color={m.color} />
              <div className="row" style={{ marginTop: 10 }}>
                {items.map((x) => (
                  <Link key={x.ch.id} to={`/chapter/${x.ch.id}`} className="badge" title={x.ch.title}
                    style={{ borderColor: x.m.overall >= 70 ? m.color : undefined, color: x.m.overall >= 70 ? m.color : undefined }}>
                    {String(x.ch.id).padStart(2, '0')}
                  </Link>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {weak.length > 0 && (
        <>
          <h2 style={{ marginTop: 28 }}>Weakest quiz results</h2>
          <div className="grid grid-3">
            {weak.map((x) => (
              <Link key={x.ch.id} to={`/chapter/${x.ch.id}/quiz`} className="card chapter-card">
                <div className="eyebrow">Chapter {x.ch.id}</div>
                <strong>{x.ch.title}</strong>
                <div className="muted small">Best score {Math.round(x.m.quiz * 100)}%</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
