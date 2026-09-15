import { useSyncExternalStore } from 'react'
import type { CardState } from './srs'

export interface QuizAttempt {
  date: string // ISO
  score: number
  total: number
  wrongIds: string[]
}

export interface FeynmanEntry {
  text: string
  ticked: number[]
  rating: 1 | 2 | 3 | 4 | 5
  date: string
}

export interface Progress {
  version: 1
  /** chapterId -> section ids read */
  sectionsRead: Record<string, string[]>
  /** chapterId -> attempts */
  quizAttempts: Record<string, QuizAttempt[]>
  /** `${chapterId}:${cardId}` -> SRS state */
  srs: Record<string, CardState>
  /** `${chapterId}:${promptId}` -> entry */
  feynman: Record<string, FeynmanEntry>
  /** chapterId -> markdown notes */
  notes: Record<string, string>
  /** chapterId -> custom palace text */
  palaces: Record<string, string>
  /** `${chapterId}:${stepIndex}` -> learner answer */
  designAnswers: Record<string, string>
  /** chapterId -> palace walked count */
  palaceWalks: Record<string, number>
  /** ISO dates (yyyy-mm-dd) with activity */
  activeDays: string[]
  /** chapter ids marked complete */
  completed: number[]
}

const KEY = 'sysdesign-dojo:v1'

const seedNotes: Record<string, string> = {
  '1': `## My notes: What is system design

Set of requirements:
- decide architecture
- decide components
- decide modules
- ...and how they interact with each other.

Architecture = big detail. Components like authentication sit inside it. Inside components are modules, like how we manage tokens (this is the typical flow).

How they interact makes the product development (full system), hence system design is very important.`,
}

function empty(): Progress {
  return {
    version: 1,
    sectionsRead: {},
    quizAttempts: {},
    srs: {},
    feynman: {},
    notes: { ...seedNotes },
    palaces: {},
    designAnswers: {},
    palaceWalks: {},
    activeDays: [],
    completed: [],
  }
}

function load(): Progress {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const parsed = JSON.parse(raw) as Partial<Progress>
    return { ...empty(), ...parsed, notes: { ...seedNotes, ...(parsed.notes ?? {}) } }
  } catch {
    return empty()
  }
}

let state: Progress = load()
const listeners = new Set<() => void>()

function emit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* ignore quota errors */
  }
  listeners.forEach((l) => l())
}

export function today(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function update(fn: (draft: Progress) => void) {
  const next: Progress = JSON.parse(JSON.stringify(state))
  fn(next)
  const t = today()
  if (!next.activeDays.includes(t)) next.activeDays.push(t)
  state = next
  emit()
}

export function replaceAll(next: Progress) {
  state = { ...empty(), ...next }
  emit()
}

export function resetAll() {
  state = empty()
  emit()
}

export function getState(): Progress {
  return state
}

export function useProgress(): Progress {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
    () => state,
  )
}

export function streak(days: string[]): number {
  const set = new Set(days)
  let count = 0
  const d = new Date()
  // allow today to be missing (streak counts up to yesterday)
  if (!set.has(fmt(d))) d.setDate(d.getDate() - 1)
  while (set.has(fmt(d))) {
    count++
    d.setDate(d.getDate() - 1)
  }
  return count
}

function fmt(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
