import { Link, useOutletContext } from 'react-router-dom'
import type { Chapter } from '../content/types'
import { useProgress, update } from '../lib/store'
import { chapterMastery } from '../lib/mastery'
import { ProgressBar } from '../components/ui'

export default function ChapterOverview() {
  const ch = useOutletContext<Chapter>()
  const p = useProgress()
  const ms = chapterMastery(ch, p)
  const done = p.completed.includes(ch.id)
  const read = p.sectionsRead[String(ch.id)] ?? []
  const attempts = p.quizAttempts[String(ch.id)] ?? []
  const firstUnread = ch.sections.findIndex((s) => !read.includes(s.id))
  const learnTarget = firstUnread === -1 ? 0 : firstUnread

  return (
    <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 18 }}>
      <div>
        <div className="card">
          <div className="eyebrow">Summary</div>
          <p>{ch.summary}</p>
          <div className="eyebrow">You will be able to</div>
          <ul>{ch.objectives.map((o, i) => <li key={i}>{o}</li>)}</ul>
        </div>
        <div className="card">
          <div className="row between">
            <h3 style={{ margin: 0 }}>Study path</h3>
            <span className="muted small">Recommended order</span>
          </div>
          <ol className="stack" style={{ marginTop: 10 }}>
            <li><Link to={`learn/${learnTarget}`}><strong>Learn</strong></Link> the {ch.sections.length} sections page by page, answering each checkpoint before revealing. <span className="muted small">({read.length}/{ch.sections.length} read)</span></li>
            <li><Link to="quiz"><strong>Quiz</strong></Link> yourself on {ch.quiz.length} questions. <span className="muted small">{attempts.length ? `Best ${Math.round(ms.quiz * 100)}%` : 'Not attempted'}</span></li>
            <li><Link to="feynman"><strong>Feynman</strong></Link>: explain {ch.feynman.length} core ideas in your own words and compare.</li>
            <li><Link to="palace"><strong>Walk the memory palace</strong></Link> once with eyes closed ({ch.memoryPalace.stops.length} stops).</li>
            <li><Link to="cards"><strong>Flashcards</strong></Link>: first pass through {ch.flashcards.length} cards; they then appear in daily Review.</li>
            {ch.designPractice && <li><Link to="practice"><strong>Design practice</strong></Link>: work the full design step by step before reading the reference.</li>}
          </ol>
        </div>
        <div className="card">
          <h3>Interview questions on this topic</h3>
          <ul>{ch.interviewQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      </div>
      <div>
        <div className="card">
          <div className="eyebrow">Mastery breakdown</div>
          {[
            ['Read', ms.read], ['Quiz', ms.quiz], ['Cards seen', ms.cards], ['Feynman', ms.feynman],
          ].map(([label, v]) => (
            <div key={label as string} style={{ marginTop: 10 }}>
              <div className="row between small"><span>{label as string}</span><span className="muted">{Math.round((v as number) * 100)}%</span></div>
              <ProgressBar value={(v as number) * 100} />
            </div>
          ))}
          <button className={`btn ${done ? '' : 'btn-primary'}`} style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
            onClick={() => update((d) => { d.completed = done ? d.completed.filter((x) => x !== ch.id) : [...d.completed, ch.id] })}>
            {done ? 'Completed ✓ (click to undo)' : 'Mark chapter complete'}
          </button>
        </div>
        <div className="card">
          <div className="eyebrow">60-second quick revision</div>
          <ul className="small crash-list" style={{ marginTop: 8 }}>{ch.quickRevision.slice(0, 6).map((c, i) => <li key={i}>{c}</li>)}</ul>
          <Link to={`/crash#ch-${ch.id}`} className="small">All revision notes →</Link>
        </div>
      </div>
    </div>
  )
}
