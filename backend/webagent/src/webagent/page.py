import json, re
from playwright.async_api import Page, Locator

DESCRIBE_JS = r"""
(maxEls) => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  document.querySelectorAll('[data-agent-id]').forEach(e => e.removeAttribute('data-agent-id'));

  const SEL = 'input:not([type=hidden]),textarea,select,button,a[href],summary,[onclick],' +
              '[role=button],[role=link],[role=option],[role=radio],[role=tab],[role=combobox],[role=searchbox],[role=spinbutton]';
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
  const info = el => {
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
    if (tag === 'select') d.options = [...el.options].map(o => clean(o.text)).slice(0, 25);
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

  const controls = [], links = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    const d = info(el);
    if (d) (d.tag === 'a' ? links : controls).push([el, d]);
  }
  return controls.concat(links).slice(0, maxEls).map(([el, d], i) => {
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
        for k in ("label", "aria", "ph", "title", "text", "img", "name", "value"):
            if d.get(k):
                parts.append(f'{k}="{d[k]}"')
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

async def robust_click(page: Page, el: Locator):
    try:
        await el.click(timeout=4000); return
    except Exception:
        pass
    await dismiss_overlays(page, aggressive=True)
    try:
        await el.click(timeout=3000); return
    except Exception:
        pass
    try:
        await el.click(force=True, timeout=3000); return
    except Exception:
        pass
    await el.evaluate("e => e.click()")

async def act(page: Page, element: dict, op: str, value: str | None = None):
    el = page.locator(f'[data-agent-id="{element["id"]}"]').first
    tag = element["tag"]
    try:
        await el.scroll_into_view_if_needed(timeout=3000)
    except Exception:
        pass

    if tag == "select":                                   # dropdown, whatever the step called it
        try:
            await el.select_option(label=value)
        except Exception:
            await el.select_option(value=value)
        return
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
    await robust_click(page, el)                          # click / navigate_to / custom pickers

async def page_text(page: Page, limit: int = 4000) -> str:
    text = await page.evaluate("() => document.body ? document.body.innerText : ''")
    return re.sub(r"\s+", " ", text)[:limit]