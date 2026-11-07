import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]      # HTBXIII/backend/webagent
REPO_ROOT = ROOT.parents[1]                     # HTBXIII
for env_path in (ROOT / ".env", REPO_ROOT / ".env"):
    if env_path.exists():
        load_dotenv(env_path)

DATA = ROOT / "data"
for sub in ("traces", "intents", "cache", "results", "logs"):
    (DATA / sub).mkdir(parents=True, exist_ok=True)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = os.getenv("MODEL", "gemini-3.8-flash")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL") or None
LLM_CONCURRENCY = int(os.getenv("LLM_CONCURRENCY", "2"))
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "60"))
HEADLESS = os.getenv("HEADLESS", "0") == "1"
CHROMIUM_PATH = os.getenv("CHROMIUM_PATH") or None
PROFILE_DIR = Path(os.getenv("PROFILE_DIR", str(REPO_ROOT / ".agent-profile")))
DEFAULT_SHEET_URL = os.getenv("DEFAULT_SHEET_URL") or None

if not GEMINI_API_KEY:
    raise RuntimeError(f"GEMINI_API_KEY missing; put it in {REPO_ROOT / '.env'}")