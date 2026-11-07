import json, re
from playwright.async_api import Page, Locator

POPUP_SCOPE = '[role=listbox],[role=menu],[role=dialog],[aria-modal=true],[class*=popover]'
PICKER_SCOPE = '[class*=size],[class*=Size],[data-qa*=size],[data-testid*=size],[aria-label*=size i]'

DESCRIBE_JS = r"""
(maxEls) => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  document.querySelectorAll('[data-agent-id]').forEach(e => e.removeAttribute('data-agent-id'));

  const SEL = 'input:not([type=hidden]),textarea,select,button,a[href],summary,[onclick],' +
              '[role=button],[role=link],[role=option],[role=radio],[role=tab],[role=combobox],' +
              '[role=searchbox],[role=spinbutton],[role=menuitem],[role=menuitemradio],[aria-haspopup]';
  const POPUP = '[role=listbox],[role=menu],[role=dialog],[aria-modal=true],[class*=popover]';
  const PICKER = '[class*=size],[class*=Size],[data-qa*=size],[data-testid*=size],[aria-label*=size i]';
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
      d.text = null;
      d.options = [...el.options].map(o => clean(o.text)).slice(0, 30);
      d.value = clean(el.options[el.selectedIndex]?.text || '');
      if (hiddenSelect) d.hidden = true;
    }
    const pop = el.getAttribute('aria-haspopup');
    if (pop && pop !== 'false') d.popup = pop;
    const exp = el.getAttribute('aria-expanded');
    if (exp) d.expanded = exp;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') d.disabled = true;
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

  const front = [], controls = [], links = [];
  const taken = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    const isVisible = visible(el);
    // styled shops often hide the real <select> behind a fake button: keep it anyway
    const hiddenSelect = !isVisible && el.tagName === 'SELECT' && !el.disabled && el.options.length > 1;
    if (!isVisible && !hiddenSelect) continue;
    const d = info(el, hiddenSelect);
    if (!d) continue;
    taken.add(el);
    const inPopup = isVisible &&
      (el.matches('[role=option],[role=menuitem],[role=menuitemradio]') || !!el.closest(POPUP));
    const inPicker = isVisible && !!el.closest(PICKER);
    if (inPopup) d.in_popup = true;
    if (inPicker) d.picker = true;
    if (inPopup || inPicker) front.push([el, d]);      // open dropdowns and size pickers go first
    else (d.tag === 'a' ? links : controls).push([el, d]);
  }

  // size/colour choices built from plain <li>/<div>s with click handlers (no button/link)
  for (const box of document.querySelectorAll(POPUP + ',' + PICKER)) {
    for (const el of box.querySelectorAll('li,div,span,label')) {
      if (front.length > 120) break;
      if (taken.has(el) || (el.parentElement && taken.has(el.parentElement))) continue;
      if (el.children.length > 3 || el.closest(SEL) || el.querySelector(SEL)) continue;
      const t = clean(el.innerText);
      if (!t || t.length > 30 || !visible(el) || getComputedStyle(el).cursor !== 'pointer') continue;
      const d = info(el, false);
      if (!d) continue;
      d.choice = true;
      d.picker = true;
      taken.add(el);
      front.push([el, d]);
    }
  }

  return front.concat(controls, links).slice(0, maxEls).map(([el, d], i) => {
    el.setAttribute('data-agent-id', String(i));
    d.id = i;
    return d;
  });
}
"""

CART_SIGNALS_JS = r"""
() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const out = [];
  document.querySelectorAll('[role=dialog],[role=alert],[role=status],[aria-live],[class*=minicart],' +
      '[class*=mini-cart],[class*=minibag],[class*=mini-bag],[class*=toast],[class*=notification],' +
      '[class*=added],[class*=Added]').forEach(el => {
    if (!vis(el)) return;
    const t = clean(el.innerText).slice(0, 300);
    if (t) out.push(t);
  });
  document.querySelectorAll('a,button,[aria-label]').forEach(el => {
    const lab = clean((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || ''));
    if (lab.length < 80 && /\b(bag|basket|cart|trolley)\b/i.test(lab) && vis(el)) out.push(lab);
  });
  return [...new Set(out)].slice(0, 25);
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

async def cart_signals(page: Page) -> list[str]:
    try:
        return await page.evaluate(CART_SIGNALS_JS)
    except Exception:
        return []

def format_elements(els: list[dict]) -> str:
    lines = []
    for d in els:
        head = f"[{d['id']}] {d['tag']}" + (f"[{d['type']}]" if d.get("type") else "")
        parts = [head]
        if d.get("hidden"):
            parts.append("(hidden native dropdown)")
        if d.get("in_popup"):
            parts.append("(in open popup)")
        if d.get("picker"):
            parts.append("(in size picker)")
        if d.get("choice"):
            parts.append("(clickable choice)")
        if d.get("disabled"):
            parts.append("(disabled)")
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

async def click_text(page: Page, text: str):
    """Click a visible element by its exact text, preferring size pickers and popups."""
    t = (text or "").strip()
    if not t:
        raise RuntimeError("no text to click")
    pattern = re.compile(r"^\s*" + re.escape(t) + r"\s*$", re.I)
    for scope in (page.locator(PICKER_SCOPE), page.locator(POPUP_SCOPE), page.locator("body")):
        loc = scope.get_by_text(pattern)
        try:
            n = await loc.count()
        except Exception:
            continue
        for k in range(min(n, 10)):
            item = loc.nth(k)
            try:
                if await item.is_visible():
                    await robust_click(page, item)
                    return
            except Exception:
                continue
    raise RuntimeError(f"no visible element with text {t!r}")

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