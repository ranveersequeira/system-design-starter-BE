import { NavLink, Outlet, useParams, Link, useLocation } from 'react-router-dom'
import { getChapter, CHAPTERS } from '../content'
import { MODULE_BY_ID } from '../content/modules'
import { useProgress } from '../lib/store'
import { chapterMastery } from '../lib/mastery'
import { ProgressBar } from '../components/ui'

export default function ChapterLayout() {
  const { id } = useParams()
  const ch = getChapter(id!)
  const p = useProgress()
  const loc = useLocation()
  if (!ch) {
    return (
      <div className="card">
        <h2>Chapter not found</h2>
        <p className="muted">This chapter has not been loaded yet. <Link to="/curriculum">Back to curriculum</Link></p>
      </div>
    )
  }
  const m = MODULE_BY_ID[ch.module]
  const ms = chapterMastery(ch, p)
  const idx = CHAPTERS.findIndex((c) => c.id === ch.id)
  const prev = CHAPTERS[idx - 1]
  const next = CHAPTERS[idx + 1]
  const tabs: [string, string][] = [
    ['', 'Overview'],
    ['learn', 'Learn'],
    ['quiz', 'Quiz'],
    ['feynman', 'Feynman'],
    ['cards', 'Flashcards'],
    ['palace', 'Memory palace'],
    ['notes', 'My notes'],
  ]
  if (ch.designPractice) tabs.push(['practice', 'Design practice'])
  return (
    <div>
      <div className="row between">
        <div className="row">
          <span className="module-dot" style={{ background: m.color }} />
          <span className="eyebrow">{m.title} · Chapter {String(ch.id).padStart(2, '0')}</span>
        </div>
        <div className="row small">
          {prev && <Link to={`/chapter/${prev.id}`}>← {prev.title}</Link>}
          {next && <Link to={`/chapter/${next.id}`}>{next.title} →</Link>}
        </div>
      </div>
      <h1>{ch.title}</h1>
      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="muted small">{ms.overall}% mastery · {ch.estimatedMinutes} min</span>
        <span className="muted small">{ms.dueCards} cards due</span>
      </div>
      <ProgressBar value={ms.overall} color={m.color} />
      <nav className="tabs">
        {tabs.map(([path, label]) => (
          <NavLink key={path} to={path === '' ? `/chapter/${ch.id}` : `/chapter/${ch.id}/${path}`} end={path === ''}
            className={({ isActive }) => (isActive || (path === 'learn' && loc.pathname.includes('/learn')) ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={ch} />
    </div>
  )
}
