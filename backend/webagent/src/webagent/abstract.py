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
- navigate_to: reach a kind of page by any means (target describes the page)
- search: type a value into the shop's product search box and submit it.
  One search step replaces fill + Enter + clicking the search button.
- click: click an element described by its meaning
- fill / select / check: set a form control
- press: press a key (rarely needed)
- verify: an observable condition proving the previous steps worked
- extract: record a piece of data from the current page. Every "extract" event means the
  user COPIED that text because they want it saved. target = what the data is, by
  meaning (e.g. "the product's current price", "link to the manufacturer's page");
  output = a short snake_case column name (e.g. price, manufacturer_link). The copied
  text itself must NOT appear in the program. Keep extract steps where they occurred.

Rules:
1. Targets describe MEANING, never this site's selectors, classes, ids, URLs or exact
   button wording.
2. Every value the user TYPED or CHOSE becomes an input variable in "variables", with the
   recorded value as its default, referenced in steps as {{name}} (snake_case: query,
   quantity, size, colour). Copied (extracted) values are outputs, not variables.
3. Choose the product the user clicked by its relation to the variables (e.g. the best
   match for {{query}}), not by its literal name.
4. Mark optional=true for steps a similar shop may not have (quantity box, size or
   colour picker, cookie banner) and for extract steps whose data may be missing
   (e.g. manufacturer link).
5. After an important state change add a verify step for its observable effect.
6. NEVER include checkout, login, registration, address or payment steps.
7. "goal" is one sentence written in terms of the variables and outputs.

Return ONLY JSON with this shape:
{"goal": str,
 "variables": {"name": "default value", ...},
 "outputs": ["output_name", ...],
 "steps": [{"op": str, "target": str, "value": str or null,
            "output": str or null, "optional": bool}, ...]}
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
    if ev.kind == "extract":
        d["element"]["is_link"] = bool(ev.el.get("href"))
        d["copied_text"] = ev.value
    elif ev.value is not None:
        d["value"] = ev.value
    return d

def lint(p: IntentProgram, copied: list[str]) -> tuple[list[str], list[str]]:
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
        for c in copied:
            if len(c) > 3 and c.lower() in text.lower():
                errors.append(f"step {i} contains copied text {c!r}; describe the data instead")
        if s.op == "extract":
            if not s.output:
                errors.append(f"extract step {i} has no output name")
            elif s.output not in p.outputs:
                errors.append(f"extract step {i} output {s.output!r} missing from outputs")
    for name in p.variables.keys() - used:
        warnings.append(f"variable {name!r} is never used")
    if not any(s.op == "verify" for s in p.steps):
        warnings.append("no verify step")
    return errors, warnings

async def abstract(trace: Trace, max_attempts: int = 2) -> tuple[IntentProgram, list[str]]:
    events = [compact(e) for e in trace.events]
    copied = [e.value for e in trace.events if e.kind == "extract" and e.value]
    user = "Recorded session:\n" + json.dumps(events, indent=1)
    feedback = ""
    for attempt in range(max_attempts):
        raw = await llm_json(SYSTEM, user + feedback, tag="abstract")
        try:
            program = IntentProgram.model_validate(raw)
        except ValidationError as e:
            feedback = f"\n\nYour previous answer was invalid:\n{e}\nFix it."
            continue
        errors, warnings = lint(program, copied)
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

    print(f"GOAL: {program.goal}\nINPUTS: {program.variables}\nOUTPUTS: {program.outputs}\n")
    for i, s in enumerate(program.steps):
        opt = " (optional)" if s.optional else ""
        val = f"  <- {s.value}" if s.value else ""
        outp = f"  -> [{s.output}]" if s.output else ""
        print(f"{i:2}. {s.op:12} {s.target}{val}{outp}{opt}")
    for w in warnings:
        print(f"warning: {w}")
    print(f"\nSaved to {out}")

if __name__ == "__main__":
    asyncio.run(_main())