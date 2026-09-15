import { Link } from 'react-router-dom'
import { CHAPTERS } from '../content'
import Md from '../components/Md'
import { Empty } from '../components/ui'
import { useProgress } from '../lib/store'

export default function Mistakes() {
  const p = useProgress()
  const items = CHAPTERS.flatMap((ch) => {
    const wrong = p.quizAttempts[String(ch.id)]?.at(-1)?.wrongIds ?? []
    return ch.quiz.filter((q) => wrong.includes(q.id)).map((q) => ({ ch, q }))
  })
  return (
    <div>
      <h1>Mistakes to revisit</h1>
      <p className="muted">Questions you got wrong on your most recent attempt of each chapter quiz. Read the explanation, then re-take the quiz in "drill wrong" mode until this list is empty.</p>
      {items.length === 0 && <Empty>No open mistakes. Take a quiz to find your gaps.</Empty>}
      <div className="stack">
        {items.map(({ ch, q }) => (
          <div className="card" key={`${ch.id}:${q.id}`}>
            <div className="row between">
              <Link className="small" to={`/chapter/${ch.id}/quiz`}>Ch {ch.id}: {ch.title}</Link>
              <span className="badge">level {q.difficulty}</span>
            </div>
            <h3 style={{ marginTop: 6 }}>{q.type === 'truefalse' ? q.statement : q.question}</h3>
            <details>
              <summary>Show answer</summary>
              {q.type === 'mcq' && <p><strong>{q.options[q.answerIndex]}</strong></p>}
              {q.type === 'multi' && <ul>{q.answerIndices.map((i) => <li key={i}>{q.options[i]}</li>)}</ul>}
              {q.type === 'truefalse' && <p><strong>{q.answer ? 'True' : 'False'}</strong></p>}
              {q.type === 'short' ? <Md>{q.modelAnswer}</Md> : <Md>{q.explanation}</Md>}
            </details>
          </div>
        ))}
      </div>
    </div>
  )
}
