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
from .schemas import IntentProgram, SiteResult, Binding, AgentEvent, Constraints

MAX_HOPS = 3
MAX_REPEAT = 20
MAX_ASKS = 3
MAX_PICKS = 4            # products rejected (over budget / wrong) before giving up on one item
PAGE_CHANGING = {"search", "click", "press", "click_text"}
CACHE_KEYS = ("tag", "type", "label", "aria", "ph", "name", "text", "href")
QTY_VAR = re.compile(r"qty|quantit", re.I)
SEARCHY = re.compile(r"search|magnif|find", re.I)
SHOP_WORDS = re.compile(r"\b(cart|basket|bag|trolley)\b", re.I)

def is_shopping(program: "IntentProgram") -> bool:
    """Basket checks, sizes and quantities only make sense for add-to-basket skills."""
    return any(SHOP_WORDS.search(s.target or "") for s in program.steps)

PRODUCT_WORDS = re.compile(r"\b(product|item|result|match|listing|tile)", re.I)
CART_WORDS = re.compile(r"\b(cart|basket|bag|trolley|checkout)\b", re.I)
ADD_STEP = re.compile(r"\badd\b.*\b(cart|basket|bag|trolley)\b|\bbuy\b", re.I)
ADD_EL = re.compile(r"\b(add|buy)\b", re.I)
MAX_ASKS_PER_FIELD = 2   # per product: a second answer is allowed (e.g. the first size was sold out)
# Answers to these hold for ONE product on ONE shop: sizes are labelled differently from shop to
# shop (UK 14 / EU 42 / W30 L32 / M) and product to product, so the next product asks again.
PER_ITEM_FIELD = re.compile(r"size|waist|length|leg|inseam|cup|width|fit", re.I)
CURRENCIES = (("us$", "USD"), ("£", "GBP"), ("€", "EUR"), ("₹", "INR"), ("$", "USD"))
CURRENCY_WORDS = re.compile(r"\b(gbp|usd|eur|inr|rs|pounds?|dollars?|euros?|rupees?)\b", re.I)
CURRENCY_CODES = {"gbp": "GBP", "pound": "GBP", "pounds": "GBP", "usd": "USD", "dollar": "USD",
                  "dollars": "USD", "eur": "EUR", "euro": "EUR", "euros": "EUR", "inr": "INR",
                  "rs": "INR", "rupee": "INR", "rupees": "INR"}
SYMBOL = {"GBP": "£", "USD": "$", "EUR": "€", "INR": "₹"}

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
  none does, pick the closest and say so in "reason" (but when SHOPPER WANTS is given, it is
  checked strictly: follow the SHOPPER WANTS rule below instead).
- The add-to-basket step only makes sense on a single product's page. If you are on a home,
  search or category page instead, return "move" with the product that best matches the
  item (and USER CHOICES) to open its page.
- A value shown as <name: not chosen> is a personal choice the shopper has NOT made. Never
  pick it yourself: if the page requires it (options visible), return needs_input with those
  options; if this shop doesn't need it, the step is not_found (it is optional).
- If SHOPPER WANTS is given, a product you choose must fit it: judge each product by its
  text and ctx (price, name, description) and pick one that is within the price limit and
  meets every requirement. Never pick a product listed under ALREADY CHOSEN or REJECTED. If
  no visible product fits, use the shop's sort-by-price or filter control if there is one
  (status partial), otherwise return not_found with the reason.
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

# ---------- products, prices and the shopper's constraints ----------
def product_step(program: IntentProgram) -> Optional[int]:
    """The step that chooses which product to buy (e.g. 'the product that best matches {{query}}')."""
    steps = program.steps
    search = next((k for k, s in enumerate(steps) if s.op == "search"), None)
    clicks = [k for k, s in enumerate(steps)
              if s.op == "click" and not s.optional and not CART_WORDS.search(s.target)]
    for found in ([k for k in clicks if PRODUCT_WORDS.search(steps[k].target)],
                  [k for k in clicks if "{{" in steps[k].target]):
        after = [k for k in found if search is None or k > search]
        if after:
            return after[0] if search is not None else after[-1]
    return None

def currency_of(text: Optional[str]) -> Optional[str]:
    t = (text or "").strip().lower()
    if not t:
        return None
    if t.upper() in SYMBOL:
        return t.upper()
    for sym, code in CURRENCIES:
        if sym in t:
            return code
    m = CURRENCY_WORDS.search(t)
    return CURRENCY_CODES.get(m.group(1).lower()) if m else None

def parse_price(text) -> tuple[Optional[float], Optional[str]]:
    """'£24.99' -> (24.99, 'GBP'); '1.299,00 €' -> (1299.0, 'EUR'); 'Rs. 500' -> (500.0, 'INR')."""
    if text is None:
        return None, None
    s = str(text)
    m = re.search(r"\d[\d.,\s]*\d|\d", s)
    if not m:
        return None, currency_of(s)
    tok = re.sub(r"\s", "", m.group(0))
    if "," in tok and "." in tok:
        dec = "," if tok.rfind(",") > tok.rfind(".") else "."
        tok = tok.replace("." if dec == "," else ",", "").replace(dec, ".")
    elif "," in tok:
        tok = tok.replace(",", ".") if re.fullmatch(r"\d+,\d{1,2}", tok) else tok.replace(",", "")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", tok):
        tok = tok.replace(".", "")               # 1.299 -> 1299 (thousands separator)
    try:
        return float(tok), currency_of(s)
    except ValueError:
        return None, currency_of(s)

def money(amount: float, currency: Optional[str]) -> str:
    sym = SYMBOL.get(currency or "", "")
    text = f"{amount:,.2f}".replace(".00", "")
    return f"{sym}{text}" if sym else (f"{text} {currency}" if currency else text)

def wants_text(c: Constraints, left: Optional[float], currency: Optional[str]) -> str:
    """left: each remaining item's share of the total budget, if there is one."""
    parts = []
    if c.max_price is not None:
        parts.append(f"priced at most {money(c.max_price, currency)} each")
    if c.total_budget is not None and left is not None:
        parts.append(f"costing at most {money(max(left, 0), currency)} each "
                     f"(an equal share of what's left of the {money(c.total_budget, currency)} total budget)")
    if c.requirements:
        parts.append("must be: " + ", ".join(c.requirements))
    return "; ".join(parts)

async def product_details(page: Page, c: Constraints, wanted: str = "") -> dict:
    fields = {"product_name": "the main product's name (null if this is not a single product's page, "
                              "e.g. a list of search results)",
              "price": "the main product's current selling price with its currency symbol, exactly "
                       "as shown (the sale price if it is discounted)"}
    if wanted:
        fields["is_requested_kind"] = (f"'yes' or 'no': is the main product the kind of item asked for "
                                       f"({wanted})? Answer 'no' only if it is clearly a different kind "
                                       f"of product (e.g. a top when jeans were asked for).")
    if c.requirements:
        fields["meets_requirements"] = ("'yes' or 'no': does this product satisfy ALL of: "
                                        + "; ".join(c.requirements)
                                        + "? Answer 'yes' if the page doesn't say otherwise.")
    vals = await extract(page, fields)
    vals["product_url"] = page.url
    return vals

def _norm_option(s: str) -> str:
    return re.sub(r"\s+", " ", str(s)).strip().lower()

def closest_option(answer: Optional[str], options: list[str]) -> Optional[str]:
    """The visible option that means the shopper's answer: '12' -> 'UK 12', 'M' -> 'M (UK 10)'."""
    a = _norm_option(answer or "")
    if not a:
        return None
    opts = [o for o in options if str(o).strip()]
    for o in opts:
        if _norm_option(o) == a:
            return o
    token = re.compile(rf"(^|[^a-z0-9]){re.escape(a)}([^a-z0-9]|$)")
    return next((o for o in opts if token.search(_norm_option(o))), None)

def basket_state(signals: list[str]) -> tuple:
    """Numbers on the basket/bag/cart labels, plus whether an 'added' message shows. Compared before
    and after a click to tell whether it put something in the basket (old items don't count)."""
    counts = sorted(int(n) for s in signals if len(s) < 80 and CART_WORDS.search(s)
                    for n in re.findall(r"\d+", s)[:1])
    added = any(re.search(r"\badded\b|\bin (your|the) (bag|basket|cart)\b", s, re.I) for s in signals)
    return tuple(counts), added

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
            and not any(a.get("answer") or not a.get("locator") for a in acts)
            # text typed during a step that has no value of its own (e.g. a search done while
            # 'going to the home page') came from that run's inputs: don't replay it for another
            and not (step.value is None and any(a["action"] in ("fill", "search", "select") for a in acts)))

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
                 els: list[dict], *, answers: Optional[dict] = None, hint: str = "",
                 shopper: str = "", avoid: Optional[list[str]] = None,
                 rejected: Optional[list[str]] = None) -> list[dict]:
    # Personal choices the shopper hasn't made are shown as such, never as an empty value.
    shown = {**vars_, **{k: f"<{k}: not chosen>" for k, v in vars_.items() if str(v).strip() == ""}}
    lines = []
    for k in window:
        s = program.steps[k]
        v = render(s.value, shown)
        lines.append(f"[{k}] {s.op}: {render(s.target, shown)}"
                     + (f"  value={v}" if v else "") + ("  (optional)" if s.optional else ""))
    extra = ""
    if answers:
        extra += ("USER CHOICES (already answered by the shopper; use them, don't ask again): "
                  + ", ".join(f"{k}={v}" for k, v in answers.items()) + "\n")
    if shopper:
        extra += f"SHOPPER WANTS: products {shopper}\n"
    if avoid:
        extra += "ALREADY CHOSEN (pick a DIFFERENT product): " + "; ".join(avoid) + "\n"
    if rejected:
        extra += "REJECTED (don't pick these again): " + "; ".join(rejected) + "\n"
    if hint:
        extra += f"NOTE: {hint}\n"
    u = urlparse(page.url)
    user = (f"OVERALL GOAL: {render(program.goal, shown)}\n\n"
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
                      answers: Optional[dict] = None,
                      constraints: Optional[Constraints | dict] = None) -> SiteResult:
    """ask(field, question, options) -> answer or None. answers: shared dict of the shopper's
    choices (e.g. {"colour": "blue"}); pass the same dict to every shop in a run to ask only once.
    Answers about sizes (PER_ITEM_FIELD) are not shared: they hold for the current product only.
    constraints: budget, number of DIFFERENT products and requirements (see schemas.Constraints);
    without them the run behaves exactly as before."""
    answers = answers if answers is not None else {}
    base_vars = {**program.variables, **(variables or {})}
    vars_ = {**base_vars, **answers}
    item_answers: dict[str, str] = {}   # answers that hold for the current product only (e.g. size)
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

    # ---- the shopper's constraints: budget, how many different products, requirements ----
    c = constraints if isinstance(constraints, Constraints) else Constraints.model_validate(constraints or {})
    prod_step = product_step(program) if shopping else None    # email/other skills: no products
    pick = prod_step if c.active() else None
    checking = pick is not None                 # check each chosen product before buying it
    wanted_kind = render(steps[pick].target, vars_) if checking else ""
    budget_cur = currency_of(c.currency)
    qty_wanted = max([_qty_target(s, vars_) for s in steps] or [1])
    # The skill's "add to basket" click: on some shops (Zara) choosing a size already adds the item,
    # so before that step runs we check whether an earlier click already put it in the basket.
    add_click = next((k for k, s in enumerate(steps)
                      if shopping and s.op == "click" and k > (prod_step if prod_step is not None else -1)
                      and ADD_STEP.search(s.target)), None)
    items: list[dict] = []                      # products that made it into the basket
    rejected: list[str] = []
    notes: list[str] = []
    state = {"current": None, "checked": False, "rejected_now": 0, "spent": 0.0, "results_url": None,
             "asked": {}, "pre_added": False, "basket_before": None}

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

    def share() -> Optional[float]:
        """Per-item allowance from a total budget: an equal share of what's left, so the first
        product can't use up the money the others need."""
        if c.total_budget is None:
            return None
        return (c.total_budget - state["spent"]) / max(c.items - len(items), 1) / qty_wanted

    def cap_now() -> Optional[float]:
        caps = [x for x in (c.max_price, share()) if x is not None]
        return min(caps) if caps else None

    def shopper_text() -> str:
        return wants_text(c, share(), budget_cur) if checking else ""

    def save_cache():
        try:
            cache_path(program, url).write_text(
                json.dumps({str(k): v for k, v in performed.items()}, indent=1))
        except Exception:
            pass

    async def back_to_results():
        target = state["results_url"]
        if target and page.url != target:
            await page.goto(target, wait_until="domcontentloaded")
        elif target:
            await dismiss_overlays(page, aggressive=True)   # a quick-view popup over the results
        else:
            await page.go_back(wait_until="domcontentloaded")
        await settle(page)
        await dismiss_overlays(page)

    async def check_product() -> bool:
        """Read the chosen product's name and price; False (and back to the results) if it doesn't fit."""
        details = {k: v for k, v in (await product_details(page, c, wanted_kind)).items() if v not in (None, "")}
        if not details.get("product_name") and not details.get("price"):
            # Still on a list of products (e.g. it searched again instead of opening one).
            state["rejected_now"] += 1
            if state["rejected_now"] >= MAX_PICKS:
                raise StepFailed(f"couldn't open a product page after {MAX_PICKS} tries")
            step_hint[pick] = ("No product page is open yet. Click ONE product (its name, picture or "
                               "'View Product' link) to open its own page; don't search again.")
            emit("log", "no product page open yet; choosing a product", step=pick)
            if state["results_url"] and page.url != state["results_url"]:
                await back_to_results()
            return False
        name = str(details.get("product_name") or "this product").strip()
        label = f"{name} ({details['price']})" if details.get("price") else name
        amount, cur = parse_price(details.get("price"))
        limit_cur = budget_cur or cur
        problem = ""
        kind = str(details.pop("is_requested_kind", "")).strip().lower()
        meets = str(details.pop("meets_requirements", "")).strip().lower()
        bare = lambda u: urlparse(str(u))._replace(query="", fragment="").geturl()
        if any(bare(it.get("product_url", "")) == bare(page.url)
               or _norm_option(it.get("product_name", "")) == _norm_option(name) for it in items):
            problem = "it is already in the basket"
        elif kind.startswith("no"):
            problem = f"it isn't what was asked for ({wanted_kind})"
        elif c.max_price is not None or c.total_budget is not None:
            if amount is None:
                notes.append(f"couldn't read the price of {name}, so its budget wasn't checked")
            elif budget_cur and cur and cur != budget_cur:
                notes.append(f"prices here are in {cur} and the budget is in {budget_cur}, so they weren't compared")
            elif c.max_price is not None and amount > c.max_price + 1e-9:
                problem = f"{money(amount, cur)} is over the {money(c.max_price, limit_cur)} limit"
            elif c.total_budget is not None and amount > share() + 1e-9:
                problem = (f"{money(amount, cur)} is more than its share of the "
                           f"{money(c.total_budget, limit_cur)} total budget ({money(max(share(), 0), limit_cur)})")
        if not problem and meets.startswith("no"):
            problem = "doesn't match " + ", ".join(c.requirements)
        if problem:
            rejected.append(f"{label}: {problem}")
            state["rejected_now"] += 1
            emit("log", f"product rejected: {label} - {problem}", item=details, reason=problem)
            if state["rejected_now"] >= MAX_PICKS:
                raise StepFailed(f"no product fits ({shopper_text()}) after {MAX_PICKS} tries; "
                                 f"last: {label} - {problem}")
            performed.pop(pick, None)               # don't cache the rejected click
            await back_to_results()
            step_hint.pop(pick, None)               # the hint was about the page just left
            return False
        state["current"] = details
        within = f" - within {money(cap_now(), limit_cur)}" if amount is not None and cap_now() is not None else ""
        emit("log", f"product check passed: {label}{within}", item=details)
        return True

    def stop_for_person(reason: str, **data) -> SiteResult:
        """The site needs a person. Products already in the basket still count: report them as done."""
        if items:
            result.status = "done"
            notes.insert(0, f"added {len(items)} of {c.items} items; then the site needed you: {reason}")
            save_cache()
            emit("log", f"stopped looking after {len(items)} of {c.items} items: {reason}")
            emit("status", "done")
        else:
            result.status, result.error = "needs_human", reason
            emit("status", "needs_human", reason=reason, **data)
        return result

    def looks_like_add(el: Optional[dict], text: str = "") -> bool:
        label = " ".join(str((el or {}).get(k, "")) for k in ("text", "aria", "title", "label")) + " " + text
        return bool(ADD_EL.search(label))

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
        if checking:
            emit("log", f"looking for {c.items} different product{'s' if c.items > 1 else ''}"
                        + (f" {shopper_text()}" if shopper_text() else ""),
                 items_wanted=c.items, constraints=c.model_dump())
        elif c.active():
            notes.append("this skill has no product-choosing step, so the budget and item count weren't applied")
            emit("log", notes[-1])

        i, hops, last_reason = 0, 0, ""
        hint, cart_checked, cart_retries, extra_adds, repeating, asks = "", False, 0, 0, False, 0

        while True:
            while i < len(steps):
                if repeating and i > add_step:
                    break                                   # extra adds: only redo add-to-basket
                if checking and i == pick and state["results_url"] is None:
                    state["results_url"] = page.url         # where to come back for another product
                if checking and not state["checked"] and not repeating and i > pick:
                    state["checked"] = True
                    if not await check_product():
                        state["checked"] = False
                        i, hops = pick, 0
                        continue
                if (add_click is not None and not repeating and state["basket_before"] is None
                        and (prod_step is None or i > prod_step) and i <= add_click):
                    state["basket_before"] = basket_state(await cart_signals(page))   # before any add
                if i == add_click and state["pre_added"] and not repeating:
                    # An earlier step clicked an add button (e.g. Zara adds when you pick a size):
                    # if the basket changed since the product page opened, don't add it twice.
                    state["pre_added"] = False
                    now = basket_state(await cart_signals(page))
                    before = state["basket_before"]
                    if before is not None and (now[0] != before[0] or (now[1] and not before[1])):
                        emit("step", f"[{i}] {steps[i].op} -> already_done [None] the earlier click already "
                                     f"put it in the basket, so it isn't added twice", step=i)
                        i, hops = i + 1, 0
                        continue
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
                if checking and i == pick and (items or rejected):
                    acts = None                             # another product: never replay the old click
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
                        if (add_click is not None and i < add_click and not repeating
                                and any(looks_like_add(a.get("locator"), a.get("value") or "" if a["action"] == "click_text" else "")
                                        for a in acts)):
                            state["pre_added"] = True
                        if not repeating and not items:
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
                actions = await ground(page, program, window, vars_, els, answers={**answers, **item_answers},
                                       hint=" ".join(h for h in (hint, step_hint.get(i, "")) if h),
                                       shopper=shopper_text(),
                                       avoid=[str(it.get("product_name") or it.get("product_url")) for it in items],
                                       rejected=rejected[-6:])
                if not actions:
                    actions = [{"step": i, "status": "not_found", "reason": "empty plan"}]
                start_i, replan = i, False

                for n, a in enumerate(actions):
                    if checking and not state["checked"] and not repeating and i > pick:
                        break                               # check the chosen product before going on
                    if checking and i == pick and state["results_url"] is None:
                        state["results_url"] = page.url
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
                    if checking and i == pick and status == "ok" and action not in ("click", "click_text"):
                        status = "partial"                      # searching/filtering again doesn't choose a product
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
                        # a choice from the chat (e.g. size=M as a skill input) is as good as an answer
                        known = (item_answers.get(field) or answers.get(field)
                                 or str(vars_.get(field) or "").strip() or None)
                        label = field.replace("_", " ")
                        match = closest_option(known, options) if known and options else None
                        if match:
                            # The shopper's answer is on the page: pick it ourselves, never ask again.
                            try:
                                await click_text(page, match)
                            except Exception as e:
                                emit("log", f"couldn't click the {label} option {match!r}: {e}", step=i)
                            else:
                                await settle(page)
                                if on_action:
                                    on_action({"step": i, "op": "click_text", "target": render(steps[i].target, vars_),
                                               "value": match, "element": {"text": match}, "url": page.url,
                                               "cached": False, "repeat": 1, "repetition": 1,
                                               "navigation_hop": False, "partial": False})
                                answered_steps.add(i)
                                if not repeating and not items:
                                    performed.setdefault(i, []).append(
                                        {"action": "click_text", "locator": {}, "value": match, "repeat": 1,
                                         "status": "ok", "answer": True})
                                emit("log", f"picked {label} {match!r} for your answer {known!r}", step=i)
                                if add_click is not None and i < add_click:
                                    i, hops = i + 1, 0          # the option step is done
                                else:
                                    step_hint[i] = (f"{label} {match} is selected now. If the item is not in the "
                                                    f"basket yet, click add-to-basket; if it is (confirmation shown, "
                                                    f"basket count went up), return already_done.")
                                    replan = True
                                break
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
                        # Asking only helps when there is something to choose from (or nothing is known yet).
                        if not options and steps[i].optional:
                            emit("log", f"no {label} choices visible at this step; moving on "
                                        f"(adding to the basket usually shows them)", step=i)
                            emit("log", f"skipped optional step {i}")
                            i, hops = i + 1, 0
                            continue
                        if not options and known:
                            status, last_reason = "not_found", f"no {label} choices are visible to pick {known}"
                        elif state["asked"].get(field, 0) >= MAX_ASKS_PER_FIELD:
                            status, last_reason = "not_found", f"couldn't choose a {label} on this page after asking"
                        else:
                            if known and options:
                                question = (f"{label.capitalize()} {known} isn't one of the options for this "
                                            f"product here. Which {label} would you like instead?")
                            state["asked"][field] = state["asked"].get(field, 0) + 1
                            asks += 1
                            if ask is None or asks > MAX_ASKS * c.items:
                                # Can't ask (CLI without input, or asked too often): say how to give it upfront.
                                listed = f" Options: {', '.join(options)}." if options else ""
                                return stop_for_person(
                                    f"{question}{listed} Add it to your request "
                                    f"(e.g. \"{field.replace('_', ' ')} {options[0] if options else '10'}\") and run again.",
                                    field=field, options=options)
                            emit("status", "needs_input", field=field, question=question,
                                 options=options, step=i)
                            answer = await ask(field, question, options)
                            if not answer:
                                return stop_for_person(f"no answer to: {question}")
                            chosen = answer.strip()
                            per_item = bool(PER_ITEM_FIELD.search(field))
                            (item_answers if per_item else answers)[field] = vars_[field] = chosen
                            answered_steps.add(i)
                            step_hint.pop(i, None)
                            nudges.pop(i, None)
                            emit("log", f"shopper chose {field} = {chosen}"
                                        + (" for this product" if per_item else ""), step=i,
                                 answer={field: chosen}, per_item=per_item)
                            replan = True
                            break                               # re-plan this step with the answer

                    if status == "needs_human":
                        return stop_for_person(last_reason)
                    if status == "already_done":
                        qty = _qty_target(steps[i], vars_)
                        if el is None and qty > 1 and add_step is not None and i < add_step and not repeating:
                            extra_adds = qty - 1          # "no quantity box" said as already_done
                            emit("log", f"no quantity control here; will add to basket {qty} times")
                        if steps[i].value is None and not repeating and not items:
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
                    if (add_click is not None and i < add_click and not repeating
                            and looks_like_add(el, value if text_click else "")):
                        state["pre_added"] = True           # e.g. the size step clicked ADD to open sizes
                    if not repeating and not items:         # the cache holds the first product's path
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
                        if status == "move" and i == prod_step and action in ("click", "click_text"):
                            # It opened something from the results; if that is the product, this
                            # step is done (otherwise it starts on the product page's options).
                            step_hint[i] = ("You just opened a page from the results. If it is a single "
                                            "product's page, this step is done: return already_done. "
                                            "Otherwise click ONE matching product.")
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

            # ---- the shopper wants several DIFFERENT products: go back for the next one ----
            if checking:
                item = state["current"] or {"product_url": page.url}
                items.append(item)
                amount, _ = parse_price(item.get("price"))
                state["spent"] += (amount or 0) * qty_wanted
                name = item.get("product_name") or "the product"
                emit("log", f"item {len(items)} of {c.items} in the basket: {name}"
                            + (f" ({item['price']})" if item.get("price") else ""),
                     item=item, item_no=len(items), items_wanted=c.items)
                state.update(current=None, checked=False, rejected_now=0, asked={},
                             pre_added=False, basket_before=None)
                for f in item_answers:                      # the next product asks for its own size
                    if f in answers:
                        vars_[f] = answers[f]
                    elif f in base_vars:
                        vars_[f] = base_vars[f]
                    else:
                        vars_.pop(f, None)
                item_answers.clear()
                if len(items) < c.items:
                    if c.total_budget is not None and (cap_now() or 0) <= 0:
                        notes.append(f"the {money(c.total_budget, budget_cur)} total budget is used up")
                    else:
                        emit("log", f"looking for item {len(items) + 1} of {c.items}",
                             item_no=len(items) + 1, items_wanted=c.items)
                        await back_to_results()
                        i, hops, hint = pick, 0, ""
                        cart_checked, cart_retries, extra_adds = False, 0, 0
                        for d in (nudges, step_hint, last_partial, guards):
                            d.clear()
                        continue
            break

        result.status = "done"
        if checking and len(items) < c.items:
            notes.insert(0, f"added {len(items)} of {c.items} items")
        save_cache()
        emit("status", "done")
    except StepFailed as e:
        if items:       # some products are already in the basket: report them, not a failure
            result.status = "done"
            notes.insert(0, f"added {len(items)} of {c.items} items; then {e}")
            save_cache()
            emit("log", f"stopped looking after {len(items)} of {c.items} items: {e}")
            emit("status", "done")
        else:
            result.status, result.error = "failed", str(e)
            emit("error", str(e))
    except Exception as e:
        if items:
            result.status = "done"
            notes.insert(0, f"added {len(items)} of {c.items} items; then {type(e).__name__}: {e}")
            emit("log", notes[0])
            emit("status", "done")
        else:
            result.status, result.error = "failed", f"{type(e).__name__}: {e}"
            emit("error", result.error)
    finally:
        if items:
            result.items = items
            for k in ("product_name", "price", "product_url"):
                if items[0].get(k):
                    result.outputs.setdefault(k, items[0][k])
        if notes:
            result.note = "; ".join(dict.fromkeys(notes))
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
                    ask: Optional[AskFn] = None, answers: Optional[dict] = None,
                    constraints: Optional[Constraints] = None
                    ) -> list[tuple[dict, SiteResult]]:
    sem = asyncio.Semaphore(concurrency)
    results: list[tuple[dict, SiteResult]] = []
    answers = answers if answers is not None else {}

    async def one(job: dict):
        async with sem:
            res = await run_program(ctx, job["url"], program, variables=job.get("variables"),
                                    on_event=on_event, on_action=on_action,
                                    run_tag=str(job.get("key", "")), ask=ask, answers=answers,
                                    constraints=constraints)
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
