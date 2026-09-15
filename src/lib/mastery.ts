import type { Chapter } from '../content/types'
import type { Progress } from './store'
import { isDue } from './srs'

export interface Mastery {
  read: number // 0..1
  quiz: number // 0..1 best score ratio
  cards: number // 0..1 fraction of cards with reps>0
  feynman: number // 0..1
  overall: number // 0..100
  dueCards: number
}

export function chapterMastery(ch: Chapter, p: Progress): Mastery {
  const key = String(ch.id)
  const read = ch.sections.length ? (p.sectionsRead[key]?.length ?? 0) / ch.sections.length : 0
  const attempts = p.quizAttempts[key] ?? []
  const quiz = attempts.length ? Math.max(...attempts.map((a) => a.score / a.total)) : 0
  let seen = 0
  let due = 0
  for (const c of ch.flashcards) {
    const s = p.srs[`${ch.id}:${c.id}`]
    if (s && s.reps > 0) seen++
    if (s && s.reps > 0 && isDue(s)) due++
  }
  const cards = ch.flashcards.length ? seen / ch.flashcards.length : 0
  let fe = 0
  for (const f of ch.feynman) if (p.feynman[`${ch.id}:${f.id}`]) fe++
  const feynman = ch.feynman.length ? fe / ch.feynman.length : 0
  const overall = Math.round((read * 0.3 + quiz * 0.35 + cards * 0.2 + feynman * 0.15) * 100)
  return { read, quiz, cards, feynman, overall, dueCards: due }
}
