import { useEffect, useState } from 'react'
import { Check, ChevronDown, Square, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import type { Skill, Step } from '../api'
import { USE_MOCK } from '../api'
import { clock, cx, hostOf, timeAgo } from '../lib/ui'
import { successRate } from '../lib/stats'
import type { SkillStats } from '../lib/stats'
import { Avatar, Field, Strip } from './Strip'

export function Rail({ onPicked }: { onPicked?: () => void }) {
  const skills = useStore((s) => s.skills)
  const loaded = useStore((s) => s.skillsLoaded)
  const error = useStore((s) => s.skillsError)
  const connected = useStore((s) => s.agentConnected)
  const load = useStore((s) => s.loadSkills)

  return (
    <aside className="glass-thick flex h-full w-full flex-col">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Logo />
        <span className="text-[16px] font-semibold tracking-[-0.02em]">CopyCat</span>
      </div>

      <RecordControl />

      <div className="flex items-center justify-between px-4 pt-5 pb-2 text-[12px] text-fg-3">
        <span className="font-medium">Skills</span>
        <span className="tabular font-mono">{skills.length}</span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {error && <p role="alert" className="px-1 pt-2 text-[12px] text-heal">{error}</p>}
        {!loaded && [0, 1].map((i) => <div key={i} className="h-11 rounded-lg bg-panel" />)}
        {loaded && skills.length === 0 && (
          <p className="px-1 pt-2 text-[13px] leading-snug text-fg-3">Nothing yet. Record a task and it lands here.</p>
        )}
        {skills.map((s) => (
          <SkillStrip key={s.id} skill={s} onPicked={onPicked} />
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-4 py-3 text-[11px] text-fg-3">
        <span className={cx('size-1.5 rounded-full', USE_MOCK ? 'bg-accent' : connected ? 'bg-exact' : 'bg-fg-3')} />
        {USE_MOCK ? 'Mock agent' : !loaded ? 'Connecting to agent…' : connected ? 'Agent connected' : 'Agent unavailable'}
        {!USE_MOCK && loaded && !connected && <button className="ml-auto hover:text-fg" onClick={() => void load()}>Retry</button>}
      </div>
    </aside>
  )
}

export function Logo({ size = 28 }: { size?: number }) {
  // The CopyCat cat, winking because the cursor just clicked its eye.
  return <img src="/favicon.svg" width={size} height={size} alt="" aria-hidden className="shrink-0 select-none" draggable={false} />
}

function RecordControl() {
  const rec = useStore((s) => s.recording)
  const start = useStore((s) => s.startRecording)
  const stop = useStore((s) => s.stopRecording)
  const cancel = useStore((s) => s.cancelRecording)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(rec.url || (USE_MOCK ? 'http://localhost:5173/northwind' : 'https://'))
  const [, tick] = useState(0)

  useEffect(() => {
    if (rec.status !== 'recording') return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [rec.status])

  if (rec.status === 'starting' || rec.status === 'recording') {
    const last = rec.actions[rec.actions.length - 1]
    return (
      <div className="mx-3 rounded-xl bg-rec/12 ring-1 ring-rec/40">
        <div className="flex items-center gap-2 px-3 pt-2.5">
          <span className="size-2 animate-blink rounded-full bg-rec" />
          <span className="tabular font-mono text-[12px] text-rec">
            {rec.status === 'recording' ? clock(Date.now() - (rec.startedAt ?? Date.now())) : '--:--'}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-3">{hostOf(rec.url)}</span>
          <button onClick={() => void cancel()} className="grid size-6 place-items-center rounded text-fg-3 hover:text-fg" aria-label="Discard recording">
            <X className="size-3.5" />
          </button>
        </div>
        <p key={last?.id} className="animate-slide-in truncate px-3 pt-1 text-[13px] text-fg-2">
          {rec.status === 'starting' ? 'Opening browser…' : rec.connection === 'reconnecting' ? 'Reconnecting to recorder…' : (last?.summary ?? 'Do the task in the browser window')}
        </p>
        <div className="p-2">
          <button
            onClick={() => void stop()}
            disabled={rec.status !== 'recording'}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-fg text-[13px] font-semibold text-bg transition hover:bg-white disabled:opacity-40"
          >
            <Square className="size-3 fill-rec text-rec" /> Stop · {rec.actions.length} actions
          </button>
        </div>
      </div>
    )
  }

  if (rec.status !== 'idle') return null

  return (
    <div className="mx-3">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="glass group flex h-10 w-full items-center gap-2.5 rounded-full px-3.5 text-[14px] font-medium hover:bg-white/8"
        >
          <span className="size-2.5 rounded-full bg-rec shadow-[0_0_0_3px_rgb(255_91_79/.18)] transition group-hover:shadow-[0_0_0_5px_rgb(255_91_79/.2)]" />
          Record a skill
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!url.trim()) return
            setOpen(false)
            void start(url.trim())
          }}
          className="animate-slide-in space-y-2"
        >
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            aria-label="Start URL"
            className="h-10 w-full rounded-full bg-black/30 px-3.5 font-mono text-[12px] ring-1 ring-rule-2 outline-none focus:ring-accent"
            placeholder="https://"
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-full px-3 text-[13px] text-fg-3 hover:bg-white/6 hover:text-fg">
              Cancel
            </button>
            <button type="submit" className="flex h-9 flex-1 items-center justify-center gap-2 rounded-full bg-rec bg-[linear-gradient(180deg,rgb(255_255_255/.22),transparent_60%)] text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/.3),0_6px_18px_-6px_rgb(255_77_77/.7)] hover:brightness-110">
              <span className="size-2 rounded-full bg-white" /> Start
            </button>
          </div>
        </form>
      )}
      {rec.error && <p className="mt-2 text-[12px] text-heal">{rec.error}</p>}
    </div>
  )
}

function SkillStrip({ skill, onPicked }: { skill: Skill; onPicked?: () => void }) {
  const attached = useStore((s) => s.attached.includes(skill.id))
  const fresh = useStore((s) => s.justSavedId === skill.id)
  const toggle = useStore((s) => s.toggleAttach)
  const del = useStore((s) => s.deleteSkill)
  const stats = useStore((s) => s.stats[skill.id])
  const [open, setOpen] = useState(false)

  return (
    <div className={cx(fresh && 'animate-slide-in')}>
      <div className="flex items-stretch gap-1">
        <Strip
          as="button"
          tone={attached ? 'sel' : 'chip'}
          className="h-11 flex-1 hover:border-rule-2"
          aria-pressed={attached}
          onClick={() => {
            toggle(skill.id)
            onPicked?.()
          }}
          title={skill.description}
        >
          <Field className="pr-0">
            <Avatar name={skill.name} />
          </Field>
          <Field className="flex-1">
            <span className="truncate text-[14px] font-medium">{skill.name}</span>
          </Field>
          <Field className="w-8 justify-center px-0">
            {attached ? <Check className="size-4 text-accent-2" strokeWidth={2.5} /> : <span className="tabular font-mono text-[11px] text-fg-3">{skill.steps.length}</span>}
          </Field>
        </Strip>
        <button
          onClick={() => setOpen((o) => !o)}
          className="grid w-7 place-items-center rounded-lg text-fg-3 hover:bg-white/6 hover:text-fg"
          aria-label={`${open ? 'Hide' : 'Show'} steps for ${skill.name}`}
          aria-expanded={open}
        >
          <ChevronDown className={cx('size-3.5 transition', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div className="animate-slide-in pt-1 pb-2">
          <div className="flex items-center gap-2 px-2 py-1 font-mono text-[11px] text-fg-3">
            <span className="truncate">{skill.site.url ? hostOf(skill.site.url) : 'Choose a site in your task'}</span>
            <span className="ml-auto shrink-0">
              {skill.runs !== undefined && `${skill.runs} runs`}{skill.runs !== undefined && skill.createdAt && ' · '}{skill.createdAt && timeAgo(skill.createdAt)}
            </span>
          </div>
          <SkillHistory stats={stats} />
          <StepList steps={skill.steps} />
          <button onClick={() => void del(skill.id)} className="mt-1 flex h-7 items-center gap-1.5 rounded px-2 text-[12px] text-fg-3 hover:text-heal">
            <Trash2 className="size-3" /> Delete
          </button>
        </div>
      )}
    </div>
  )
}

/** What the skill has done so far: sites it worked on, success rate, phrases it picked up. */
function SkillHistory({ stats }: { stats?: SkillStats }) {
  const rate = successRate(stats)
  const sites = Object.entries(stats?.sites ?? {})
  if (!rate && !stats?.phrases.length) return null
  return (
    <div className="mb-2 space-y-2 rounded-lg bg-panel/70 px-2.5 py-2 ring-1 ring-rule">
      {rate && (
        <div>
          <div className="flex items-baseline justify-between text-[12px]">
            <span className="text-fg-2">Finished on {rate.ok} of {rate.tries} sites</span>
            <span className="tabular font-mono text-[11px] text-fg-3">{Math.round((rate.ok / rate.tries) * 100)}%</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-chip">
            <div className="h-full rounded-full bg-exact" style={{ width: `${(rate.ok / rate.tries) * 100}%` }} />
          </div>
        </div>
      )}
      {sites.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sites.map(([name, s]) => (
            <span key={name} className="flex items-center gap-1 rounded bg-chip px-1.5 py-0.5 text-[11px] text-fg-2" title={`${s.ok} of ${s.tries} finished`}>
              <span className={cx('size-1.5 rounded-full', s.ok === s.tries ? 'bg-exact' : s.ok ? 'bg-fuzzy' : 'bg-heal')} />
              {name}
            </span>
          ))}
        </div>
      )}
      {!!stats?.phrases.length && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span className="text-fg-3">Learned</span>
          {stats.phrases.map((p) => (
            <span key={p} className="rounded bg-fuzzy/10 px-1.5 py-0.5 text-fuzzy">“{p}”</span>
          ))}
        </div>
      )}
    </div>
  )
}

export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="mt-1 border-l border-rule pl-3">
      {steps.map((s) => (
        <li key={s.id} className="flex items-baseline gap-2 py-[3px] text-[12.5px] text-fg-2">
          <span className="flex-1">{s.description}</span>
          {s.slot && <span className="font-mono text-[10.5px] text-accent-2">{s.slot}</span>}
        </li>
      ))}
    </ol>
  )
}
