import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { CHAPTERS } from '../content'
import { MODULES } from '../content/modules'
import type { ModuleId } from '../content/types'

export default function Crash() {
  const [filter, setFilter] = useState<ModuleId | 'all'>('all')
  const [hideMode, setHideMode] = useState(false)
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const loc = useLocation()
  useEffect(() => {
    if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView()
  }, [loc.hash])
  const list = CHAPTERS.filter((c) => filter === 'all' || c.module === filter)
  return (
    <div>
      <h1>Quick revision</h1>
      <p className="muted">Every chapter compressed to one-liners for rapid, repeated revision. Read a module in five minutes before an interview, or use <strong>Active recall</strong> to hide the lines and recall them from the chapter title alone.</p>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : ''}`} onClick={() => setFilter('all')}>All</button>
        {MODULES.map((m) => (
          <button key={m.id} className={`btn btn-sm ${filter === m.id ? 'btn-primary' : ''}`} onClick={() => setFilter(m.id)}>{m.title}</button>
        ))}
        <label className="row small" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={hideMode} onChange={(e) => { setHideMode(e.target.checked); setShown({}) }} /> Active recall</label>
      </div>
      <div className="stack">
        {list.map((ch) => (
          <div className="card" key={ch.id} id={`ch-${ch.id}`}>
            <div className="row between">
              <h3 style={{ margin: 0 }}><Link to={`/chapter/${ch.id}`}>{String(ch.id).padStart(2, '0')} · {ch.title}</Link></h3>
              {hideMode && <button className="btn btn-sm" onClick={() => setShown((s) => ({ ...s, [ch.id]: !s[ch.id] }))}>{shown[ch.id] ? 'Hide' : 'Reveal'}</button>}
            </div>
            {(!hideMode || shown[ch.id]) ? (
              <ul className="crash-list" style={{ marginTop: 10 }}>{ch.quickRevision.map((c, i) => <li key={i}>{c}</li>)}</ul>
            ) : (
              <p className="muted small" style={{ marginTop: 10 }}>Say out loud everything you remember about this chapter, then reveal.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
