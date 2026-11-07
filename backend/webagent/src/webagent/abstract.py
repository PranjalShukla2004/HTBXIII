import asyncio, json, re, sys
from urllib.parse import urlparse
from pydantic import ValidationError
from .config import DATA
from .llm import llm_json
from .schemas import Trace, TraceEvent, IntentProgram

SYSTEM = """You turn a recorded e-commerce browsing session into a SITE-INDEPENDENT intent
program. Another agent will replay it on OTHER online shops with different layouts,
wording and URLs, so nothing in it may depend on this particular site.

Allowed ops:
- navigate_to: reach a kind of page by any means (target describes the page, e.g. "shopping cart page")
- search: type a value into the shop's product search box and submit it.
  One search step replaces fill + Enter + clicking the search button.
- click: click an element described by its meaning
- fill / select / check: set a form control (text box, dropdown, checkbox/radio)
- press: press a key (rarely needed)
- verify: an observable condition proving the previous steps worked

Rules:
1. Targets describe MEANING, never this site's selectors, classes, ids, URLs or exact
   button wording. Good: "product in the search results that best matches {{query}}".
   Bad: "div.product-item", "the Smartphone link", "button labelled 'Add to cart'".
2. Every value the user typed or chose becomes a variable in "variables", with the
   recorded value as its default, referenced in steps as {{name}}. Use snake_case
   names such as query, quantity, size, colour.
3. Choose the product the user clicked by its relation to the variables (e.g. the
   best match for {{query}}), not by its literal name. Only if nothing the user typed
   identifies it, add a variable product_name holding its name.
4. Mark optional=true for steps a similar shop may not have (quantity box, size or
   colour picker, cookie banner).
5. After an important state change add a verify step for its observable effect
   (e.g. "basket count increases or a confirmation that the product was added").
6. NEVER include checkout, login, registration, address or payment steps. The program
   ends at or before viewing the basket/cart.
7. "goal" is one sentence written in terms of the variables.

Return ONLY JSON with this shape:
{"goal": str,
 "variables": {"name": "default value", ...},
 "steps": [{"op": str, "target": str, "value": str or null, "optional": bool}, ...]}
"""

KEEP = ("tag", "type", "role", "label", "aria_label", "placeholder",
        "title", "alt", "text", "context")
FORBIDDEN = re.compile(r"\b(checkout|check out|payment|pay now|place order|login|log in|sign in|register)\b", re.I)
VAR = re.compile(r"\{\{(\w+)\}\}")

def compact(ev: TraceEvent) -> dict:
    """Strip everything site-specific; keep what a human would see."""
    if ev.kind == "navigate":
        u = urlparse(ev.url)
        return {"kind": "navigate", "path": u.path + (f"?{u.query}" if u.query else "")}
    d = {"kind": ev.kind, "page_title": ev.title,
         "element": {k: v for k, v in ev.el.items() if k in KEEP}}
    if ev.value is not None:
        d["value"] = ev.value
    return d

def lint(p: IntentProgram) -> tuple[list[str], list[str]]:
    """Return (errors, warnings). Errors trigger a retry."""
    errors, warnings = [], []
    used = set()
    for i, s in enumerate(p.steps):
        text = f"{s.target} {s.value or ''}"
        refs = set(VAR.findall(text))
        used |= refs
        for r in refs - p.variables.keys():
            errors.append(f"step {i} uses undeclared variable {{{{{r}}}}}")
        if FORBIDDEN.search(text):
            errors.append(f"step {i} mentions a forbidden action: {s.target!r}")
        for name, val in p.variables.items():
            if len(val) > 2 and val.lower() in VAR.sub("", text).lower():
                errors.append(f"step {i} hard-codes {val!r}; use {{{{{name}}}}} instead")
    for name in p.variables.keys() - used:
        warnings.append(f"variable {name!r} is never used")
    if not any(s.op == "verify" for s in p.steps):
        warnings.append("no verify step")
    return errors, warnings

async def abstract(trace: Trace, max_attempts: int = 2) -> tuple[IntentProgram, list[str]]:
    events = [compact(e) for e in trace.events]
    user = "Recorded session:\n" + json.dumps(events, indent=1)
    feedback = ""
    for attempt in range(max_attempts):
        raw = await llm_json(SYSTEM, user + feedback, tag="abstract")
        try:
            program = IntentProgram.model_validate(raw)
        except ValidationError as e:
            feedback = f"\n\nYour previous answer was invalid:\n{e}\nFix it."
            continue
        errors, warnings = lint(program)
        if not errors:
            return program, warnings
        feedback = ("\n\nYour previous answer had these problems:\n- " + "\n- ".join(errors) +
                    f"\nPrevious answer:\n{json.dumps(raw)}\nReturn a corrected program.")
    raise ValueError(f"abstraction failed after {max_attempts} attempts: {feedback.strip()}")

# ---------- CLI ----------
async def _main():
    name = sys.argv[1] if len(sys.argv) > 1 else "trace"
    trace = Trace.model_validate_json((DATA / "traces" / f"{name}.json").read_text())
    program, warnings = await abstract(trace)
    out = DATA / "intents" / f"{name}.json"
    out.write_text(program.model_dump_json(indent=1))

    print(f"GOAL: {program.goal}\nVARIABLES: {program.variables}\n")
    for i, s in enumerate(program.steps):
        opt = " (optional)" if s.optional else ""
        val = f"  <- {s.value}" if s.value else ""
        print(f"{i:2}. {s.op:12} {s.target}{val}{opt}")
    for w in warnings:
        print(f"warning: {w}")
    print(f"\nSaved to {out}")

if __name__ == "__main__":
    asyncio.run(_main())