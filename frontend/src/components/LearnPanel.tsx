import { useEffect, useRef, useState } from 'react'
import { Globe, MousePointerClick, Send, TextCursorInput } from 'lucide-react'
import { useStore } from '../store'
import { learnVar } from '../lib/learn'
import { clock, cx, hostOf } from '../lib/ui'
import { Field, Strip } from './Strip'

const ICON = { navigate: Globe, click: MousePointerClick, change: TextCursorInput, submit: Send }

export function LearnPanel() {
  const rec = useStore((s) => s.recording)
  const save = useStore((s) => s.saveDraft)
  const cancel = useStore((s) => s.cancelRecording)
  const [name, setName] = useState('')
  const [, tick] = useState(0)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (rec.status !== 'recording') return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [rec.status])
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [rec.actions.length, rec.status])

  const vars = new Map<string, string>()
  for (const a of rec.actions) {
    const v = learnVar(a)
    if (v) vars.set(v.name, v.value)
  }
  const draft = rec.draft
  const elapsed = rec.startedAt ? (rec.stoppedAt ?? Date.now()) - rec.startedAt : 0

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pt-6 pb-8 md:px-8">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[24px] leading-tight font-semibold tracking-[-0.025em]">
          {rec.status === 'review' ? 'Here’s what I learned' : rec.status === 'compiling' ? 'Turning that into a skill…' : 'Watching you work'}
        </h2>
        <span className="tabular ml-auto flex items-center gap-2 font-mono text-[12px] text-fg-3">
          {rec.status === 'recording' && <span className="size-2 animate-blink rounded-full bg-rec" />}
          {hostOf(rec.url)} · {rec.status === 'starting' ? '--:--' : clock(elapsed)}
        </span>
      </header>
      <p className="mt-1 text-[14px] text-fg-3">
        {rec.status === 'starting' ? 'Opening the browser…'
          : rec.status === 'recording' ? 'Do the task in the browser window. Each action shows up here as a step.'
          : rec.status === 'compiling' ? `Reading ${rec.actions.length} actions and working out what you meant.`
          : 'Name it and it’s ready to use on other sites.'}
      </p>

      {rec.status !== 'review' && (
        <ol className="mt-6 space-y-2">
          {rec.actions.map((a, i) => {
            const Icon = ICON[a.kind]
            const v = learnVar(a)
            const latest = i === rec.actions.length - 1 && rec.status === 'recording'
            return (
              <li key={a.id} className="animate-slide-in">
                <Strip tone={latest ? 'sel' : 'chip'} className="min-h-11">
                  <Field className="tabular w-9 justify-center pr-0 font-mono text-[11px] text-fg-3">{i + 1}</Field>
                  <Field className="pr-0"><Icon className="size-4 text-fg-3" /></Field>
                  <Field className="min-w-0 flex-1 py-2 text-[14px]">
                    <span className="truncate">{a.summary}</span>
                  </Field>
                  {v && (
                    <Field className="shrink-0 gap-1.5 pr-3 font-mono text-[12px]">
                      <span className="hidden text-fg-3 sm:inline">“{v.value}”</span>
                      <span className="animate-slide-in text-fg-3 [animation-delay:700ms]" aria-hidden>→</span>
                      <span className="animate-slide-in rounded bg-accent/15 px-1.5 py-0.5 text-accent-2 [animation-delay:900ms]" title={`Next time you can change ${v.name}`}>
                        {`{${v.name}}`}
                      </span>
                    </Field>
                  )}
                </Strip>
              </li>
            )
          })}
          {rec.status === 'recording' && (
            <li className="flex h-11 items-center gap-2 rounded-lg border border-dashed border-rule-2 px-3 text-[13px] text-fg-3">
              <span className="h-3.5 w-px animate-caret bg-fg-3" /> Waiting for your next action
            </li>
          )}
        </ol>
      )}

      {rec.status !== 'review' && vars.size > 0 && (
        <div className="mt-6">
          <div className="text-[13px] text-fg-2">Things you can change next time</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {[...vars].map(([k, v]) => (
              <span key={k} className="animate-slide-in flex items-center gap-1.5 rounded-md bg-panel px-2 py-1 text-[12.5px] ring-1 ring-rule">
                <span className="font-mono text-accent-2">{`{${k}}`}</span>
                <span className="text-fg-3">was “{v}”</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {draft && (
        <form
          className="mt-6 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!name.trim()) return
            await save(name.trim(), draft.description)
            if (useStore.getState().recording.status === 'idle') setName('')
          }}
        >
          <ol className="space-y-1.5">
            {draft.steps.map((s, i) => (
              <li key={s.id} className="animate-slide-in" style={{ animationDelay: `${i * 70}ms` }}>
                <Strip tone="chip" className="h-10">
                  <Field className="tabular w-9 justify-center pr-0 font-mono text-[11px] text-fg-3">{i + 1}</Field>
                  <Field className="min-w-0 flex-1 text-[14px]"><span className="truncate">{s.description}</span></Field>
                  {s.optional && <Field className="text-[11.5px] text-fg-3">if needed</Field>}
                  {s.slot && <Field className="pr-3"><span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[12px] text-accent-2">{`{${s.slot}}`}</span></Field>}
                </Strip>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name this skill, e.g. Shopping"
              aria-label="Skill name"
              className="h-10 min-w-0 flex-1 rounded-xl bg-panel px-3 text-[14px] ring-1 ring-rule-2 outline-none placeholder:text-fg-3 focus:ring-accent"
            />
            <button type="button" disabled={rec.saving} onClick={() => void cancel()} className="h-10 rounded-xl px-3 text-[13px] text-fg-3 hover:text-fg disabled:opacity-40">
              Discard
            </button>
            <button type="submit" disabled={!name.trim() || rec.saving} className={cx('h-10 rounded-xl bg-fg px-4 text-[13px] font-semibold text-bg disabled:opacity-40')}>
              {rec.saving ? 'Saving…' : 'Save skill'}
            </button>
          </div>
          {rec.error && <p role="alert" className="text-[12px] text-heal">{rec.error}</p>}
        </form>
      )}
      <div ref={end} />
    </div>
  )
}
