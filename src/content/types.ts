/**
 * Content schema for System Design.
 * Every chapter file in src/content/chapters/ exports one `Chapter` object.
 * All long-form text fields (`body`, `back`, `modelExplanation`, `reference`, ...) are Markdown.
 * Diagrams are ASCII art inside the `diagram` field (rendered in a monospace block).
 */

export type ModuleId =
  | 'foundations'
  | 'databases'
  | 'caching'
  | 'messaging'
  | 'resilience'
  | 'building-blocks'
  | 'case-studies'

export interface ModuleMeta {
  id: ModuleId
  title: string
  tagline: string
  color: string // CSS color used for accents
}

export interface Checkpoint {
  /** A "pause and predict" question asked before the learner moves on. */
  question: string
  /** Revealed after the learner commits to an answer in their head / notes. */
  answer: string
}

export interface Section {
  id: string // kebab-case, unique within chapter
  title: string
  /** Main teaching text, Markdown. 150-400 words. Teach the WHY, not only the WHAT. */
  body: string
  /** An analogy or mental model that makes the idea sticky. 1-3 sentences. */
  mentalModel?: string
  /** Optional ASCII diagram. Keep lines <= 70 chars. */
  diagram?: string
  /** 3-6 crisp takeaways. */
  keyPoints: string[]
  /** Optional pause-and-predict question. */
  checkpoint?: Checkpoint
}

export type Difficulty = 1 | 2 | 3 // 1 recall, 2 understanding, 3 application/judgement

export interface McqQuestion {
  type: 'mcq'
  id: string
  difficulty: Difficulty
  question: string
  options: string[] // 4 options
  answerIndex: number
  /** Why the right answer is right AND why tempting wrong ones are wrong. */
  explanation: string
}

export interface MultiSelectQuestion {
  type: 'multi'
  id: string
  difficulty: Difficulty
  question: string
  options: string[] // 4-6 options
  answerIndices: number[] // 2+ correct
  explanation: string
}

export interface TrueFalseQuestion {
  type: 'truefalse'
  id: string
  difficulty: Difficulty
  statement: string
  answer: boolean
  explanation: string
}

export interface ShortAnswerQuestion {
  type: 'short'
  id: string
  difficulty: Difficulty
  question: string
  /** Model answer shown after the learner writes their own. Markdown. */
  modelAnswer: string
  /** Rubric points the learner self-checks against. 3-5 items. */
  rubric: string[]
}

export type QuizQuestion =
  | McqQuestion
  | MultiSelectQuestion
  | TrueFalseQuestion
  | ShortAnswerQuestion

export interface Flashcard {
  id: string
  front: string // question / term
  back: string // answer, Markdown, <= 60 words
}

export interface FeynmanPrompt {
  id: string
  concept: string
  /** Instruction, e.g. "Explain X to a junior dev who has never heard of it." */
  prompt: string
  /** A clean, plain-language model explanation. Markdown. 100-200 words. */
  modelExplanation: string
  /** Key ideas a good explanation must mention; learner ticks them off. 3-6 items. */
  mustMention: string[]
}

export interface PalaceStop {
  /** A location inside the palace, e.g. "Front door". */
  locus: string
  /** The concept anchored at this location. */
  concept: string
  /** A vivid, exaggerated, sensory mental image linking locus and concept. */
  image: string
}

export interface MemoryPalace {
  /** The setting, e.g. "A busy railway station". 1-2 sentences describing the walk. */
  setting: string
  stops: PalaceStop[] // 5-9 stops, in walking order
}

export interface DesignStep {
  title: string // e.g. "Functional requirements"
  /** What the learner should write before revealing the reference. */
  prompt: string
  /** Reference answer, Markdown. */
  reference: string
}

export interface DesignPractice {
  problem: string
  steps: DesignStep[]
}

export interface Chapter {
  id: number // 1..35
  slug: string
  title: string // e.g. "What Is System Design"
  module: ModuleId
  estimatedMinutes: number
  /** 2-3 sentence overview of what the chapter covers and why it matters. */
  summary: string
  /** Learning objectives, 3-5 items, "You will be able to ...". */
  objectives: string[]
  /** Quick-revision one-liners for fast repeated revision. 8-14 items. */
  quickRevision: string[]
  sections: Section[] // 5-8 sections
  quiz: QuizQuestion[] // 10-14 questions, mixed types and difficulties
  flashcards: Flashcard[] // 12-18 cards
  feynman: FeynmanPrompt[] // 2-4 prompts
  memoryPalace: MemoryPalace
  /** Present for case-study chapters (25-35); optional for others. */
  designPractice?: DesignPractice
  /** Common interview questions on this topic. 4-8 items. */
  interviewQuestions: string[]
}
