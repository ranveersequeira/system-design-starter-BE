import type { Chapter } from './types'

const modules = import.meta.glob<{ default: Chapter }>('./chapters/*.ts', { eager: true })

export const CHAPTERS: Chapter[] = Object.values(modules)
  .map((m) => m.default)
  .filter(Boolean)
  .sort((a, b) => a.id - b.id)

export const CHAPTER_BY_ID = new Map<number, Chapter>(CHAPTERS.map((c) => [c.id, c]))

export function getChapter(id: number | string): Chapter | undefined {
  return CHAPTER_BY_ID.get(Number(id))
}

export function chaptersInModule(moduleId: Chapter['module']): Chapter[] {
  return CHAPTERS.filter((c) => c.module === moduleId)
}
