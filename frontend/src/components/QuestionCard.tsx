import { useState } from 'react'
import { Hand, Send } from 'lucide-react'
import { useStore } from '../store'
import type { TargetState } from '../store'
import { cx } from '../lib/ui'

/**
 * A site is paused on a question from the page (e.g. which size). Answering continues it.
 * `inline` sits inside the spotlight window, under its "Waiting for you" footer.
 */
export function QuestionCard({ msgId, t, inline }: { msgId: string; t: TargetState; inline?: boolean }) {
  const answer = useStore((s) => s.answer)
  const [text, setText] = useState('')
  const q = t.question!
  const field = q.field.replace(/_/g, ' ')
  const send = (value: string) => { if (value.trim() && !q.sending) void answer(msgId, t.id, value) }
  return (
    <div role="group" aria-label={`${t.name} needs your answer`} onClick={(e) => e.stopPropagation()}
      className={cx('animate-slide-in', inline ? 'border-t border-fuzzy/30 bg-fuzzy/[0.05] px-3 py-2.5' : 'rounded-xl bg-fuzzy/[0.07] px-3.5 py-3 ring-1 ring-fuzzy/50')}>
      {!inline && (
        <div className="mb-2.5 flex items-start gap-2 text-[13.5px]">
          <Hand className="mt-0.5 size-4 shrink-0 text-fuzzy" />
          <div className="min-w-0">
            <span className="font-medium text-fg">{t.name}</span> <span className="text-fg-2">is waiting for you:</span>{' '}
            <span className="text-fg">{q.question}</span>
          </div>
        </div>
      )}
      {q.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((option) => (
            <button key={option} type="button" disabled={q.sending} onClick={() => send(option)}
              className="h-7 rounded-lg bg-panel px-2.5 font-mono text-[12px] text-fg ring-1 ring-rule-2 hover:ring-fuzzy disabled:opacity-50">
              {option}
            </button>
          ))}
        </div>
      )}
      <form className={cx('flex gap-1.5', q.options.length > 0 && 'mt-2')} onSubmit={(e) => { e.preventDefault(); send(text) }}>
        <input value={text} onChange={(e) => setText(e.target.value)} disabled={q.sending} maxLength={200}
          placeholder={q.options.length ? `Or type a ${field}` : `Your ${field}`} aria-label={`Your ${field}`}
          className="h-8 min-w-0 flex-1 rounded-lg bg-panel px-2.5 text-[13px] text-fg ring-1 ring-rule-2 outline-none placeholder:text-fg-3 focus:ring-fuzzy disabled:opacity-50" />
        <button type="submit" disabled={q.sending || !text.trim()}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-fuzzy px-3 text-[12.5px] font-semibold text-black hover:brightness-110 disabled:opacity-50">
          <Send className="size-3.5" /> {q.sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      <p className="mt-1.5 text-[11.5px] text-fg-3">Your answer is reused on the other sites in this run.</p>
      {q.error && <p role="alert" className="mt-1 text-[12px] text-heal">{q.error}</p>}
    </div>
  )
}
