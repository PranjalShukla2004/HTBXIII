import asyncio, hashlib, json, re, sys
from typing import Callable, Optional
from urllib.parse import urlparse
from playwright.async_api import BrowserContext, Page
from .abstract import VAR, FORBIDDEN
from .browser import launch
from .config import DATA
from .llm import llm_json, stats
from .page import (describe_page, format_elements, act, act_on, resolve_locator,
                   settle, page_text, dismiss_overlays)
from .schemas import IntentProgram, SiteResult, Binding, AgentEvent

MAX_HOPS = 3
MAX_REPEAT = 20
PAGE_CHANGING = {"search", "click", "press"}
CACHE_KEYS = ("tag", "type", "label", "aria", "ph", "name", "text", "href")

GROUND_SYSTEM = """You operate a web browser on an online shop you have never seen before.
You get the remaining steps of a site-independent shopping program, the current page,
and a numbered list of the page's interactive elements.

Plan the actions to take ON THIS PAGE, starting with the FIRST remaining step. Continue
with the following steps only while they can be done on this same page, and STOP after
any action that loads a new page or substantially changes it (submitting a search,
opening a product, adding to cart, opening the basket).

Return ONLY JSON:
{"actions": [
  {"step": <the step number exactly as shown in brackets>,
   "status": "ok" | "partial" | "move" | "already_done" | "not_found" | "needs_human",
   "element_id": integer or null,
   "action": "fill" | "search" | "select" | "click" | "check" | "press" | null,
   "value": string or null,
   "repeat": integer,
   "reason": "short explanation"}
]}

Status:
- ok: performing this action completes the step.
- partial: this action is needed but the step is not finished yet (e.g. opening a custom
  dropdown before its option can be chosen). It must be the LAST action you return.
- move: the step cannot be done here, but element_id leads to a page where it can
  (e.g. a "Products"/"Shop" link to reach a search box). It must be the LAST action.
- already_done: the page already satisfies the step (e.g. already on the home page,
  quantity already equals value).
- not_found: nothing here does the step and nothing obviously leads to it.
- needs_human: a CAPTCHA, login wall or age gate blocks progress.

Choose the action from the ELEMENT you found, not from the step's wording:
- text or number input -> "fill"; the shop's search box -> "search" (types and presses Enter)
- <select> -> "select", value = the EXACT option text from its options list
- quantity shown with +/- buttons -> "click" the + button with repeat = target minus the
  current value; if the current value already equals the target -> already_done
- custom dropdown that is not a <select> -> "click" it with status "partial"
- checkbox/radio -> "check" with value "true" or "false"
- buttons, links, product tiles, colour/size swatches -> "click"

Rules:
- Match by meaning: "Add to basket", "Add to bag", "Buy" (on a product page) all mean add to cart.
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

def semantic(el: dict) -> dict:
    return {k: el[k] for k in CACHE_KEYS if el.get(k)}

def _step_index(a: dict, default: int) -> int:
    try:
        return int(str(a.get("step")).strip("[] "))
    except (TypeError, ValueError):
        return default

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
    """Replayable only if the step doesn't depend on the item (e.g. not 'product matching {{query}}')."""
    return "{{" not in step.target and not any(
        a["action"] == "click" and a.get("repeat", 1) > 1 for a in acts)

async def replay_step(page: Page, acts: list[dict], value: Optional[str], *,
                      on_action: Optional[Callable[[dict], None]] = None) -> bool:
    for a in acts:
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
                 els: list[dict]) -> list[dict]:
    lines = []
    for k in window:
        s = program.steps[k]
        v = render(s.value, vars_)
        lines.append(f"[{k}] {s.op}: {render(s.target, vars_)}"
                     + (f"  value={v}" if v else "") + ("  (optional)" if s.optional else ""))
    u = urlparse(page.url)
    user = (f"OVERALL GOAL: {render(program.goal, vars_)}\n\n"
            "REMAINING STEPS (start with the first):\n" + "\n".join(lines) + "\n\n"
            f"PAGE: title={await page.title()!r} path={u.path}{'?' + u.query if u.query else ''}\n"
            f"ELEMENTS:\n{format_elements(els)}")
    out = await llm_json(GROUND_SYSTEM, user, tag="ground")
    return (out.get("actions", []) if isinstance(out, dict) else out) or []

async def verify(page: Page, condition: str) -> dict:
    text = await page_text(page)
    return await llm_json(VERIFY_SYSTEM, f"CONDITION: {condition}\n\nPAGE TEXT:\n{text}",
                          tag="verify", cheap=True)

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
                      run_tag: Optional[str] = None) -> SiteResult:
    vars_ = {**program.variables, **(variables or {})}
    steps = program.steps
    verify_idx = [k for k, s in enumerate(steps) if s.op == "verify"]
    final_verify = verify_idx[-1] if verify_idx else None
    result = SiteResult(url=url, status="navigating", variables=vars_)
    cache = load_cache(program, url)
    performed: dict[int, list[dict]] = {}

    def emit(kind, message, **data):
        if on_event:
            on_event(AgentEvent(kind=kind, site=url, message=message, data=data))

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
        while i < len(steps):
            step = steps[i]

            if step.op == "extract":
                j, fields = i, {}
                while j < len(steps) and steps[j].op == "extract":
                    fields[steps[j].output or f"field_{j}"] = render(steps[j].target, vars_)
                    j += 1
                vals = await extract(page, fields)
                result.outputs.update(vals)
                result.outputs.setdefault("product_url", page.url)
                emit("step", f"extract {vals}", step=i, outputs=vals)
                i = j
                continue

            if step.op == "verify":
                if i != final_verify:
                    emit("log", f"skipped intermediate verify {i}")
                    i += 1
                    continue
                target = render(step.target, vars_)
                v = await verify(page, target)
                emit("step", f"verify '{target}': {v.get('passed')} ({v.get('evidence')})", step=i)
                if not v.get("passed") and not step.optional:
                    raise StepFailed(f"verify failed: {target}")
                i += 1
                continue

            # ---- fast path: replay from cache ----
            acts = cache.get(str(i))
            if acts is not None and cacheable(step, acts):
                await dismiss_overlays(page)
                callback = (lambda a: on_action({"step": i, "target": render(step.target, vars_), **a})) \
                    if on_action else None
                if await replay_step(page, acts, render(step.value, vars_), on_action=callback):
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
            actions = await ground(page, program, window, vars_, els)
            if not actions:
                actions = [{"step": i, "status": "not_found", "reason": "empty plan"}]
            start_i = i

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
                repeat = max(1, min(int(a.get("repeat") or 1), MAX_REPEAT))
                last_reason = a.get("reason", "")
                emit("step", f"[{i}] {action}{f' x{repeat}' if repeat > 1 else ''} "
                             f"-> {status} [{eid}] {last_reason}", step=i)

                if status in ("ok", "partial", "move") and el is None:
                    status = "not_found"
                if el is not None and forbidden(el):
                    raise StepFailed(f"refused forbidden element: {el.get('text') or el.get('href')}")

                if status == "needs_human":
                    result.status, result.error = "needs_human", last_reason
                    emit("status", "needs_human", reason=last_reason)
                    return result
                if status == "already_done":
                    if steps[i].value is None:
                        performed.setdefault(i, [])        # nothing to do: replays for free
                    i, hops = i + 1, 0
                    continue
                if status not in ("ok", "partial", "move"):
                    if steps[i].optional:
                        emit("log", f"skipped optional step {i}")
                        i, hops = i + 1, 0
                        continue
                    raise StepFailed(f"step {i} ({steps[i].op} '{render(steps[i].target, vars_)}'): "
                                     f"{status} - {last_reason}")

                for repetition in range(repeat):
                    await act(page, el, action, value)
                    if on_action:
                        on_action({"step": i, "op": action, "target": render(steps[i].target, vars_),
                                   "value": value, "element": el, "url": page.url,
                                   "cached": False, "repeat": repeat, "repetition": repetition + 1,
                                   "navigation_hop": status == "move", "partial": status == "partial"})
                    if repeat > 1:
                        await page.wait_for_timeout(250)
                await settle(page)
                performed.setdefault(i, []).append({"action": action, "locator": semantic(el),
                                                    "value": value, "repeat": repeat, "status": status})

                if status == "ok":
                    result.bindings.append(Binding(step=i, action=action, value=value,
                                                   repeat=repeat, locator=semantic(el)))
                    i, hops = i + 1, 0
                    if action in PAGE_CHANGING:
                        break
                else:
                    hops += 1
                    break

            if i == start_i:
                hops += 1
            if hops > MAX_HOPS:
                raise StepFailed(f"step {i} made no progress after {MAX_HOPS} attempts ({last_reason})")

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
                    on_result=None, concurrency: int = 2) -> list[tuple[dict, SiteResult]]:
    sem = asyncio.Semaphore(concurrency)
    results: list[tuple[dict, SiteResult]] = []

    async def one(job: dict):
        async with sem:
            res = await run_program(ctx, job["url"], program, variables=job.get("variables"),
                                    on_event=on_event, on_action=on_action, run_tag=str(job.get("key", "")))
            results.append((job, res))
            if on_result:
                await on_result(job, res)

    await asyncio.gather(*(one(j) for j in jobs))
    return results

# ---------- CLI ----------
# uv run python -m webagent.run <intent_name> <url> [var=value ...]
async def _main():
    name, url = sys.argv[1], sys.argv[2]
    overrides = dict(a.split("=", 1) for a in sys.argv[3:])
    program = IntentProgram.model_validate_json((DATA / "intents" / f"{name}.json").read_text())

    def show(ev: AgentEvent):
        print(f"[{ev.kind:6}] {ev.message}")

    async with launch() as ctx:
        result = await run_program(ctx, url, program, variables=overrides, on_event=show)
    print(f"\nRESULT: {result.status}" + (f" - {result.error}" if result.error else ""))
    print(f"OUTPUTS: {result.outputs}")
    print(f"LLM calls: {stats['calls']}   screenshot: {result.screenshot}")

if __name__ == "__main__":
    asyncio.run(_main())
