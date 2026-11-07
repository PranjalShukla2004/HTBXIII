import json, re
from .config import ROOT, DEFAULT_SHEET_URL
from .llm import llm_json
from .schemas import IntentProgram, RunPlan

STORES_FILE = ROOT / "stores.json"
SHEET_RE = re.compile(r"https://docs\.google\.com/spreadsheets/d/[\w-]+[^\s'\"]*")

PLAN_SYSTEM = """You turn a user's chat request into a run plan for a browser agent that has
learned ONE shopping skill. You get the skill's goal, its input variables (with the values
used when it was recorded), a list of checked shops, and the user's message.

Return ONLY JSON:
{"variables": {"<input name>": "<value>", ...},
 "choices": {"<option name>": "<value>", ...},
 "sites": ["https://...", ...],
 "summary": "one sentence describing what the agent will do"}

Rules:
- Give a value for EVERY input variable. Take values from the message. If the message
  does not mention one: use 1 for a quantity, otherwise keep the recorded value unless it
  clearly belongs to a different product (then choose something sensible for this item).
- Keep the search query short and generic (e.g. "jeans", "black jeans"); put product
  options like size, colour, fit, waist or length in "choices" instead, NOT in the query.
- choices: product options the user stated that are not input variables, with snake_case
  names: e.g. "size", "colour", "fit", "waist", "length". Only what the user actually said;
  use {} if they said none. Never invent a size.
- sites: if the user names shops or URLs, use exactly those (full https URLs).
  Otherwise choose from the checked shops the ones that plausibly sell the item: if the
  user asks for a number of shops choose that many, otherwise choose up to 5.
  Only use shops outside the checked list if the user explicitly names them.
- The skill only adds to cart; never plan checkout or payment.
"""

def load_stores() -> list[dict]:
    return json.loads(STORES_FILE.read_text()) if STORES_FILE.exists() else []

def _norm(u: str) -> str:
    u = u.strip().rstrip("/.,")
    return u if u.startswith(("http://", "https://")) else "https://" + u

def _snake(s: str) -> str:
    return re.sub(r"\W+", "_", str(s).lower()).strip("_")

async def plan_from_chat(message: str, program: IntentProgram) -> RunPlan:
    m = SHEET_RE.search(message)
    sheet_url = m.group(0) if m else DEFAULT_SHEET_URL
    user = json.dumps({
        "skill_goal": program.goal,
        "inputs_with_recorded_values": program.variables,
        "checked_shops": load_stores(),
        "message": SHEET_RE.sub("[sheet link]", message),
    }, indent=1)
    out = await llm_json(PLAN_SYSTEM, user, tag="plan")
    out = out if isinstance(out, dict) else {}
    chosen = out.get("variables") or {}
    variables = {k: str(chosen.get(k) or v) for k, v in program.variables.items()}
    choices = {_snake(k): str(v).strip() for k, v in (out.get("choices") or {}).items()
               if v not in (None, "") and _snake(k) and _snake(k) not in variables}
    sites = list(dict.fromkeys(_norm(s) for s in out.get("sites", []) if s))
    if not sites:
        raise ValueError("planner chose no sites; add shops to stores.json or name them in the message")
    return RunPlan(variables=variables, sites=sites, sheet_url=sheet_url,
                   summary=out.get("summary", ""), choices=choices)