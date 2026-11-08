import asyncio, hashlib, json, re, sys
from typing import Awaitable, Callable, Optional
from urllib.parse import urlparse
from playwright.async_api import BrowserContext, Page
from .abstract import VAR, FORBIDDEN
from .browser import launch
from .config import DATA
from .llm import llm_json, stats
from .page import (describe_page, format_elements, act, act_on, resolve_locator,
                   settle, page_text, dismiss_overlays, click_text, cart_signals)
from .schemas import IntentProgram, SiteResult, Binding, AgentEvent

MAX_HOPS = 3
MAX_REPEAT = 20
MAX_ASKS = 3
PAGE_CHANGING = {"search", "click", "press", "click_text"}
CACHE_KEYS = ("tag", "type", "label", "aria", "ph", "name", "text", "href")
QTY_VAR = re.compile(r"qty|quantit", re.I)
SEARCHY = re.compile(r"search|magnif|find", re.I)
SHOP_WORDS = re.compile(r"\b(cart|basket|bag|trolley)\b", re.I)

def is_shopping(program: "IntentProgram") -> bool:
    """Basket checks, sizes and quantities only make sense for add-to-basket skills."""
    return any(SHOP_WORDS.search(s.target or "") for s in program.steps)

AskFn = Callable[[str, str, list[str]], Awaitable[Optional[str]]]

CART_CHECK = ("The product was just added to the shopping basket/bag: a confirmation message or popup, "
              "a mini-basket/side panel showing the item, or a basket/bag count above zero. "
              "If a size/colour picker is still waiting for a choice, or a message like "
              "'please select a size' is shown, it was NOT added.")

GROUND_SYSTEM = """You operate a web browser on a website you have never seen before: an online
shop, an email client (Gmail, Outlook, ...) or another web app. You get the remaining steps
of a site-independent program, the current page, and a numbered list of the page's
interactive elements.

Plan the actions to take ON THIS PAGE, starting with the FIRST remaining step. Continue
with the following steps only while they can be done on this same page, and STOP after
any action that loads a new page or substantially changes it (submitting a search,
opening a product, adding to cart, opening the basket, opening a new email, sending).

Return ONLY JSON:
{"actions": [
  {"step": <the step number exactly as shown in brackets>,
   "status": "ok" | "partial" | "move" | "already_done" | "not_found" | "needs_input" | "needs_human",
   "element_id": integer or null,
   "action": "fill" | "search" | "select" | "click" | "click_text" | "check" | "press" | null,
   "value": string or null,
   "repeat": integer,
   "question": string or null,
   "field": string or null,
   "options": [string, ...] or null,
   "reason": "short explanation"}
]}

Status:
- ok: performing this action completes the step.
- partial: this action is needed but the step is not finished yet (e.g. opening a custom
  dropdown before its option can be chosen, clicking a search icon that only opens the
  search box, or clicking add-to-basket to open a size picker). It must be the LAST action.
- move: the step cannot be done here, but element_id leads to a page where it can
  (e.g. a "Products"/"Shop" link to reach a search box). It must be the LAST action.
- already_done: the page already satisfies the step (e.g. already on the home page,
  quantity already equals value, the basket already shows the item).
- not_found: nothing here does the step and nothing obviously leads to it.
- needs_input: the page shows a choice the shopper must make that the variables and
  USER CHOICES don't answer - most often a SIZE, sometimes colour or fit. Only use this
  when the choices are actually VISIBLE (a size picker is open, size options are listed,
  or "please select a size" is shown). If no choices are visible yet, click the
  add-to-basket button with status "partial" instead: shops often show sizes only after
  that click. Set "question" (short, addressed to the shopper), "field" (snake_case, e.g.
  "size") and "options" (the EXACT texts of the available choices; skip ones marked
  unavailable, disabled or out of stock). NEVER pick a size yourself. It must be the ONLY action.
- needs_human: a CAPTCHA, login wall, "Access Denied" page or age gate blocks progress.

Choose the action from the ELEMENT you found, not from the step's wording:
- text or number input -> "fill"; the shop's search box -> "search" (types and presses Enter)
- a search step is only ok once the query is typed and submitted; clicking a search icon
  or link that just opens the search box is "click" with status "partial"
- if the shop has NO search box, a category or menu link matching the query (e.g. "Laptops"
  for "laptop") does the search step: "click" it with status "ok". This includes categories
  that filter the page in place without changing the URL. Never click the same category twice.
- <select> -> "select", value = the EXACT option text from its options list (options may
  read like "Qty: 2" or "2 items"; return that exact text). This includes elements marked
  "(hidden native dropdown)": shops often hide the real <select> behind a styled button.
  ALWAYS prefer the hidden <select> over the styled button; one "select" action completes
  the step. If its current value already equals the target -> already_done.
- custom dropdown with no <select> (a button with haspopup, expanded=false, or text like
  "Quantity: 1") -> "click" it with status "partial". On the next look its choices appear
  marked "(in open popup)": "click" the one matching the value with status "ok".
- size options marked "(in size picker)" or "(clickable choice)" -> "click" the one matching
  USER CHOICES. Ignore ones marked "(disabled)".
- if the option you need is visible in the page but NOT in the element list, use
  "click_text" with element_id null and value = its exact visible text (e.g. "10")
- once you have clicked add-to-basket and a size picker is open, do NOT click add-to-basket
  again: choose the size (click / click_text), or return needs_input with the options
- quantity shown with +/- buttons -> "click" the + button with repeat = target minus the
  current value; if the current value already equals the target -> already_done
- no quantity control at all on the product page -> not_found (the step is optional)
- rich text areas marked "(editable text)", e.g. an email body -> "fill" with the text
- an email's recipient/To field -> "fill" with the address (it may turn into a chip: fine)
- the new email window may take a moment to open: if the compose fields are not visible
  yet but a "New mail"/"Compose" button is, click it with status "partial"
- checkbox/radio -> "check" with value "true" or "false"
- buttons, links, product tiles, colour/size swatches -> "click"

Rules:
- USER CHOICES in the prompt are answers the shopper already gave. Use them: map to the
  closest available option (e.g. "M" -> "M (UK 10)", "32" -> "W32"). Only ask again
  (needs_input) if no available option is reasonably close.
- USER CHOICES can also be constraints such as max_price, budget, brand or colour: when
  choosing a product, pick one that satisfies them (compare the prices shown in ctx). If
  none does, pick the closest and say so in "reason".
- The add-to-basket step only makes sense on a single product's page. If you are on a home,
  search or category page instead, return "move" with the product that best matches the
  item (and USER CHOICES) to open its page.
- If a NOTE is given, follow it: it explains what went wrong on the previous attempt.
- Match by meaning: "Add to basket", "Add to bag", "Add", "Buy" (on a product page) all
  mean add to cart.
- To pick a product, compare the step with the element's text and ctx (its product card).
- Prefer the main content over header/footer, except the site search box.
- If a cookie/consent banner blocks everything, return move with its accept button.
- NEVER choose anything leading to checkout, payment, login, registration or an account.
"""

VERIFY_SYSTEM = """You check whether a condition holds on a web page, given its visible text.
Return ONLY JSON: {"passed": true|false, "evidence": "short quote or reason"}"""

EXTRACT_SYSTEM = """You extract data from a product web page.
Given field descriptions, the page's visible text and its links, return each field's value.
Return ONLY JSON: {"values": {"<field>": "<value or null>"}}
- Prices: the main product's price with its currency symbol exactly as shown
  (not related products, not the basket total).
- Links: return the full href exactly as listed; null if there is no matching link.
- Never invent values; use null when the data is not on the page."""

LINKS_JS = r"""() => [...document.querySelectorAll('a[href]')]
  .filter(a => a.offsetParent !== null)
  .map(a => ({text: (a.innerText || a.title || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
              href: a.href}))
  .filter(l => l.text && l.href.startsWith('http'))
  .slice(0, 150)"""

class StepFailed(Exception):
    pass

def render(s: Optional[str], variables: dict) -> Optional[str]:
    return VAR.sub(lambda m: variables.get(m.group(1), m.group(0)), s) if s else s

def slug(url: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", urlparse(url).netloc.lower()).strip("_")

def forbidden(el: dict) -> bool:
    return bool(FORBIDDEN.search(" ".join(str(el.get(k, "")) for k in ("text", "aria", "title", "href"))))

def semantic(el: Optional[dict]) -> dict:
    return {k: el[k] for k in CACHE_KEYS if el.get(k)} if el else {}

def _step_index(a: dict, default: int) -> int:
    try:
        return int(str(a.get("step")).strip("[] "))
    except (TypeError, ValueError):
        return default

def _qty_target(step, vars_: dict) -> int:
    """If this step sets a quantity variable, return the requested number (else 1)."""
    for r in VAR.findall(step.value or ""):
        if QTY_VAR.search(r):
            try:
                return max(1, int(str(vars_.get(r, "1")).strip()))
            except ValueError:
                return 1
    return 1

# ---------- cache ----------
def cache_path(program: IntentProgram, url: str):
    key = hashlib.sha1(program.model_dump_json().encode()).hexdigest()[:10]
    return DATA / "cache" / f"{key}_{slug(url)}.json"

def load_cache(program: IntentProgram, url: str) -> dict:
    p = cache_path(program, url)
    try:
        return json.loads(p.read_text()) if p.exists() else {}
    except Exception:
        return {}

def cacheable(step, acts: list[dict]) -> bool:
    """Replayable only if the step doesn't depend on the item or on a user's answer."""
    return ("{{" not in step.target
            and not any(a["action"] == "click" and a.get("repeat", 1) > 1 for a in acts)
            and not any(a.get("answer") or not a.get("locator") for a in acts))

async def replay_step(page: Page, acts: list[dict], value: Optional[str], *,
                      on_action: Optional[Callable[[dict], None]] = None) -> bool:
    for a in acts:
        if a["action"] == "click_text":
            try:
                await click_text(page, a.get("value") or "")
            except Exception:
                return False
            await settle(page)
            continue
        loc = await resolve_locator(page, a["locator"])
        if loc is None:
            return False
        v = (value or a.get("value")) if a["action"] in ("fill", "search", "select") and a["status"] == "ok" \
            else a.get("value")
        repeat = max(1, a.get("repeat", 1))
        for repetition in range(repeat):
            try:
                await act_on(page, loc, a["locator"].get("tag", ""), a["action"], v)
            except Exception:
                return False
            if on_action:
                on_action({"op": a["action"], "value": v, "element": a["locator"],
                           "url": page.url, "cached": True, "repeat": repeat,
                           "repetition": repetition + 1,
                           "navigation_hop": a["status"] == "move",
                           "partial": a["status"] == "partial"})
        await settle(page)
    return True

# ---------- LLM helpers ----------
async def ground(page: Page, program: IntentProgram, window: list[int], vars_: dict,
                 els: list[dict], *, answers: Optional[dict] = None, hint: str = "") -> list[dict]:
    lines = []
    for k in window:
        s = program.steps[k]
        v = render(s.value, vars_)
        lines.append(f"[{k}] {s.op}: {render(s.target, vars_)}"
                     + (f"  value={v}" if v else "") + ("  (optional)" if s.optional else ""))
    extra = ""
    if answers:
        extra += ("USER CHOICES (already answered by the shopper; use them, don't ask again): "
                  + ", ".join(f"{k}={v}" for k, v in answers.items()) + "\n")
    if hint:
        extra += f"NOTE: {hint}\n"
    u = urlparse(page.url)
    user = (f"OVERALL GOAL: {render(program.goal, vars_)}\n\n"
            + (extra + "\n" if extra else "")
            + "REMAINING STEPS (start with the first):\n" + "\n".join(lines) + "\n\n"
            f"PAGE: title={await page.title()!r} path={u.path}{'?' + u.query if u.query else ''}\n"
            f"ELEMENTS:\n{format_elements(els)}")
    out = await llm_json(GROUND_SYSTEM, user, tag="ground")
    return (out.get("actions", []) if isinstance(out, dict) else out) or []

async def verify(page: Page, condition: str, limit: int = 4000) -> dict:
    text = await page_text(page, limit=limit)
    return await llm_json(VERIFY_SYSTEM, f"CONDITION: {condition}\n\nPAGE TEXT:\n{text}",
                          tag="verify", cheap=True)

FORM_TEXT_JS = r"""() => [...document.querySelectorAll('input,textarea,[contenteditable=""],[contenteditable="true"]')]
  .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
  .map(e => (e.isContentEditable ? e.innerText : e.value) || '').join(' \n ')"""

async def verify_outcome(page: Page, condition: str, typed: Optional[list[str]] = None) -> dict:
    """Final check for non-shopping skills. If the text typed into the form (subject, body, ...)
    is no longer in any visible field, the form was submitted (e.g. the email was sent and the
    compose window closed). Otherwise ask the model, using toasts/status messages and page text."""
    await page.wait_for_timeout(1500)
    typed = [t.strip().lower() for t in (typed or []) if t and len(t.strip()) >= 2]
    if typed:
        try:
            fields = (await page.evaluate(FORM_TEXT_JS)).lower()
            if not any(t in fields for t in typed):
                return {"passed": True, "evidence": "the form closed and the typed text is gone"}
        except Exception:
            pass
    signals = await cart_signals(page)
    text = await page_text(page, limit=5000)
    user = (f"CONDITION: {condition}\n"
            "HOW TO JUDGE: if the last action submitted a form or sent a message, it worked when "
            "the form/compose window has closed or been cleared, or a 'sent' message shows. It did "
            "NOT work if the form still shows the typed recipient/subject/text, an error, or a "
            "recipient that was not accepted.\n\nNOTIFICATIONS AND STATUS MESSAGES:\n"
            + ("\n".join(f"- {s}" for s in signals) or "- (none found)")
            + f"\n\nPAGE TEXT:\n{text}")
    return await llm_json(VERIFY_SYSTEM, user, tag="verify", cheap=True)

async def verify_cart(page: Page) -> dict:
    """Basket check: popups/toasts/basket icons first, then the page text."""
    await page.wait_for_timeout(1500)             # "added" popups often animate in late
    signals = await cart_signals(page)
    text = await page_text(page, limit=5000)
    user = (f"CONDITION: {CART_CHECK}\n\n"
            "BASKET SIGNALS (popups, notifications, basket/bag icons):\n"
            + ("\n".join(f"- {s}" for s in signals) or "- (none found)")
            + f"\n\nPAGE TEXT:\n{text}")
    return await llm_json(VERIFY_SYSTEM, user, tag="verify_cart", cheap=True)

async def extract(page: Page, fields: dict[str, str]) -> dict:
    text = await page_text(page, limit=5000)
    links = await page.evaluate(LINKS_JS)
    user = ("FIELDS:\n" + "\n".join(f"- {k}: {v}" for k, v in fields.items()) +
            f"\n\nPAGE URL: {page.url}\n\nPAGE TEXT:\n{text}\n\nLINKS:\n" +
            "\n".join(f"{l['text']} -> {l['href']}" for l in links))
    out = await llm_json(EXTRACT_SYSTEM, user, tag="extract", cheap=True)
    vals = out.get("values", {}) if isinstance(out, dict) else {}
    return {k: vals.get(k) for k in fields}

# ---------- runner ----------
async def run_program(ctx: BrowserContext, url: str, program: IntentProgram, *,
                      variables: Optional[dict] = None,
                      on_event: Optional[Callable[[AgentEvent], None]] = None,
                      on_action: Optional[Callable[[dict], None]] = None,
                      page: Optional[Page] = None,
                      run_tag: Optional[str] = None,
                      ask: Optional[AskFn] = None,
                      answers: Optional[dict] = None) -> SiteResult:
    """ask(field, question, options) -> answer or None. answers: shared dict of the shopper's
    choices (e.g. {"size": "M"}); pass the same dict to every shop in a run to ask only once."""
    answers = answers if answers is not None else {}
    vars_ = {**program.variables, **(variables or {}), **answers}
    steps = program.steps
    verify_idx = [k for k, s in enumerate(steps) if s.op == "verify"]
    final_verify = verify_idx[-1] if verify_idx else None
    action_idx = [k for k, s in enumerate(steps) if s.op not in ("verify", "extract")]
    add_step = action_idx[-1] if action_idx else None
    shopping = is_shopping(program)
    if not shopping:
        add_step = None          # no basket check / extra adds; the skill's own final verify runs
    result = SiteResult(url=url, status="navigating", variables=vars_)
    cache = load_cache(program, url)
    performed: dict[int, list[dict]] = {}
    answered_steps: set[int] = set()
    step_hint: dict[int, str] = {}      # per-step nudges for the model
    nudges: dict[int, int] = {}
    last_partial: dict[int, str] = {}
    guards: dict[int, int] = {}

    def emit(kind, message, **data):
        if on_event:
            on_event(AgentEvent(kind=kind, site=url, message=message, data=data))

    def nudge(i: int, text: str, log: str) -> bool:
        """Re-plan step i with a hint instead of failing. False once used up."""
        if nudges.get(i, 0) >= 2:
            return False
        nudges[i] = nudges.get(i, 0) + 1
        step_hint[i] = text
        emit("log", log, step=i)
        return True

    own_page = page is None
    if own_page:
        page = await ctx.new_page()
    try:
        await page.bring_to_front()
        await page.goto(url, wait_until="domcontentloaded")
        await settle(page)
        await dismiss_overlays(page)
        result.status = "acting"
        emit("status", "acting", cached=bool(cache))

        i, hops, last_reason = 0, 0, ""
        hint, cart_checked, cart_retries, extra_adds, repeating, asks = "", False, 0, 0, False, 0

        while True:
            while i < len(steps):
                if repeating and i > add_step:
                    break                                   # extra adds: only redo add-to-basket
                step = steps[i]

                if step.op == "extract":
                    j, fields = i, {}
                    while j < len(steps) and steps[j].op == "extract":
                        fields[steps[j].output or f"field_{j}"] = render(steps[j].target, vars_)
                        j += 1
                    if shopping:                            # the results table always wants these
                        fields.setdefault("product_name", "the main product's name")
                        fields.setdefault("price", "the main product's price with currency symbol")
                    vals = await extract(page, fields)
                    result.outputs.update(vals)
                    result.outputs.setdefault("product_url", page.url)
                    emit("step", f"extract {vals}", step=i, outputs=vals)
                    i = j
                    continue

                if step.op == "verify":
                    # the basket check after adding replaces the skill's own verify steps
                    if add_step is not None or i != final_verify:
                        emit("log", f"skipped verify {i} (basket check covers it)" if add_step is not None
                             else f"skipped intermediate verify {i}")
                        i += 1
                        continue
                    target = render(step.target, vars_)
                    typed = [render(s.value, vars_) for s in steps[:i] if s.op == "fill" and s.value]
                    v = await verify_outcome(page, target, typed)
                    if not v.get("passed"):
                        raise StepFailed(f"not confirmed: {target} ({v.get('evidence')})")
                    emit("step", f"verify '{target}': True ({v.get('evidence')})", step=i, passed=True)
                    i += 1
                    continue

                # ---- fast path: replay (from cache, or the add that just worked when repeating) ----
                acts = cache.get(str(i))
                # Adding to basket depends on this run's size/colour, so it is never replayed
                # from an earlier run's cache (only repeated within this run, below).
                replayable = acts is not None and cacheable(step, acts) and i != add_step
                if repeating and i == add_step and performed.get(i):
                    acts, replayable = performed[i], True
                if replayable:
                    await dismiss_overlays(page)
                    callback = (lambda a: on_action({"step": i, "target": render(step.target, vars_), **a})) \
                        if on_action else None
                    if await replay_step(page, acts, render(step.value, vars_), on_action=callback):
                        if not repeating:
                            performed[i] = acts
                        emit("step", f"[{i}] {step.op} replayed from cache", step=i, cached=True)
                        i, hops = i + 1, 0
                        continue
                    emit("log", f"cache miss at step {i}; asking the model", step=i)

                # ---- slow path: ground with the LLM ----
                j = i
                while j < len(steps) and steps[j].op not in ("verify", "extract"):
                    j += 1
                window = list(range(i, j))

                await dismiss_overlays(page)
                els = await describe_page(page)
                actions = await ground(page, program, window, vars_, els, answers=answers,
                                       hint=" ".join(h for h in (hint, step_hint.get(i, "")) if h))
                if not actions:
                    actions = [{"step": i, "status": "not_found", "reason": "empty plan"}]
                start_i, replan = i, False

                for n, a in enumerate(actions):
                    s = _step_index(a, i)
                    if s != i:
                        if n == 0:
                            s = i
                        else:
                            break
                    status, eid = a.get("status"), a.get("element_id")
                    el = next((e for e in els if e["id"] == eid), None)
                    action = a.get("action") or steps[i].op
                    value = a.get("value") or render(steps[i].value, vars_)
                    if steps[i].op == "search":
                        if action == "fill":
                            action = "search"                   # typing into search = submit it too
                        if status == "ok" and action not in ("search", "press") and el is not None \
                                and SEARCHY.search(" ".join(str(el.get(k, "")) for k in
                                                            ("text", "aria", "title", "ph", "name", "href", "label"))):
                            status = "partial"                  # search icon click only opened the box
                    text_click = action == "click_text" and bool(a.get("value"))
                    repeat = max(1, min(int(a.get("repeat") or 1), MAX_REPEAT))
                    last_reason = a.get("reason", "")
                    emit("step", f"[{i}] {action}{f' x{repeat}' if repeat > 1 else ''} "
                                 f"-> {status} [{eid if not text_click else repr(value)}] {last_reason}",
                         step=i)

                    if status in ("ok", "partial", "move") and el is None and not text_click:
                        status = "not_found"
                    if el is not None and forbidden(el):
                        raise StepFailed(f"refused forbidden element: {el.get('text') or el.get('href')}")
                    if text_click and FORBIDDEN.search(value or ""):
                        raise StepFailed(f"refused forbidden text: {value}")

                    # ---- don't click the same 'partial' thing twice (e.g. ADD again) ----
                    if status == "partial" and el is not None:
                        key = json.dumps(semantic(el), sort_keys=True)
                        if last_partial.get(i) == key and guards.get(i, 0) < 2:
                            guards[i] = guards.get(i, 0) + 1
                            step_hint[i] = ("You just clicked that and it opened a picker. Do NOT click it "
                                            "again: choose the matching option (click, or click_text with its "
                                            "visible text), or return needs_input with the options you see.")
                            emit("log", "not clicking the same thing again; the picker should be open", step=i)
                            replan = True
                            break
                        last_partial[i] = key

                    if status == "needs_input":
                        field = re.sub(r"\W+", "_", str(a.get("field") or "choice").lower()).strip("_") or "choice"
                        question = a.get("question") or f"Which {field.replace('_', ' ')} would you like?"
                        options = [str(o) for o in (a.get("options") or [])][:40]
                        known = answers.get(field)
                        if (not options or known) and nudge(
                                i,
                                (f"The shopper already chose {field} = {known}. Click the visible {field} "
                                 f"option closest to it (click, or click_text with its visible text). If no "
                                 f"{field} options are visible, click the add-to-basket button with status "
                                 f"partial to open them. Do NOT return needs_input.") if known else
                                ("No choices are visible yet, so don't ask the shopper. Click the "
                                 "add-to-basket button with status partial; if a size is needed, the "
                                 "shop will show its size options next."),
                                f"not asking about {field} yet; trying the page first"):
                            replan = True
                            break
                        asks += 1
                        if ask is None or asks > MAX_ASKS:
                            listed = f" Options: {', '.join(options)}." if options else ""
                            result.status, result.error = "needs_human", (
                                f"{question}{listed} Add it to your request "
                                f"(e.g. \"{field.replace('_', ' ')} {options[0] if options else '10'}\") and run again.")
                            emit("status", "needs_human", reason=question, field=field, options=options)
                            return result
                        emit("status", "needs_input", field=field, question=question,
                             options=options, step=i)
                        answer = await ask(field, question, options)
                        if not answer:
                            result.status, result.error = "needs_human", f"no answer to: {question}"
                            emit("status", "needs_human", reason=result.error)
                            return result
                        answers[field] = vars_[field] = answer.strip()
                        answered_steps.add(i)
                        step_hint.pop(i, None)
                        emit("log", f"shopper chose {field} = {answers[field]}", step=i,
                             answer={field: answers[field]})
                        replan = True
                        break                                   # re-plan this step with the answer

                    if status == "needs_human":
                        result.status, result.error = "needs_human", last_reason
                        emit("status", "needs_human", reason=last_reason)
                        return result
                    if status == "already_done":
                        qty = _qty_target(steps[i], vars_)
                        if el is None and qty > 1 and add_step is not None and i < add_step and not repeating:
                            extra_adds = qty - 1          # "no quantity box" said as already_done
                            emit("log", f"no quantity control here; will add to basket {qty} times")
                        if steps[i].value is None and not repeating:
                            performed.setdefault(i, [])
                        i, hops = i + 1, 0
                        continue
                    if status not in ("ok", "partial", "move"):
                        if steps[i].op == "search" and nudge(
                                i,
                                "There is no usable search box here. Click a category or menu link that "
                                "matches the query (status ok), or move to a 'Products'/'Shop' page that "
                                "has a search box.",
                                "no search box; looking for a matching category instead"):
                            replan = True
                            break
                        if i == add_step and nudge(
                                i,
                                "If this is not a single product's page, return move with the product that best "
                                "matches the item to open it. If a size or other option has to be chosen first: "
                                "click the visible option "
                                "matching USER CHOICES (click, or click_text with its visible text), or click "
                                "add-to-basket with status partial to reveal the options, or return "
                                "needs_input with the options you can see.",
                                "add to basket not possible yet; looking for a required option"):
                            replan = True
                            break
                        if steps[i].optional:
                            qty = _qty_target(steps[i], vars_)
                            if qty > 1 and add_step is not None and i < add_step and not repeating:
                                extra_adds = qty - 1
                                emit("log", f"no quantity control here; will add to basket {qty} times")
                            emit("log", f"skipped optional step {i}")
                            i, hops = i + 1, 0
                            continue
                        raise StepFailed(f"step {i} ({steps[i].op} '{render(steps[i].target, vars_)}'): "
                                         f"{status} - {last_reason}")

                    try:
                        for repetition in range(repeat):
                            if text_click:
                                await click_text(page, value)
                            else:
                                await act(page, el, action, value)
                            if on_action:
                                on_action({"step": i, "op": action,
                                           "target": render(steps[i].target, vars_),
                                           "value": value, "element": el or {"text": value},
                                           "url": page.url, "cached": False, "repeat": repeat,
                                           "repetition": repetition + 1,
                                           "navigation_hop": status == "move",
                                           "partial": status == "partial"})
                            if repeat > 1:
                                await page.wait_for_timeout(250)
                    except Exception as e:
                        if not text_click:
                            raise
                        emit("log", f"couldn't click text {value!r}: {e}", step=i)
                        hops += 1
                        break
                    await settle(page)
                    if not repeating:
                        rec = {"action": action, "locator": semantic(el), "value": value,
                               "repeat": repeat, "status": status}
                        if i in answered_steps:
                            rec["answer"] = True
                        performed.setdefault(i, []).append(rec)

                    if status == "ok":
                        result.bindings.append(Binding(step=i, action=action, value=value,
                                                       repeat=repeat, locator=semantic(el)))
                        i, hops = i + 1, 0
                        if action in PAGE_CHANGING:
                            break
                    else:
                        hops += 1
                        break

                if i == start_i and not replan:
                    hops += 1
                if hops > MAX_HOPS:
                    raise StepFailed(f"step {i} made no progress after {MAX_HOPS} attempts ({last_reason})")

            # ---- after the steps: did it really go into the basket? ----
            hint = ""
            if add_step is not None and not cart_checked:
                v = await verify_cart(page)
                passed = bool(v.get("passed"))
                emit("step", f"basket check: {passed} ({v.get('evidence')})", step=add_step, passed=passed)
                if not passed:
                    if cart_retries >= 2:
                        raise StepFailed(f"item was not added to the basket ({v.get('evidence')})")
                    cart_retries += 1
                    performed.pop(add_step, None)           # keep only the attempt that works
                    hint = ("The basket check did not see the item. If the basket/bag already shows it "
                            "(count went up, or an 'added' message), return already_done. Otherwise look "
                            "for a required choice (size, colour, fit) or an error message, then add it.")
                    i, hops = add_step, 0
                    continue
                cart_checked = True

            # ---- no quantity box: add the same item again ----
            if extra_adds > 0:
                extra_adds -= 1
                repeating = True
                hint = ("This shop has no quantity control: add ONE MORE of the same product to the "
                        "basket, with the same size/options as before.")
                emit("log", f"adding another one to the basket ({extra_adds} more after this)")
                i, hops = add_step, 0
                continue
            break

        result.status = "done"
        try:
            cache_path(program, url).write_text(
                json.dumps({str(k): v for k, v in performed.items()}, indent=1))
        except Exception:
            pass
        emit("status", "done")
    except StepFailed as e:
        result.status, result.error = "failed", str(e)
        emit("error", str(e))
    except Exception as e:
        result.status, result.error = "failed", f"{type(e).__name__}: {e}"
        emit("error", result.error)
    finally:
        name = slug(url) + (f"_{run_tag}" if run_tag else "")
        shot = DATA / "results" / f"{name}.png"
        try:
            await page.screenshot(path=shot)
            result.screenshot = str(shot)
        except Exception:
            pass
        (DATA / "results" / f"{name}.json").write_text(result.model_dump_json(indent=1))
        if own_page:
            await page.close()
    return result

async def run_batch(ctx: BrowserContext, jobs: list[dict], program: IntentProgram, *,
                    on_event: Optional[Callable[[AgentEvent], None]] = None,
                    on_action: Optional[Callable[[dict], None]] = None,
                    on_result=None, concurrency: int = 2,
                    ask: Optional[AskFn] = None, answers: Optional[dict] = None
                    ) -> list[tuple[dict, SiteResult]]:
    sem = asyncio.Semaphore(concurrency)
    results: list[tuple[dict, SiteResult]] = []
    answers = answers if answers is not None else {}

    async def one(job: dict):
        async with sem:
            res = await run_program(ctx, job["url"], program, variables=job.get("variables"),
                                    on_event=on_event, on_action=on_action,
                                    run_tag=str(job.get("key", "")), ask=ask, answers=answers)
            results.append((job, res))
            if on_result:
                await on_result(job, res)

    await asyncio.gather(*(one(j) for j in jobs))
    return results

# ---------- CLI ----------
async def cli_ask(field: str, question: str, options: list[str]) -> Optional[str]:
    print(f"\n[agent] {question}")
    if options:
        print("        options: " + " | ".join(options))
    ans = await asyncio.get_running_loop().run_in_executor(None, input, f"        your {field}: ")
    return ans.strip() or None

# uv run python -m webagent.run <intent_name> <url> [var=value ...]
async def _main():
    name, url = sys.argv[1], sys.argv[2]
    overrides = dict(a.split("=", 1) for a in sys.argv[3:])
    program = IntentProgram.model_validate_json((DATA / "intents" / f"{name}.json").read_text())

    def show(ev: AgentEvent):
        print(f"[{ev.kind:6}] {ev.message}")

    async with launch() as ctx:
        result = await run_program(ctx, url, program, variables=overrides, on_event=show,
                                   ask=cli_ask, answers={})
    print(f"\nRESULT: {result.status}" + (f" - {result.error}" if result.error else ""))
    print(f"OUTPUTS: {result.outputs}")
    print(f"LLM calls: {stats['calls']}   screenshot: {result.screenshot}")

if __name__ == "__main__":
    asyncio.run(_main())
