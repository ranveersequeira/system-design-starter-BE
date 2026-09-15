import { useState } from 'react'
import { NavLink, Route, Routes, Navigate, useLocation } from 'react-router-dom'
import { CHAPTERS } from './content'
import { useProgress } from './lib/store'
import { isDue } from './lib/srs'
import Dashboard from './pages/Dashboard'
import Curriculum from './pages/Curriculum'
import ChapterLayout from './pages/ChapterLayout'
import ChapterOverview from './pages/ChapterOverview'
import Learn from './pages/Learn'
import Quiz from './pages/Quiz'
import Feynman from './pages/Feynman'
import Flashcards from './pages/Flashcards'
import Palace from './pages/Palace'
import Notes from './pages/Notes'
import Practice from './pages/Practice'
import Review from './pages/Review'
import Crash from './pages/Crash'
import Mistakes from './pages/Mistakes'
import Settings from './pages/Settings'

function dueCount(srs: Record<string, { due: number; reps: number }>): number {
  let n = 0
  for (const ch of CHAPTERS) for (const c of ch.flashcards) {
    const s = srs[`${ch.id}:${c.id}`]
    if (s && s.reps > 0 && isDue(s as never)) n++
  }
  return n
}

export default function App() {
  const p = useProgress()
  const due = dueCount(p.srs)
  const location = useLocation()
  const [menuLocation, setMenuLocation] = useState<string | null>(null)
  const menuOpen = menuLocation === location.key
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand"><span>◆</span> System Design</div>
          <button className="menu-toggle btn-ghost" aria-expanded={menuOpen} aria-controls="main-nav"
            onClick={() => setMenuLocation(menuOpen ? null : location.key)}>
            {menuOpen ? 'Close' : 'Menu'}
          </button>
        </div>
        <nav id="main-nav" className={`nav ${menuOpen ? 'nav-open' : ''}`} aria-label="Main navigation"
          onClick={() => setMenuLocation(null)}>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/curriculum">Curriculum</NavLink>
          <NavLink to="/review">
            Review <span className={`badge ${due ? 'badge-accent' : ''}`}>{due}</span>
          </NavLink>
          <NavLink to="/crash">Quick revision</NavLink>
          <NavLink to="/mistakes">Mistakes</NavLink>
          <div className="nav-section">More</div>
          <NavLink to="/settings">Settings & data</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/curriculum" element={<Curriculum />} />
          <Route path="/review" element={<Review />} />
          <Route path="/crash" element={<Crash />} />
          <Route path="/mistakes" element={<Mistakes />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/chapter/:id" element={<ChapterLayout />}>
            <Route index element={<ChapterOverview />} />
            <Route path="learn" element={<Learn />} />
            <Route path="learn/:section" element={<Learn />} />
            <Route path="quiz" element={<Quiz />} />
            <Route path="feynman" element={<Feynman />} />
            <Route path="cards" element={<Flashcards />} />
            <Route path="palace" element={<Palace />} />
            <Route path="notes" element={<Notes />} />
            <Route path="practice" element={<Practice />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
