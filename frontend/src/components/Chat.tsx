import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, X } from 'lucide-react'
import { matchSkills, useStore } from '../store'
import type { ChatMessage } from '../store'
import { RunView } from './RunView'
import { Avatar, Field, Strip } from './Strip'
import { cx } from '../lib/ui'

export function Thread() {
  const messages = useStore((s) => s.messages)
  const end = useRef<HTMLDivElement>(null)
  const last = messages[messages.length - 1]
  const key = last ? (last.role === 'assistant' && last.kind === 'run' ? `${last.id}-${last.run.status}-${last.run.targets.length}` : last.id) : ''

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, key])

  if (!messages.length) return <EmptyState />

  return (
    <div className="mx-auto w-full max-w-[960px] space-y-8 px-4 pt-6 pb-8 md:px-8">
      {messages.map((m) => (
        <Message key={m.id} m={m} />
      ))}
      <div ref={end} />
    </div>
  )
}

function Message({ m }: { m: ChatMessage }) {
  const skills = useStore((s) => s.skills)
  const runWith = useStore((s) => s.runWith)

  if (m.role === 'user') {
    const s = skills.find((k) => k.id === m.skillIds[0])
    return (
      <div className="animate-slide-in flex justify-end">
        <div className="flex max-w-[80%] items-center gap-2.5 rounded-[20px] rounded-br-md bg-sel py-2.5 pr-4 pl-2.5 text-[15px] ring-1 ring-accent/25 backdrop-blur-xl">
          {s && <Avatar name={s.name} />}
          <span>{m.text}</span>
        </div>
      </div>
    )
  }
  if (m.kind === 'run') return <RunView msgId={m.id} skillIds={m.skillIds} run={m.run} />
  return (
    <div className="animate-slide-in">
      <p className="text-[15px] text-fg-2">{m.text}</p>
      {m.kind === 'pick-skill' && (
        <div className="mt-3 flex flex-wrap gap-2">
          {skills.map((s) => (
            <Strip key={s.id} as="button" tone="chip" className="h-9 hover:border-rule-2" onClick={() => runWith(m.id, s.id)}>
              <Field className="pr-0">
                <Avatar name={s.name} size={20} />
              </Field>
              <Field className="text-[13px] font-semibold">{s.name}</Field>
            </Strip>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  const skills = useStore((s) => s.skills)
  const setAttached = useStore((s) => s.setAttached)
  const examples = useMemo(() => {
    const out: { id: string; name: string; text: string }[] = []
    const shop = skills.find((s) => /shop/i.test(s.name))
    const quote = skills.find((s) => /quote/i.test(s.name))
    if (shop) out.push({ id: shop.id, name: shop.name, text: 'I need 5 laptops, each under £1000' })
    if (quote) out.push({ id: quote.id, name: quote.name, text: '1,200 steel brackets by 1 December' })
    return out
  }, [skills])

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center px-6 py-10">
      <h1 className="text-[44px] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">
        Show it once.
        <span className="block bg-[linear-gradient(100deg,var(--color-fg-3)_30%,var(--color-accent-2))] bg-clip-text pb-1 text-transparent">Then just ask.</span>
      </h1>
      {examples.length > 0 && (
        <div className="mt-10 space-y-2">
          {examples.map((e, i) => (
            <Strip
              key={e.text}
              as="button"
              tone="ghost"
              className="animate-slide-in h-12 w-full hover:-translate-y-px hover:border-rule-2 hover:bg-chip"
              style={{ animationDelay: `${120 + i * 70}ms` }}
              onClick={() => {
                setAttached([e.id])
                window.dispatchEvent(new CustomEvent('copycat:prefill', { detail: e.text }))
              }}
            >
              <Field className="pl-3">
                <Avatar name={e.name} />
              </Field>
              <Field className="flex-1 text-[15px] text-fg">{e.text}</Field>
              <Field className="pr-3">
                <ArrowUp className="size-4 rotate-45 text-fg-3" />
              </Field>
            </Strip>
          ))}
        </div>
      )}
    </div>
  )
}

export function Composer() {
  const skills = useStore((s) => s.skills)
  const attached = useStore((s) => s.attached)
  const toggle = useStore((s) => s.toggleAttach)
  const send = useStore((s) => s.send)
  const recording = useStore((s) => s.recording.status !== 'idle')
  const running = useStore((s) => s.messages.some((m) => m.role === 'assistant' && m.kind === 'run' &&
    (m.run.stopping || ['starting', 'planning', 'running'].includes(m.run.status))))
  const [text, setText] = useState('')
  const [mention, setMention] = useState<{ q: string; at: number } | null>(null)
  const [hi, setHi] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const h = (e: Event) => {
      setText((e as CustomEvent<string>).detail)
      ta.current?.focus()
    }
    window.addEventListener('copycat:prefill', h)
    return () => window.removeEventListener('copycat:prefill', h)
  }, [])

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [text])

  const chosen = attached.map((id) => skills.find((s) => s.id === id)).filter(Boolean) as typeof skills
  const guessed = attached.length ? [] : matchSkills(text, skills)
  const options = mention ? skills.filter((s) => s.name.toLowerCase().includes(mention.q.toLowerCase())) : []

  const onChange = (v: string, caret: number) => {
    setText(v)
    const m = v.slice(0, caret).match(/(^|\s)@([\w-]*)$/)
    setMention(m ? { q: m[2], at: caret - m[2].length - 1 } : null)
    setHi(0)
  }
  const pick = (id: string) => {
    if (!mention) return
    if (!attached.includes(id)) toggle(id)
    const caret = ta.current?.selectionStart ?? text.length
    setText((text.slice(0, mention.at) + text.slice(caret)).replace(/\s{2,}/g, ' '))
    setMention(null)
    ta.current?.focus()
  }
  const submit = () => {
    const t = text.trim()
    if (!t || recording || running) return
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    void send(t)
    setText('')
  }

  return (
    <div className="relative mx-auto w-full max-w-[960px] px-4 pb-4 md:px-8">
      {mention && options.length > 0 && (
        <div className="glass-pop animate-slide-in absolute bottom-full left-4 mb-2 w-72 origin-bottom-left space-y-1 rounded-2xl p-1.5 md:left-8">
          {options.map((s, i) => (
            <Strip
              key={s.id}
              as="button"
              tone={i === hi ? 'sel' : 'chip'}
              className="h-9 w-full"
              onMouseDown={(e: React.MouseEvent) => (e.preventDefault(), pick(s.id))}
              onMouseEnter={() => setHi(i)}
            >
              <Field className="pr-0">
                <Avatar name={s.name} size={20} />
              </Field>
              <Field className="flex-1 text-[13px] font-semibold">
                <span className="truncate">{s.name}</span>
              </Field>
            </Strip>
          ))}
        </div>
      )}

      <div className="glass-pop composer flex items-end gap-2 rounded-[22px] p-2 transition-shadow duration-300">
        {(chosen.length > 0 || guessed.length > 0) && (
          <div className="flex shrink-0 gap-1 self-center pl-1">
            {chosen.map((s) => (
              <button
                key={s.id}
                onClick={() => toggle(s.id)}
                className="group flex h-7 items-center gap-1.5 rounded-full bg-sel pr-1.5 pl-1 text-[13px] font-medium text-fg ring-1 ring-accent/50"
                title={`${s.name} · click to remove`}
              >
                <Avatar name={s.name} size={20} />
                {s.name}
                <X className="size-3 opacity-50 group-hover:opacity-100" />
              </button>
            ))}
            {guessed.map((s) => (
              <span key={s.id} className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-rule-2 pr-2 pl-1 text-[13px] text-fg-2" title={`Will use ${s.name}`}>
                <Avatar name={s.name} size={20} />
                {s.name}
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={recording || running}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            if (mention && options.length) {
              if (e.key === 'ArrowDown') return e.preventDefault(), setHi((h) => (h + 1) % options.length)
              if (e.key === 'ArrowUp') return e.preventDefault(), setHi((h) => (h - 1 + options.length) % options.length)
              if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pick(options[hi].id)
              if (e.key === 'Escape') return setMention(null)
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={recording ? 'Recording…' : running ? 'Agent is working…' : chosen.length ? 'What do you need this time?' : 'Pick a skill with @, then say what you need'}
          aria-label="Task"
          className="max-h-[180px] min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed outline-none focus-visible:outline-none placeholder:text-fg-3 disabled:opacity-50"
        />
        <button
          onClick={submit}
          disabled={!text.trim() || recording || running}
          className={cx(
            'grid size-10 shrink-0 place-items-center rounded-full transition',
            'btn-gloss bg-accent text-white hover:bg-accent-2 disabled:bg-chip disabled:text-fg-3',
          )}
          aria-label="Run"
        >
          <ArrowUp className="size-[18px]" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  )
}
