// Validates every chapter file against the schema's quantity rules.
// Run: node --experimental-strip-types scripts/validate.ts
import { readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { Chapter } from '../src/content/types.ts'

const dir = join(import.meta.dirname, '..', 'src', 'content', 'chapters')
const files = readdirSync(dir).filter((f) => /^ch\d{2}\.ts$/.test(f)).sort()
let problems = 0
const seen = new Set<number>()

function range(name: string, n: number, lo: number, hi: number, ctx: string) {
  if (n < lo || n > hi) {
    console.log(`  [${ctx}] ${name}: ${n} (expected ${lo}-${hi})`)
    problems++
  }
}

for (const f of files) {
  const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default: Chapter }
  const c = mod.default
  const ctx = `ch${String(c.id).padStart(2, '0')}`
  if (`${ctx}.ts` !== f) { console.log(`  [${f}] id ${c.id} does not match filename`); problems++ }
  if (seen.has(c.id)) { console.log(`  [${f}] duplicate id`); problems++ }
  seen.add(c.id)
  range('objectives', c.objectives.length, 3, 5, ctx)
  range('quickRevision', c.quickRevision.length, 8, 14, ctx)
  range('sections', c.sections.length, 5, 8, ctx)
  range('quiz', c.quiz.length, 10, 14, ctx)
  range('flashcards', c.flashcards.length, 12, 18, ctx)
  range('feynman', c.feynman.length, 2, 4, ctx)
  range('palace stops', c.memoryPalace.stops.length, 5, 9, ctx)
  range('interviewQuestions', c.interviewQuestions.length, 4, 8, ctx)
  const diagrams = c.sections.filter((s) => s.diagram).length
  const checkpoints = c.sections.filter((s) => s.checkpoint).length
  if (diagrams < 3) { console.log(`  [${ctx}] only ${diagrams} diagrams (want >=3)`); problems++ }
  if (checkpoints < 3) { console.log(`  [${ctx}] only ${checkpoints} checkpoints (want >=3)`); problems++ }
  for (const s of c.sections) {
    const words = s.body.split(/\s+/).length
    if (words < 120) { console.log(`  [${ctx}] section "${s.id}" body only ${words} words`); problems++ }
    for (const line of (s.diagram ?? '').split('\n')) if (line.length > 90) { console.log(`  [${ctx}] diagram line >90 chars in "${s.id}"`); problems++; break }
  }
  const ids = (arr: { id: string }[], name: string) => {
    const set = new Set(arr.map((x) => x.id))
    if (set.size !== arr.length) { console.log(`  [${ctx}] duplicate ${name} ids`); problems++ }
  }
  ids(c.sections, 'section'); ids(c.quiz, 'quiz'); ids(c.flashcards, 'flashcard'); ids(c.feynman, 'feynman')
  for (const q of c.quiz) {
    if (q.type === 'mcq' && (q.answerIndex < 0 || q.answerIndex >= q.options.length)) { console.log(`  [${ctx}] ${q.id} answerIndex out of range`); problems++ }
    if (q.type === 'multi' && (q.answerIndices.length < 2 || q.answerIndices.some((i) => i < 0 || i >= q.options.length))) { console.log(`  [${ctx}] ${q.id} bad answerIndices`); problems++ }
    if (q.type === 'short' && (q.rubric.length < 3 || q.rubric.length > 5)) { console.log(`  [${ctx}] ${q.id} rubric size ${q.rubric.length}`); problems++ }
  }
  const types = new Set(c.quiz.map((q) => q.type))
  for (const t of ['mcq', 'truefalse', 'short'] as const) if (!types.has(t)) { console.log(`  [${ctx}] quiz has no ${t} questions`); problems++ }
  if (c.id >= 25) {
    if (!c.designPractice) { console.log(`  [${ctx}] case study missing designPractice`); problems++ }
    else if (c.designPractice.steps.length !== 7) { console.log(`  [${ctx}] designPractice has ${c.designPractice.steps.length} steps (want 7)`); problems++ }
  }
  for (const fc of c.flashcards) if (fc.back.split(/\s+/).length > 75) { console.log(`  [${ctx}] flashcard ${fc.id} back too long`); problems++ }
}
const missing = Array.from({ length: 35 }, (_, i) => i + 1).filter((i) => !seen.has(i))
problems += missing.length
console.log(`\n${files.length} chapter files checked, ${problems} problems, missing chapters: ${missing.length ? missing.join(', ') : 'none'}`)
process.exit(problems ? 1 : 0)
