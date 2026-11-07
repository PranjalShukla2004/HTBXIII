import time
from typing import Literal, Optional
from pydantic import BaseModel, Field

# ---------- Recording ----------
class TraceEvent(BaseModel):
    kind: Literal["click", "fill", "select", "check", "press", "navigate"]
    el: dict = {}                    # semantic description of the element
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
    op: Literal["navigate_to", "search", "click", "fill", "select", "check", "press", "verify"]
    target: str                      # meaning, e.g. "size option matching {{size}}"
    value: Optional[str] = None      # may contain {{var}}
    optional: bool = False

class IntentProgram(BaseModel):
    goal: str
    variables: dict[str, str]
    steps: list[Step]

# ---------- Execution ----------
class Binding(BaseModel):
    step: int
    locator: dict                    # {"role":..,"name":..} | {"label":..} | {"css":..}
    value: Optional[str] = None

class SiteResult(BaseModel):
    url: str
    status: Literal["pending", "navigating", "acting", "done",
                    "dry_run", "needs_human", "failed"] = "pending"
    bindings: list[Binding] = []
    screenshot: Optional[str] = None
    error: Optional[str] = None

# ---------- Progress events (streamed to the frontend later) ----------
class AgentEvent(BaseModel):
    kind: Literal["log", "status", "step", "error", "done"]
    site: Optional[str] = None
    message: str = ""
    data: dict = {}
    t: float = Field(default_factory=time.time)