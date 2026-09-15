import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Chapter } from '../content/types'
import { MODULE_BY_ID } from '../content/modules'

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div className="progress" title={`${pct}%`}>
      <div style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

export function Callout({ kind, title, children }: { kind: 'model' | 'check' | 'ok' | 'bad'; title: string; children: ReactNode }) {
  return (
    <div className={`callout callout-${kind}`}>
      <div className="callout-title">{title}</div>
      {children}
    </div>
  )
}

export function Diagram({ text }: { text: string }) {
  return <div className="diagram">{text}</div>
}

export function ChapterBadge({ ch }: { ch: Chapter }) {
  const m = MODULE_BY_ID[ch.module]
  return (
    <span className="badge" style={{ color: m.color, borderColor: m.color + '66' }}>
      {m.title}
    </span>
  )
}

export function ChapterLink({ ch }: { ch: Chapter }) {
  return (
    <Link to={`/chapter/${ch.id}`}>
      {String(ch.id).padStart(2, '0')} · {ch.title}
    </Link>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="card muted" style={{ textAlign: 'center', padding: 40 }}>
      {children}
    </div>
  )
}
