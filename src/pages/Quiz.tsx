import { useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { Chapter, QuizQuestion } from '../content/types'
import Md from '../components/Md'
import { Callout } from '../components/ui'
import { useProgress, update } from '../lib/store'

type Answer = number | number[] | boolean | { text: string; ticked: number[] } | undefined

function isCorrect(q: QuizQuestion, a: Answer): boolean | null {
  if (a === undefined) return false
  switch (q.type) {
    case 'mcq': return a === q.answerIndex
    case 'truefalse': return a === q.answer
    case 'multi': {
      const arr = Array.isArray(a) ? [...a].sort() : []
      const want = [...q.answerIndices].sort()
      return arr.length === want.length && arr.every((x, i) => x === want[i])
    }
    case 'short': {
      const t = a as { text: string; ticked: number[] }
      return t.ticked.length >= Math.ceil(q.rubric.length * 0.75)
    }
  }
}

export default function Quiz() {
  const ch = useOutletContext<Chapter>()
  const p = useProgress()
  const attempts = p.quizAttempts[String(ch.id)] ?? []
  const lastWrong = attempts.at(-1)?.wrongIds ?? []
  const [mode, setMode] = useState<'all' | 'wrong' | null>(null)
  const questions = useMemo(() => {
    if (mode === 'wrong') return ch.quiz.filter((q) => lastWrong.includes(q.id))
    return ch.quiz
  }, [mode, ch, lastWrong])
  const [i, setI] = useState(0)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [checked, setChecked] = useState(false)
  const [finished, setFinished] = useState(false)

  if (mode === null) {
    return (
      <div className="card">
        <h2>Quiz: {ch.quiz.length} questions</h2>
        <p className="muted">Mixed recall, understanding and application. You get instant feedback and an explanation after each question. Wrong answers are saved so you can drill them later.</p>
        {attempts.length > 0 && (
          <p className="small">Attempts: {attempts.length} · Best: {Math.round(Math.max(...attempts.map((a) => a.score / a.total)) * 100)}% · Last: {attempts.at(-1)!.score}/{attempts.at(-1)!.total}</p>
        )}
        <div className="row">
          <button className="btn btn-primary" onClick={() => { setMode('all'); setI(0); setAnswers({}); setChecked(false); setFinished(false) }}>Start full quiz</button>
          {lastWrong.length > 0 && <button className="btn" onClick={() => { setMode('wrong'); setI(0); setAnswers({}); setChecked(false); setFinished(false) }}>Drill last {lastWrong.length} wrong</button>}
        </div>
      </div>
    )
  }

  if (finished) {
    const results = questions.map((q) => ({ q, ok: isCorrect(q, answers[q.id]) }))
    const score = results.filter((r) => r.ok).length
    return (
      <div className="card">
        <h2>Score: {score} / {questions.length}</h2>
        <p className="muted">{score === questions.length ? 'Perfect. Now explain it Feynman-style to lock it in.' : 'Review the ones you missed below, then re-read those sections.'}</p>
        <ul>
          {results.map(({ q, ok }) => (
            <li key={q.id}>
              <span className={`badge ${ok ? 'badge-ok' : 'badge-bad'}`}>{ok ? 'correct' : 'wrong'}</span>{' '}
              {q.type === 'truefalse' ? q.statement : q.question}
            </li>
          ))}
        </ul>
        <div className="row">
          <button className="btn" onClick={() => setMode(null)}>Back</button>
          <Link className="btn btn-primary" to={`/chapter/${ch.id}/feynman`}>Go to Feynman →</Link>
        </div>
      </div>
    )
  }

  const q = questions[i]
  const a = answers[q.id]
  const ok = checked ? isCorrect(q, a) : null
  function setA(v: Answer) { if (!checked) setAnswers((s) => ({ ...s, [q.id]: v })) }
  function check() { setChecked(true) }
  function nextQ() {
    if (i + 1 < questions.length) { setI(i + 1); setChecked(false) }
    else {
      const results = questions.map((qq) => ({ id: qq.id, ok: isCorrect(qq, answers[qq.id]) }))
      const score = results.filter((r) => r.ok).length
      update((d) => {
        const arr = d.quizAttempts[String(ch.id)] ?? []
        const wrongIds = results.filter((r) => !r.ok).map((r) => r.id)
        arr.push({ date: new Date().toISOString(), score, total: questions.length, wrongIds: mode === 'wrong' ? Array.from(new Set([...lastWrong.filter((id) => !results.some((r) => r.id === id && r.ok)), ...wrongIds])) : wrongIds })
        d.quizAttempts[String(ch.id)] = arr
      })
      setFinished(true)
    }
  }
  const answered = q.type === 'short' ? !!(a as { text: string } | undefined)?.text : a !== undefined

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">Question {i + 1} of {questions.length}</span>
        <span className="badge">{q.type === 'mcq' ? 'single choice' : q.type === 'multi' ? 'multiple select' : q.type === 'truefalse' ? 'true / false' : 'short answer'} · level {q.difficulty}</span>
      </div>
      <div className="card">
        <h3>{q.type === 'truefalse' ? q.statement : q.question}</h3>

        {q.type === 'mcq' && q.options.map((o, oi) => (
          <label key={oi} className={`option ${a === oi ? 'selected' : ''} ${checked && oi === q.answerIndex ? 'correct' : ''} ${checked && a === oi && oi !== q.answerIndex ? 'wrong' : ''}`}>
            <input type="radio" checked={a === oi} onChange={() => setA(oi)} disabled={checked} />
            <span>{o}</span>
          </label>
        ))}

        {q.type === 'multi' && q.options.map((o, oi) => {
          const sel = Array.isArray(a) && a.includes(oi)
          return (
            <label key={oi} className={`option ${sel ? 'selected' : ''} ${checked && q.answerIndices.includes(oi) ? 'correct' : ''} ${checked && sel && !q.answerIndices.includes(oi) ? 'wrong' : ''}`}>
              <input type="checkbox" checked={sel} disabled={checked} onChange={() => {
                const cur = Array.isArray(a) ? a : []
                setA(sel ? cur.filter((x) => x !== oi) : [...cur, oi])
              }} />
              <span>{o}</span>
            </label>
          )
        })}

        {q.type === 'truefalse' && [true, false].map((v) => (
          <label key={String(v)} className={`option ${a === v ? 'selected' : ''} ${checked && v === q.answer ? 'correct' : ''} ${checked && a === v && v !== q.answer ? 'wrong' : ''}`}>
            <input type="radio" checked={a === v} onChange={() => setA(v)} disabled={checked} />
            <span>{v ? 'True' : 'False'}</span>
          </label>
        ))}

        {q.type === 'short' && (
          <>
            <textarea rows={6} placeholder="Write your answer in your own words. Aim for the reasoning, not just keywords." disabled={checked}
              value={(a as { text: string } | undefined)?.text ?? ''} onChange={(e) => setA({ text: e.target.value, ticked: [] })} />
            {checked && (
              <>
                <Callout kind="model" title="Model answer"><Md>{q.modelAnswer}</Md></Callout>
                <div className="eyebrow">Self-check: tick what your answer covered</div>
                <div className="checklist">
                  {q.rubric.map((r, ri) => {
                    const t = (a as { text: string; ticked: number[] }).ticked
                    return (
                      <label key={ri}>
                        <input type="checkbox" checked={t.includes(ri)} onChange={() => setAnswers((s) => ({ ...s, [q.id]: { text: (a as { text: string }).text, ticked: t.includes(ri) ? t.filter((x) => x !== ri) : [...t, ri] } }))} />
                        <span>{r}</span>
                      </label>
                    )
                  })}
                </div>
                <p className="muted small">Counts as correct when you tick at least 75% of the rubric. Be honest; this is for you.</p>
              </>
            )}
          </>
        )}

        {checked && q.type !== 'short' && (
          <Callout kind={ok ? 'ok' : 'bad'} title={ok ? 'Correct' : 'Not quite'}>
            <Md>{q.explanation}</Md>
          </Callout>
        )}

        <div className="row between" style={{ marginTop: 14 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Quit</button>
          {!checked ? (
            <button className="btn btn-primary" disabled={!answered} onClick={check}>Check answer</button>
          ) : (
            <button className="btn btn-primary" onClick={nextQ}>{i + 1 < questions.length ? 'Next question →' : 'See results'}</button>
          )}
        </div>
      </div>
    </div>
  )
}
