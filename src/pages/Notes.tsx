import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { Chapter } from '../content/types'
import Md from '../components/Md'
import { useProgress, update } from '../lib/store'

export default function Notes() {
  const ch = useOutletContext<Chapter>()
  const p = useProgress()
  const text = p.notes[String(ch.id)] ?? ''
  const [preview, setPreview] = useState(false)
  return (
    <div>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>My notes</h2>
          <div className="row">
            <button className={`btn btn-sm ${!preview ? 'btn-primary' : ''}`} onClick={() => setPreview(false)}>Edit</button>
            <button className={`btn btn-sm ${preview ? 'btn-primary' : ''}`} onClick={() => setPreview(true)}>Preview</button>
          </div>
        </div>
        <p className="muted small">Markdown supported. Write your own summaries, key ideas, and anything the quiz revealed you had wrong. Notes are saved locally and included in Settings → Export.</p>
        {preview ? (
          text ? <Md>{text}</Md> : <p className="muted">Nothing yet.</p>
        ) : (
          <textarea rows={22} value={text} onChange={(e) => update((d) => { d.notes[String(ch.id)] = e.target.value })} placeholder="## Key ideas\n- ...\n\n## Questions I still have\n- ..." />
        )}
      </div>
    </div>
  )
}
