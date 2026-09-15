/** SM-2 style spaced repetition. Grades: 0 = again, 1 = hard, 2 = good, 3 = easy */
export interface CardState {
  interval: number // days
  ease: number
  due: number // epoch ms
  reps: number
  lapses: number
}

export const DAY = 86_400_000

export function newCardState(now = Date.now()): CardState {
  return { interval: 0, ease: 2.5, due: now, reps: 0, lapses: 0 }
}

export function review(state: CardState, grade: 0 | 1 | 2 | 3, now = Date.now()): CardState {
  let { interval, ease, reps, lapses } = state
  if (grade === 0) {
    lapses += 1
    reps = 0
    interval = 0
    ease = Math.max(1.3, ease - 0.2)
    // re-show in 10 minutes
    return { interval, ease, reps, lapses, due: now + 10 * 60_000 }
  }
  if (reps === 0) interval = grade === 1 ? 1 : grade === 2 ? 1 : 3
  else if (reps === 1) interval = grade === 1 ? 2 : grade === 2 ? 4 : 7
  else {
    const mult = grade === 1 ? 1.2 : grade === 2 ? ease : ease * 1.3
    interval = Math.max(interval + 1, Math.round(interval * mult))
  }
  if (grade === 1) ease = Math.max(1.3, ease - 0.15)
  if (grade === 3) ease = Math.min(3.0, ease + 0.15)
  reps += 1
  return { interval, ease, reps, lapses, due: now + interval * DAY }
}

export function isDue(state: CardState | undefined, now = Date.now()): boolean {
  return !state || state.due <= now
}
