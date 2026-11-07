import { useEffect, useState } from 'react'
import { PanelLeft, SquarePen, X } from 'lucide-react'
import { useStore } from './store'
import { Logo, Rail } from './components/Rail'
import { Composer, Thread } from './components/Chat'
import { cx } from './lib/ui'

export default function App() {
  const loadSkills = useStore((s) => s.loadSkills)
  const hasMessages = useStore((s) => s.messages.length > 0)
  const newChat = useStore((s) => s.newChat)
  const [drawer, setDrawer] = useState(false)
  useRunStatusInTitle()

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  useEffect(() => () => useStore.getState().dispose(), [])

  return (
    <div className="flex h-full">
      <div className="hidden w-[300px] shrink-0 border-r border-rule lg:block">
        <Rail />
      </div>

      {/* Narrow windows (common beside a Playwright browser): rail becomes a drawer */}
      <div className={cx('fixed inset-0 z-40 lg:hidden', drawer ? 'pointer-events-auto' : 'pointer-events-none')}>
        <div className={cx('absolute inset-0 bg-black/50 transition-opacity', drawer ? 'opacity-100' : 'opacity-0')} onClick={() => setDrawer(false)} />
        <div className={cx('absolute inset-y-0 left-0 w-[86%] max-w-[300px] transition-transform duration-300', drawer ? 'translate-x-0' : '-translate-x-full')}>
          <button onClick={() => setDrawer(false)} className="absolute top-3.5 right-3 z-10 grid size-8 place-items-center rounded text-fg-3 hover:text-fg" aria-label="Close skills">
            <X className="size-4" />
          </button>
          <Rail onPicked={() => setDrawer(false)} />
        </div>
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4 md:px-8">
          <button onClick={() => setDrawer(true)} className="flex h-9 items-center gap-2 rounded px-2 text-[13px] text-fg-2 hover:text-fg lg:hidden">
            <PanelLeft className="size-4" />
            <Logo size={22} />
          </button>
          {hasMessages && (
            <button onClick={newChat} className="ml-auto flex h-9 items-center gap-2 rounded px-2 text-[13px] text-fg-3 hover:text-fg">
              <SquarePen className="size-4" /> New task
            </button>
          )}
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Thread />
        </div>
        <Composer />
      </main>
    </div>
  )
}

/** Playwright windows cover this app during a run: mirror progress in the tab title and notify on finish. */
function useRunStatusInTitle() {
  const messages = useStore((s) => s.messages)
  const rec = useStore((s) => s.recording.status)
  const runs = messages.flatMap((m) => (m.role === 'assistant' && m.kind === 'run' ? [m.run] : []))
  const last = runs[runs.length - 1]
  const status = last?.status
  const done = last?.targets.filter((t) => t.status === 'ok').length ?? 0
  const total = last?.targets.length ?? 0

  useEffect(() => {
    if (rec === 'recording') document.title = '● REC · CopyCat'
    else if (status === 'running' || status === 'planning' || status === 'starting') document.title = `${done}/${total} · CopyCat`
    else if (status === 'done') document.title = '✓ Done · CopyCat'
    else document.title = 'CopyCat'
  }, [rec, status, done, total])

  useEffect(() => {
    if (status !== 'done' || !last?.summary) return
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification('CopyCat finished', { body: last.summary })
    }
  }, [status, last?.summary])
}
