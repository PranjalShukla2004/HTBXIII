import json, re
from .config import ROOT, DEFAULT_SHEET_URL
from .llm import llm_json
from .schemas import Constraints, IntentProgram, RunPlan

STORES_FILE = ROOT / "stores.json"
SHEET_RE = re.compile(r"https://docs\.google\.com/spreadsheets/d/[\w-]+[^\s'\"]*")
SHEET_WORDS = re.compile(r"\b(spread\s*sheet|sheets?|google sheet)\b", re.I)
VAR = re.compile(r"\{\{(\w+)\}\}")
QTY_VAR = re.compile(r"qty|quantit", re.I)
DEFAULT_SITES = 4        # shops to use when the message names none and gives no number of shops
NUMBER = r"\d+|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few|several"
SHOP_COUNT = re.compile(rf"\b({NUMBER})\s+(different\s+|more\s+|other\s+)?(sites|shops|stores|websites|retailers)\b", re.I)
URL_IN_TEXT = re.compile(r"https?://|\bwww\.|\b[\w-]+\.(com|co\.uk|uk|net|org|shop|store)\b", re.I)
# Inputs that are the shopper's personal choice: never guessed, asked for when a shop needs them.
OPTION_VAR = re.compile(r"size|colou?r|fit|waist|length|leg|width|style|variant|shade|flavou?r|storage|capacity", re.I)

PLAN_SYSTEM = """You turn a user's chat request into a run plan for a browser agent that has
learned ONE skill: shopping, sending an email, or another web task. You get the skill's goal,
its input variables (with the values used when it was recorded), a list of checked shops
(only relevant to shopping skills), and the user's message.

Return ONLY JSON:
{"variables": {"<input name>": "<value>", ...},
 "choices": {"<option name>": "<value>", ...},
 "constraints": {"items": <int>, "max_price": <number or null>, "total_budget": <number or null>,
                 "currency": "<ISO code like GBP/USD/EUR, or null>", "requirements": ["...", ...]},
 "sites": ["https://...", ...],
 "user_chose_sites": true | false,
 "summary": "one sentence describing what the agent will do"}

Rules:
- Give a value for EVERY input variable. Take values from the message.
  - For an email skill: the recipient address, subject and body; write a short, natural
    subject or body if the user only describes it.
  - The search query: short and generic (e.g. "jeans", "black jeans"). Put product options
    like size, colour, fit, waist or length in "choices" or "requirements", NOT in the query.
  - A quantity input means copies of the SAME product: use the number only when the user
    asks for several of the same item ("2 of the same", "quantity 3", "3 packs of this").
    Otherwise use 1.
  - Product options that are the shopper's personal choice (size, colour, fit, waist,
    length, ...): the value the user stated, otherwise "" (empty). NEVER guess or keep the
    recorded value for these: the agent asks the shopper if a shop needs it.
  - Anything else the message does not mention: keep the recorded value unless it clearly
    belongs to a different item (then choose something sensible for this item).
- choices: product options the user stated that are not input variables, with snake_case
  names: e.g. "size", "colour", "fit", "waist", "length". Only what the user actually said;
  use {} if they said none. Never invent a size.
- constraints (shopping skills; for other skills use items 1, no prices, no requirements):
  - items: how many DIFFERENT products the user wants from each shop ("3 jeans",
    "a few options", "two jackets" -> 3 / 3 / 2). Default 1. Not the number of shops.
  - max_price: the most ONE item may cost ("under £30", "below 30 pounds", "max $50",
    "less than 20 euros" -> 30 / 30 / 50 / 20). null if no budget.
  - total_budget: only if the user gives a budget for everything together ("£100 in total").
  - currency: the budget's currency (GBP for £/pounds, USD for $/dollars, EUR for €/euros).
  - requirements: other things each chosen product must satisfy that the search query does
    not already say (e.g. "women's", "high-waisted", "blue", "cotton"). [] if none.
- sites: if the user names websites, apps or URLs, use exactly those as full https URLs
  (e.g. Outlook -> https://outlook.office.com/mail/, Gmail -> https://mail.google.com/mail/u/0/,
  Zara -> https://www.zara.com/uk/). For a shopping skill with no shops named, choose from the
  checked shops the ones that most plausibly sell the item: if the user asks for a number of
  SHOPS ("on 3 sites", "check 6 stores") choose that many, otherwise choose exactly 4 (fewer
  only if fewer shops sell it). Prefer well-known shops that sell the item over demo/test
  shops. A number of items is not a number of shops. Only use shops outside the checked list
  if the user explicitly names them. Skip shops whose description says they need a login.
  For other skills with no site named, use the site the skill was recorded on, given as
  "recorded_on".
- user_chose_sites: true if the user named shops/URLs or said how many shops to use, else false.
- The skill only adds to cart; never plan checkout or payment.
"""

def load_stores() -> list[dict]:
    return json.loads(STORES_FILE.read_text()) if STORES_FILE.exists() else []

def _norm(u: str) -> str:
    u = u.strip().rstrip("/.,")
    return u if u.startswith(("http://", "https://")) else "https://" + u

def _snake(s: str) -> str:
    return re.sub(r"\W+", "_", str(s).lower()).strip("_")

def _number(value) -> float | None:
    try:
        n = float(re.sub(r"[^\d.]", "", str(value).replace(",", "")))
    except ValueError:
        return None
    return n if n > 0 else None

def _constraints(raw) -> Constraints:
    raw = raw if isinstance(raw, dict) else {}
    try:
        items = min(max(int(float(raw.get("items") or 1)), 1), 10)
    except (TypeError, ValueError):
        items = 1
    currency = str(raw.get("currency") or "").strip() or None
    requirements = [str(r).strip() for r in (raw.get("requirements") or []) if str(r).strip()][:8]
    return Constraints(items=items, max_price=_number(raw.get("max_price")) if raw.get("max_price") else None,
                       total_budget=_number(raw.get("total_budget")) if raw.get("total_budget") else None,
                       currency=currency, requirements=requirements)

def _variables(program: IntentProgram, chosen: dict) -> dict[str, str]:
    # The search query and a quantity always need a value; personal options may stay empty.
    needs_value = {v for s in program.steps if s.op == "search" for v in VAR.findall(s.value or "")}
    needs_value |= {k for k in program.variables if QTY_VAR.search(k)}
    out = {}
    for name, recorded in program.variables.items():
        given = chosen.get(name)
        given = None if given is None else str(given).strip()
        if name in needs_value:
            out[name] = given or recorded
        elif given is None:
            out[name] = "" if OPTION_VAR.search(name) else recorded
        else:
            out[name] = given
    return out

async def plan_from_chat(message: str, program: IntentProgram, recorded_on: str = "") -> RunPlan:
    m = SHEET_RE.search(message)
    sheet_url = m.group(0) if m else DEFAULT_SHEET_URL
    log_to_sheet = bool(m) or bool(SHEET_WORDS.search(message))
    user = json.dumps({
        "skill_goal": program.goal,
        "recorded_on": recorded_on,
        "inputs_with_recorded_values": program.variables,
        "checked_shops": load_stores(),
        "message": SHEET_RE.sub("[sheet link]", message),
    }, indent=1)
    out = await llm_json(PLAN_SYSTEM, user, tag="plan")
    out = out if isinstance(out, dict) else {}
    variables = _variables(program, out.get("variables") or {})
    choices = {_snake(k): str(v).strip() for k, v in (out.get("choices") or {}).items()
               if v not in (None, "") and _snake(k) and _snake(k) not in variables}
    sites = list(dict.fromkeys(_norm(s) for s in out.get("sites", []) if s))
    # Unless the user named shops or said how many, use DEFAULT_SITES of them.
    # Short one-word names ("Next", "Boots") are ordinary words too: match those only as capitalised.
    store_named = any(re.search(rf"\b{re.escape(s['name'])}\b", message,
                                0 if " " not in s["name"] and len(s["name"]) <= 5 else re.I)
                      for s in load_stores() if s.get("name"))
    chose = (out.get("user_chose_sites") is True or bool(SHOP_COUNT.search(message))
             or bool(URL_IN_TEXT.search(SHEET_RE.sub("", message))) or store_named)
    if not chose:
        sites = sites[:DEFAULT_SITES]
    if not sites:
        raise ValueError("planner chose no sites; add shops to stores.json or name them in the message")
    return RunPlan(variables=variables, sites=sites, sheet_url=sheet_url,
                   summary=out.get("summary", ""), choices=choices,
                   log_to_sheet=log_to_sheet and bool(sheet_url),
                   constraints=_constraints(out.get("constraints")))
