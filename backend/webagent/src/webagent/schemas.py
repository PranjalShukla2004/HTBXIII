import time
from typing import Literal, Optional
from pydantic import BaseModel, Field

# ---------- Recording ----------
class TraceEvent(BaseModel):
    kind: Literal["click", "fill", "select", "check", "press", "navigate", "extract"]
    el: dict = {}
    value: Optional[str] = None
    url: str
    title: Optional[str] = None
    t: float

class Trace(BaseModel):
    start_url: str
    recorded_at: float = Field(default_factory=time.time)
    events: list[TraceEvent]

# ---------- Intent program (site-independent) ----------
class Step(BaseModel):
    op: Literal["navigate_to", "search", "click", "fill", "select", "check",
                "press", "verify", "extract"]
    target: str
    value: Optional[str] = None      # may contain {{var}}
    output: Optional[str] = None     # extract only: output column name, e.g. "price"
    optional: bool = False

class IntentProgram(BaseModel):
    goal: str
    variables: dict[str, str]        # inputs  -> sheet input columns
    outputs: list[str] = []          # outputs -> sheet output columns
    steps: list[Step]

# ---------- Execution ----------
class Binding(BaseModel):
    step: int
    locator: dict
    action: Optional[str] = None
    value: Optional[str] = None
    repeat: int = 1

class SiteResult(BaseModel):
    url: str
    status: Literal["pending", "navigating", "acting", "done",
                    "dry_run", "needs_human", "failed"] = "pending"
    variables: dict = {}             # inputs used for this run
    outputs: dict = {}               # extracted values, e.g. {"price": "£12.99", ...}
    bindings: list[Binding] = []
    screenshot: Optional[str] = None
    error: Optional[str] = None
    # Only filled when the run had constraints: one entry per distinct product put in the basket,
    # e.g. {"product_name": "...", "price": "£24.99", "product_url": "https://..."}.
    items: list[dict] = []
    note: Optional[str] = None       # e.g. "found 2 of 3 items within £30"

# ---------- What the shopper asked for, beyond the skill's own inputs ----------
class Constraints(BaseModel):
    items: int = Field(default=1, ge=1, le=10)          # DISTINCT products wanted from each shop
    max_price: Optional[float] = Field(default=None, gt=0)       # per item
    total_budget: Optional[float] = Field(default=None, gt=0)    # for all items together
    currency: Optional[str] = None                      # ISO code or symbol, e.g. "GBP" / "£"
    requirements: list[str] = []                        # e.g. ["women's", "high-waisted"]

    def active(self) -> bool:
        return (self.items > 1 or self.max_price is not None
                or self.total_budget is not None or bool(self.requirements))

# ---------- Progress events (streamed to the frontend) ----------
class AgentEvent(BaseModel):
    kind: Literal["log", "status", "step", "error", "done"]
    site: Optional[str] = None
    message: str = ""
    data: dict = {}
    t: float = Field(default_factory=time.time)

class RunPlan(BaseModel):
    variables: dict[str, str]
    sites: list[str]
    sheet_url: Optional[str] = None
    summary: str = ""
    choices: dict[str, str] = {}      # e.g. {"size": "32"}: pre-answered product options
    log_to_sheet: bool = False        # the user asked for results in their Google Sheet
    constraints: Constraints = Field(default_factory=Constraints)
