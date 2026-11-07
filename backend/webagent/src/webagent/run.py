import asyncio, json, re, sys
from typing import Callable, Optional
from urllib.parse import urlparse
from playwright.async_api import Browser
from .abstract import VAR, FORBIDDEN
from .browser import launch
from .config import DATA
from .llm import llm_json
from .page import describe_page, format_elements, act, settle, page_text
from .schemas import IntentProgram, Step, SiteResult, Binding, AgentEvent

MAX_HOPS = 2

GROUND_SYSTEM = """You operate a web browser on an online shop you have never seen before.
You get ONE step of a site-independent shopping program, the current page, and a
numbered list of the page's interactive elements. Decide what to do for THIS step only.

Return ONLY JSON:
{"status": "ok" | "move" | "already_done" | "not_found" | "needs_human",
 "element_id": integer or null,
 "value": string or null,
 "reason": "short explanation"}

status meanings:
- ok: element_id performs the step. For fill/search put the text to type in value.
  For select put the EXACT option text from that element's options list.
- move: the step cannot be done on this page, but element_id is a link or button that
  very likely leads to a page where it can (e.g. a "Products"/"Shop" link to reach a
  search box, a basket icon to reach the basket page).
- already_done: the page already satisfies the step (e.g. already on the target page,
  quantity already equals the value).
- not_found: nothing here does the step and nothing obviously leads to it.
- needs_human: a CAPTCHA, login wall, age gate or similar blocks progress.

Rules:
- Match by meaning, not exact wording: "Add to basket", "Add to bag", "Buy" (on a
  product page) all mean add to cart.
- To pick a product, compare the step against the element's text and ctx (its product card).
- Prefer elements in the main content over header/footer, except the site search box.
- A cookie/consent banner covering the page: if the step cannot otherwise proceed, answer
  move with its accept/close button.
- NEVER choose anything that leads to checkout, payment, login, registration or an account.
"""

VERIFY_SYSTEM = """You check whether a condition holds on a web page, given its visible text.
Return ONLY JSON: {"passed": true|false, "evidence": "short quote or reason"}"""

class StepFailed(Exception):
    pass

def render(s: Optional[str], variables: dict) -> Optional[str]:
    return VAR.sub(lambda m: variables.get(m.group(1), m.group(0)), s) if s else s

def slug(url: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", urlparse(url).netloc.lower()).strip("_")

def forbidden(el: dict) -> bool:
    return bool(FORBIDDEN.search(" ".join(str(el.get(k, "")) for k in ("text", "aria", "title", "href"))))

async def ground(page, program: IntentProgram, step: Step, target: str, value: Optional[str],
                 els: list[dict]) -> dict:
    u = urlparse(page.url)
    user = (f"OVERALL GOAL: {program.goal}\n"
            f"STEP: op={step.op}\nTARGET: {target}\nVALUE: {value}\n\n"
            f"PAGE: title={await page.title()!r} path={u.path}{'?' + u.query if u.query else ''}\n"
            f"ELEMENTS:\n{format_elements(els)}")
    return await llm_json(GROUND_SYSTEM, user, tag="ground")

async def verify(page, condition: str) -> dict:
    text = await page_text(page)
    return await llm_json(VERIFY_SYSTEM, f"CONDITION: {condition}\n\nPAGE TEXT:\n{text}", tag="verify")

async def run_program(browser: Browser, url: str, program: IntentProgram, *,
                      variables: Optional[dict] = None,
                      on_event: Optional[Callable[[AgentEvent], None]] = None,
                      on_action: Optional[Callable[[dict], None]] = None) -> SiteResult:
    vars_ = {**program.variables, **(variables or {})}
    result = SiteResult(url=url, status="navigating")

    def emit(kind, message, **data):
        if on_event:
            on_event(AgentEvent(kind=kind, site=url, message=message, data=data))

    context = await browser.new_context(viewport={"width": 1366, "height": 900})
    page = await context.new_page()
    try:
        await page.goto(url, wait_until="domcontentloaded")
        await settle(page)
        result.status = "acting"
        emit("status", "acting")

        for i, step in enumerate(program.steps):
            target, value = render(step.target, vars_), render(step.value, vars_)

            if step.op == "verify":
                v = await verify(page, target)
                emit("step", f"verify '{target}': {v.get('passed')} ({v.get('evidence')})", step=i)
                if not v.get("passed") and not step.optional:
                    raise StepFailed(f"verify failed: {target}")
                continue

            for hop in range(MAX_HOPS + 1):
                els = await describe_page(page)
                g = await ground(page, program, step, target, value, els)
                status, eid = g.get("status"), g.get("element_id")
                el = next((e for e in els if e["id"] == eid), None)
                emit("step", f"{step.op} '{target}' -> {status} [{eid}] {g.get('reason', '')}", step=i)

                if status in ("ok", "move") and el is None:
                    status = "not_found"
                if el is not None and forbidden(el):
                    raise StepFailed(f"refused forbidden element: {el.get('text') or el.get('href')}")

                if status == "move" and hop < MAX_HOPS:
                    await act(page, el, "click")
                    if on_action:
                        on_action({"step": i, "op": "click", "target": target,
                                   "element": el, "navigation_hop": True, "url": page.url})
                    await settle(page)
                    continue                       # retry the same step on the new page
                break

            if status == "needs_human":
                result.status = "needs_human"
                result.error = g.get("reason")
                emit("status", "needs_human", reason=result.error)
                return result
            if status == "already_done":
                continue
            if status != "ok":
                if step.optional:
                    emit("log", f"skipped optional step {i}: {target}")
                    continue
                raise StepFailed(f"step {i} ({step.op} '{target}'): {status} - {g.get('reason')}")

            typed = g.get("value") or value
            await act(page, el, step.op, typed)
            if on_action:
                on_action({"step": i, "op": step.op, "target": target,
                           "value": typed, "element": el, "url": page.url})
            await settle(page)
            result.bindings.append(Binding(
                step=i, value=typed,
                locator={k: el[k] for k in ("tag", "type", "label", "aria", "ph", "name", "text", "href") if el.get(k)}))

        result.status = "done"
        emit("status", "done")
    except StepFailed as e:
        result.status, result.error = "failed", str(e)
        emit("error", str(e))
    except Exception as e:
        result.status, result.error = "failed", f"{type(e).__name__}: {e}"
        emit("error", result.error)
    finally:
        shot = DATA / "results" / f"{slug(url)}.png"
        try:
            await page.screenshot(path=shot)
            result.screenshot = str(shot)
        except Exception:
            pass
        (DATA / "results" / f"{slug(url)}.json").write_text(result.model_dump_json(indent=1))
        await context.close()
    return result

# ---------- CLI ----------
# uv run python -m webagent.run <intent_name> <url> [var=value ...]
async def _main():
    name, url = sys.argv[1], sys.argv[2]
    overrides = dict(a.split("=", 1) for a in sys.argv[3:])
    program = IntentProgram.model_validate_json((DATA / "intents" / f"{name}.json").read_text())

    def show(ev: AgentEvent):
        print(f"[{ev.kind:6}] {ev.message}")

    async with launch() as browser:
        result = await run_program(browser, url, program, variables=overrides, on_event=show)
    print(f"\nRESULT: {result.status}" + (f" - {result.error}" if result.error else ""))
    print(f"screenshot: {result.screenshot}")

if __name__ == "__main__":
    asyncio.run(_main())
