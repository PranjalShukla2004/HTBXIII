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