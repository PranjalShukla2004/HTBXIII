"""API adapter for the existing source-based agent package."""

import sys
from pathlib import Path

# webagent derives its .env/data paths from its source location. Explicitly
# include src because this Mac repeatedly hides the editable-install .pth file.
AGENT_ROOT = Path(__file__).resolve().parents[2] / "webagent"
if str(AGENT_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT / "src"))
