import { useRef, useState } from 'react'
import { getState, replaceAll, resetAll, useProgress } from '../lib/store'
import type { Progress } from '../lib/store'

export default function Settings() {
  const p = useProgress()
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState(false)

  function exportJson() {
    const blob = new Blob([JSON.stringify(getState(), null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `system-design-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  function importJson(file: File) {
    file.text().then((t) => {
      try {
        const parsed = JSON.parse(t) as Progress
        if (parsed.version !== 1) throw new Error('unknown version')
        replaceAll(parsed)
        setMsg('Imported successfully.')
      } catch (e) {
        setMsg(`Import failed: ${(e as Error).message}`)
      }
    })
  }

  return (
    <div>
      <h1>Settings & data</h1>
      <div className="card">
        <h3>Your data</h3>
        <p className="muted small">Everything (progress, quiz history, flashcard schedule, Feynman explanations, notes, palaces, design answers) is stored in this browser's localStorage. Export regularly to keep a backup or to move between machines.</p>
        <div className="row">
          <button className="btn btn-primary" onClick={exportJson}>Export JSON</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
        </div>
        {msg && <p className="small" style={{ marginTop: 10 }}>{msg}</p>}
      </div>
      <div className="card">
        <h3>Stats</h3>
        <ul className="small">
          <li>Active days: {p.activeDays.length}</li>
          <li>Quiz attempts: {Object.values(p.quizAttempts).reduce((a, x) => a + x.length, 0)}</li>
          <li>Cards scheduled: {Object.keys(p.srs).length}</li>
          <li>Feynman explanations written: {Object.keys(p.feynman).length}</li>
          <li>Chapters with notes: {Object.values(p.notes).filter((n) => n.trim()).length}</li>
        </ul>
      </div>
      <div className="card">
        <h3>Reset</h3>
        <p className="muted small">Wipes all progress in this browser. Export first.</p>
        {!confirm ? (
          <button className="btn" onClick={() => setConfirm(true)}>Reset everything…</button>
        ) : (
          <div className="row">
            <button className="btn" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }} onClick={() => { resetAll(); setConfirm(false) }}>Yes, wipe all progress</button>
            <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  )
}
