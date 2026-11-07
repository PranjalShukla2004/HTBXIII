import json, re
from playwright.async_api import Page, Locator

DESCRIBE_JS = r"""
(maxEls) => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  document.querySelectorAll('[data-agent-id]').forEach(e => e.removeAttribute('data-agent-id'));

  const SEL = 'input:not([type=hidden]),textarea,select,button,a[href],summary,[onclick],' +
              '[role=button],[role=link],[role=option],[role=radio],[role=tab],[role=combobox],' +
              '[role=searchbox],[role=spinbutton],[role=menuitem],[role=menuitemradio],[aria-haspopup]';
  const POPUP = '[role=listbox],[role=menu],[role=dialog],[aria-modal=true],[class*=popover]';
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const labelOf = el => {
    if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
    const by = el.getAttribute('aria-labelledby');
    return by ? clean(by.split(' ').map(id => document.getElementById(id)?.innerText || '').join(' ')) : '';
  };

  const seen = new Set();
  const info = (el, hiddenSelect) => {
    const tag = el.tagName.toLowerCase();
    const d = {
      tag, type: el.getAttribute('type'), role: el.getAttribute('role'),
      label: labelOf(el), aria: el.getAttribute('aria-label'), ph: el.getAttribute('placeholder'),
      title: el.getAttribute('title'), name: el.getAttribute('name'),
      text: clean(el.innerText || (el.type !== 'password' ? el.value : '')).slice(0, 80),
      img: el.querySelector('img')?.getAttribute('alt'),
      href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 80) : null,
    };
    if ((tag === 'input' || tag === 'textarea') && el.type !== 'password') d.value = clean(el.value).slice(0, 40);
    if (tag === 'select') {
      d.text = null;                                   // options list says it all
      d.options = [...el.options].map(o => clean(o.text)).slice(0, 30);
      d.value = clean(el.options[el.selectedIndex]?.text || '');
      if (hiddenSelect) d.hidden = true;
    }
    const pop = el.getAttribute('aria-haspopup');
    if (pop && pop !== 'false') d.popup = pop;
    const exp = el.getAttribute('aria-expanded');
    if (exp) d.expanded = exp;
    if (tag === 'a' || tag === 'button' || el.matches('[onclick],[role=button]')) {
      const card = el.closest('[class*=product],[class*=card],[class*=item],article,li');
      const ctx = card ? clean(card.innerText).slice(0, 120) : '';
      if (ctx && ctx !== d.text) d.ctx = ctx;
    }
    Object.keys(d).forEach(k => (d[k] == null || d[k] === '') && delete d[k]);
    if (tag === 'a') {
      if (!d.text && !d.img && !d.aria && !d.title) return null;
      const key = [d.text, d.href, d.img].join('|');
      if (seen.has(key)) return null;
      seen.add(key);
    }
    return d;
  };

  const popup = [], controls = [], links = [];
  for (const el of document.querySelectorAll(SEL)) {
    const isVisible = visible(el);
    // styled shops often hide the real <select> behind a fake button: keep it anyway
    const hiddenSelect = !isVisible && el.tagName === 'SELECT' && !el.disabled && el.options.length > 1;
    if (!isVisible && !hiddenSelect) continue;
    const d = info(el, hiddenSelect);
    if (!d) continue;
    const inPopup = isVisible &&
      (el.matches('[role=option],[role=menuitem],[role=menuitemradio]') || el.closest(POPUP));
    if (inPopup) {
      d.in_popup = true;
      popup.push([el, d]);                             // open dropdown options go first
    } else {
      (d.tag === 'a' ? links : controls).push([el, d]);
    }
  }
  return popup.concat(controls, links).slice(0, maxEls).map(([el, d], i) => {
    el.setAttribute('data-agent-id', String(i));
    d.id = i;
    return d;
  });
}
"""

SETTLE_JS = r"""
(maxMs) => new Promise(resolve => {
  let quiet = setTimeout(done, 400);
  const hard = setTimeout(done, maxMs);
  const obs = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, 400); });
  function done() { obs.disconnect(); clearTimeout(quiet); clearTimeout(hard); resolve(); }
  obs.observe(document.documentElement, {childList: true, subtree: true, attributes: true});
})
"""

CONSENT = re.compile(
    r"^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree( and (close|continue))?|"
    r"got it|ok(ay)?|consent|i accept|accept (and|&) close|yes,? i agree|accept all & close)\s*$", re.I)
CLOSE_SEL = ('[aria-label="Close" i], [aria-label="Dismiss" i], [aria-label="close dialog" i], '
             'button.close, .modal .close, #dismiss-button')

async def describe_page(page: Page, max_elements: int = 200) -> list[dict]:
    return await page.evaluate(DESCRIBE_JS, max_elements)

def format_elements(els: list[dict]) -> str:
    lines = []
    for d in els:
        head = f"[{d['id']}] {d['tag']}" + (f"[{d['type']}]" if d.get("type") else "")
        parts = [head]
        if d.get("hidden"):
            parts.append("(hidden native dropdown)")
        if d.get("in_popup"):
            parts.append("(in open popup)")
        for k in ("role", "label", "aria", "ph", "title", "text", "img", "name", "value"):
            if d.get(k):
                parts.append(f'{k}="{d[k]}"')
        if d.get("popup"):
            parts.append(f'haspopup={d["popup"]}')
        if d.get("expanded"):
            parts.append(f'expanded={d["expanded"]}')
        if d.get("options"):
            parts.append("options=" + json.dumps(d["options"]))
        if d.get("href"):
            parts.append(f"href={d['href']}")
        if d.get("ctx"):
            parts.append(f'ctx="{d["ctx"]}"')
        lines.append(" ".join(parts))
    return "\n".join(lines)

async def settle(page: Page, max_ms: int = 4000):
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=max_ms)
    except Exception:
        pass
    try:
        await page.evaluate(SETTLE_JS, max_ms)
    except Exception:
        pass          # navigation mid-wait destroys the context; that's fine

async def _click_first_visible(loc: Locator) -> bool:
    try:
        n = await loc.count()
        for i in range(min(n, 3)):
            item = loc.nth(i)
            if await item.is_visible():
                await item.click(timeout=1500)
                return True
    except Exception:
        pass
    return False

async def dismiss_overlays(page: Page, aggressive: bool = False) -> bool:
    """Click cookie/consent buttons (all frames). Aggressive: also Escape + close buttons."""
    clicked = False
    for frame in page.frames:
        if await _click_first_visible(frame.get_by_role("button", name=CONSENT)):
            clicked = True
            break
    if aggressive:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        for frame in page.frames:
            if await _click_first_visible(frame.locator(CLOSE_SEL)):
                clicked = True
                break
    if clicked:
        await page.wait_for_timeout(300)
    return clicked

async def _click_landed(page: Page, el: Locator, url_before: str) -> bool:
    """After a click 'fails', check whether it actually worked (page moved on)."""
    try:
        return page.url != url_before or await el.count() == 0
    except Exception:
        return True          # page was navigating while we checked

async def robust_click(page: Page, el: Locator):
    url_before = page.url
    try:
        await el.click(timeout=6000)
        return
    except Exception:
        if await _click_landed(page, el, url_before):
            return           # click worked; the next page was just slow to load
    await dismiss_overlays(page, aggressive=True)
    for attempt in (lambda: el.click(timeout=3000),
                    lambda: el.click(force=True, timeout=3000),
                    lambda: el.evaluate("e => e.click()", timeout=3000)):
        try:
            await attempt()
            return
        except Exception:
            if await _click_landed(page, el, url_before):
                return
    raise RuntimeError("could not click the element (covered by something or removed)")

def _q(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')

async def resolve_locator(page: Page, loc: dict):
    """Find a previously used element again from its saved semantic description."""
    tag = loc.get("tag", "*")
    cands = []
    if loc.get("label"):
        cands.append(page.get_by_label(loc["label"], exact=True))
    if loc.get("ph"):
        cands.append(page.get_by_placeholder(loc["ph"], exact=True))
    if loc.get("aria"):
        cands.append(page.locator(f'{tag}[aria-label="{_q(loc["aria"])}"]'))
    if loc.get("name"):
        cands.append(page.locator(f'{tag}[name="{_q(loc["name"])}"]'))
    if loc.get("href") and tag == "a":
        cands.append(page.locator(f'a[href="{_q(loc["href"])}"]'))
    if loc.get("text") and tag not in ("input", "textarea", "select"):
        cands.append(page.locator(tag).filter(
            has_text=re.compile(r"^\s*" + re.escape(loc["text"]) + r"\s*$")))
    if loc.get("text") and (tag == "button" or loc.get("type") in ("button", "submit")):
        cands.append(page.get_by_role("button", name=loc["text"], exact=True))
    if loc.get("text") and tag == "input":
        cands.append(page.locator(f'input[value="{_q(loc["text"])}"]'))
    state = "attached" if tag == "select" else "visible"     # selects may be hidden on purpose
    for c in cands:
        try:
            first = c.first
            await first.wait_for(state=state, timeout=2000)
            return first
        except Exception:
            continue
    return None

async def _select(el: Locator, value: str | None):
    """Pick an option on a (possibly hidden) <select>, tolerating labels like 'Qty: 2'."""
    v = (value or "").strip()
    for kwargs in ({"label": v}, {"value": v}):
        for force in (False, True):
            try:
                await el.select_option(**kwargs, force=force, timeout=3000)
                return
            except Exception:
                pass
    opts = await el.evaluate("s => [...s.options].map(o => ({t: o.text.trim(), v: o.value}))")
    for o in opts:
        hit = (re.search(rf"(^|\D){re.escape(v)}(\D|$)", o["t"]) if v.isdigit()
               else v.lower() in o["t"].lower())
        if hit:
            await el.select_option(value=o["v"], force=True, timeout=3000)
            return
    raise RuntimeError(f"no option matching {v!r} in dropdown")

async def act(page: Page, element: dict, op: str, value: str | None = None):
    el = page.locator(f'[data-agent-id="{element["id"]}"]').first
    await act_on(page, el, element["tag"], op, value)

async def act_on(page: Page, el: Locator, tag: str, op: str, value: str | None = None):
    if tag == "select":                          # before scrolling: hidden selects can't scroll
        await _select(el, value)
        return
    try:
        await el.scroll_into_view_if_needed(timeout=3000)
    except Exception:
        pass
    if op in ("fill", "search") and tag in ("input", "textarea"):
        await el.fill(value or "")
        if op == "search":
            await el.press("Enter")
        return
    if op == "check":
        await el.set_checked(str(value).lower() not in ("false", "no", "0"))
        return
    if op == "press":
        await el.press(value or "Enter")
        return
    await robust_click(page, el)

async def page_text(page: Page, limit: int = 4000) -> str:
    text = await page.evaluate("() => document.body ? document.body.innerText : ''")
    return re.sub(r"\s+", " ", text)[:limit]