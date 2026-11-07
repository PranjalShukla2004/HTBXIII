import asyncio, json, sys, time
import re, os
from typing import Callable, Optional
from .browser import launch
from .config import DATA
from .schemas import Trace, TraceEvent

RECORDER_JS = r"""
(() => {
  if (window.__recInstalled) return; window.__recInstalled = true;

  const CLICKABLE = 'a,button,summary,[onclick],[role=button],[role=link],[role=option],' +
                    '[role=radio],[role=tab],[role=menuitem],' +
                    'input[type=submit],input[type=button],input[type=image]';
  const FORM_CTRL = 'input,textarea,select';
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  const labelOf = el => {
    if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
    const by = el.getAttribute('aria-labelledby');
    if (by) return clean(by.split(' ').map(id => document.getElementById(id)?.innerText || '').join(' '));
    return '';
  };

  const cssPath = el => {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      let s = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(s + '#' + el.id); break; }
      const cls = [...el.classList].slice(0, 2).join('.');
      if (cls) s += '.' + cls;
      parts.unshift(s);
      el = el.parentElement;
    }
    return parts.join(' > ');
  };

  const describe = el => {
    const ctx = el.closest('[class*=product],[class*=card],[class*=item],article,li,form') || el.parentElement;
    const d = {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      role: el.getAttribute('role'),
      name: el.getAttribute('name'),
      id: el.id || null,
      label: labelOf(el),
      aria_label: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'),
      title: el.getAttribute('title'),
      alt: el.getAttribute('alt') || el.querySelector?.('img')?.getAttribute('alt'),
      text: clean(el.innerText || el.value).slice(0, 100),
      href: el.getAttribute('href'),
      classes: typeof el.className === 'string' ? clean(el.className).slice(0, 80) : '',
      context: clean(ctx?.innerText).slice(0, 200),
      css: cssPath(el),
    };
    Object.keys(d).forEach(k => (d[k] == null || d[k] === '') && delete d[k]);
    return d;
  };

  const sensitive = el =>
    el.type === 'password' || (el.getAttribute('autocomplete') || '').startsWith('cc-');

  const send = ev => { try { window.__record({...ev, url: location.href, title: document.title}); } catch (e) {} };

  const pointerAncestor = el => {
    for (let i = 0; el && el.nodeType === 1 && i < 5; i++, el = el.parentElement)
      if (getComputedStyle(el).cursor === 'pointer') return el;
    return null;
  };

  // Clicks on buttons, links, product cards, swatches
  document.addEventListener('click', e => {
    const t = e.target;
    const ctrl = t.closest(FORM_CTRL);
    if (ctrl && !['submit', 'button', 'image'].includes(ctrl.type)) return;  // handled by 'change'
    const el = t.closest(CLICKABLE) || pointerAncestor(t);
    if (el) send({kind: 'click', el: describe(el)});
  }, true);

  // Typing, dropdowns, checkboxes/radios
  document.addEventListener('change', e => {
    const el = e.target;
    if (!el.matches || !el.matches(FORM_CTRL) || sensitive(el)) return;
    if (el.tagName === 'SELECT')
      send({kind: 'select', el: describe(el), value: clean(el.options[el.selectedIndex]?.text)});
    else if (el.type === 'checkbox' || el.type === 'radio')
      send({kind: 'check', el: describe(el), value: String(el.checked)});
    else
      send({kind: 'fill', el: describe(el), value: el.value});
  }, true);

  // Enter in a search box (often submits without a 'change' firing first)
  document.addEventListener('keydown', e => {
    const el = e.target;
    if (e.key !== 'Enter' || !el.matches || !el.matches('input') || sensitive(el)) return;
    send({kind: 'fill', el: describe(el), value: el.value});
    send({kind: 'press', el: describe(el), value: 'Enter'});
  }, true);
})();
"""

def _key(ev: dict):
    return ev.get("el", {}).get("css")

def clean_events(raw: list[dict]) -> list[dict]:
    """Remove the noise that real browsing produces."""
    out: list[dict] = []
    for ev in raw:
        prev = out[-1] if out else None
        # same value typed into the same box already recorded (Enter + later blur)
        if ev["kind"] == "fill" and any(
                p["kind"] == "fill" and _key(p) == _key(ev) and p.get("value") == ev.get("value")
                for p in out[-3:]):
            continue
        # keystroke-by-keystroke fills on one field -> keep the final value
        if prev and ev["kind"] == "fill" and prev["kind"] == "fill" and _key(prev) == _key(ev):
            out[-1] = ev; continue
        # clicking a <label>/swatch that toggled a radio/select -> keep the control change
        if prev and ev["kind"] in ("check", "select") and prev["kind"] == "click" and ev["t"] - prev["t"] < 1.0:
            out[-1] = ev; continue
        # redirect chains -> keep the final URL
        if prev and ev["kind"] == "navigate" and prev["kind"] == "navigate":
            out[-1] = ev; continue
        out.append(ev)
    return out

async def record(start_url: str, *,
                 on_event: Optional[Callable[[dict], None]] = None,
                 stop: Optional[asyncio.Event] = None) -> Trace:
    raw: list[dict] = []
    done = stop or asyncio.Event()

    def emit(payload: dict):
        if payload.get("kind") == "navigate" and payload["url"].startswith("about:"):
            return
        payload["t"] = time.time()
        payload.setdefault("el", {})
        raw.append(payload)
        if on_event:
            on_event(payload)

    async with launch(headless=False) as browser:
        context = await browser.new_context(viewport={"width": 1366, "height": 900})
        await context.expose_function("__record", emit)
        await context.add_init_script(RECORDER_JS)

        def watch(page):
            page.on("framenavigated",
                    lambda f: f == page.main_frame and emit({"kind": "navigate", "url": f.url}))
            page.on("close",
                    lambda _: all(p.is_closed() for p in context.pages) and done.set())

        context.on("page", watch)
        page = await context.new_page()
        await page.goto(start_url)
        await done.wait()

    events = [TraceEvent.model_validate(e) for e in clean_events(raw)]
    return Trace(start_url=start_url, events=events)

# ---------- CLI ----------
def _print(ev: dict):
    el = ev.get("el", {})
    what = el.get("label") or el.get("aria_label") or el.get("placeholder") or el.get("text") or el.get("css", "")
    print(f"[rec] {ev['kind']:8} {what[:50]!r:52} {ev.get('value') or ''}")

def _print(ev: dict):
    if ev["kind"] == "navigate":
        print(f"[rec] navigate -> {ev['url']}")
        return
    el = ev.get("el", {})
    what = el.get("label") or el.get("aria_label") or el.get("placeholder") or el.get("text") or el.get("css", "")
    print(f"[rec] {ev['kind']:8} {what[:50]!r:52} {ev.get('value') or ''}")

def _normalise_url(raw: str) -> str:
    m = re.search(r"\((https?://[^)]+)\)", raw)   # markdown link [text](url)
    url = m.group(1) if m else raw.strip("[]<> ")
    if not re.match(r"https?://", url):
        url = "https://" + url
    return url

async def _main():
    url = _normalise_url(sys.argv[1])
    name = sys.argv[2] if len(sys.argv) > 2 else "trace"
    stop = asyncio.Event()

    async def wait_for_enter():
        await asyncio.get_running_loop().run_in_executor(None, input)
        stop.set()

    print(f"Recording {url}. Do the task, then press Enter here (or close the window).")
    enter_task = asyncio.create_task(wait_for_enter())
    trace = await record(url, on_event=_print, stop=stop)
    enter_task.cancel()

    out = DATA / "traces" / f"{name}.json"
    out.write_text(trace.model_dump_json(indent=1))
    print(f"\nSaved {len(trace.events)} cleaned events to {out}")
    os._exit(0)   # the input() thread can't be cancelled; exit cleanly anyway

if __name__ == "__main__":
    asyncio.run(_main())