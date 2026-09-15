import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function Md({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}
