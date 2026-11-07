import asyncio, json, re, time
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Callable
from uuid import uuid4
from google import genai
from google.genai import types, errors
from .config import (MODEL, FALLBACK_MODEL, DATA, GEMINI_API_KEY,
                     LLM_CONCURRENCY, LLM_TIMEOUT)

try:   # turn off the SDK's own hidden retries; we handle failover ourselves
    client = genai.Client(api_key=GEMINI_API_KEY, http_options=types.HttpOptions(
        retry_options=types.HttpRetryOptions(attempts=1)))
except (AttributeError, TypeError):
    client = genai.Client(api_key=GEMINI_API_KEY)

_sem = asyncio.Semaphore(LLM_CONCURRENCY)
stats = {"calls": 0}
STATUS_FILE = DATA / "model_status.json"
_observer: ContextVar[Callable[[dict], None] | None] = ContextVar("llm_observer", default=None)

@contextmanager
def observe_llm(callback: Callable[[dict], None]):
    """Opt into generated-text streaming for this task; CLI calls stay unchanged."""
    token = _observer.set(callback)
    try:
        yield
    finally:
        _observer.reset(token)

def _notify(kind: str, **data):
    callback = _observer.get()
    if callback:
        try:
            callback({"type": kind, **data})
        except Exception:
            logging.getLogger(__name__).warning("LLM observer failed", exc_info=True)

async def _generate(model, user, cfg, metadata):
    if _observer.get() is None:
        response = await client.aio.models.generate_content(model=model, contents=user, config=cfg)
        return response.text or ""
    chunks = []
    stream = await client.aio.models.generate_content_stream(model=model, contents=user, config=cfg)
    try:
        async for chunk in stream:
            if chunk.text:
                chunks.append(chunk.text)
                _notify("llm.delta", **metadata, text=chunk.text)
    finally:
        if close := getattr(stream, "aclose", None):
            await close()
    return "".join(chunks)

class LLMError(Exception):
    pass

def _load_status() -> dict[str, float]:
    try:
        now = time.time()
        return {m: t for m, t in json.loads(STATUS_FILE.read_text()).items() if t > now}
    except Exception:
        return {}

_unavailable: dict[str, float] = _load_status()      # model -> time it becomes usable again

def _mark(model: str, seconds: float, persist: bool = False):
    _unavailable[model] = time.time() + seconds
    if persist:
        now = time.time()
        STATUS_FILE.write_text(json.dumps(
            {m: t for m, t in _unavailable.items() if t - now > 300}, indent=1))

def _extract_json(text: str):
    text = re.sub(r"```(?:json)?", "", text)
    match = re.search(r"(\{.*\}|\[.*\])", text, re.S)
    if not match:
        raise LLMError(f"No JSON in response: {text[:300]}")
    return json.loads(match.group(1))

def _retry_delay(e: Exception) -> float | None:
    m = re.search(r"retryDelay['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)s", str(e))
    return float(m.group(1)) if m else None

def _daily_exhausted(e: Exception) -> bool:
    d = _retry_delay(e)
    return "PerDay" in str(e) or (d is not None and d > 300)

async def llm_json(system: str, user: str, *, max_tokens: int = 8192, tag: str = "llm",
                   retries: int = 6, cheap: bool = False):
    cfg = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        max_output_tokens=max_tokens,
        temperature=0,
    )
    fallbacks = [m.strip() for m in (FALLBACK_MODEL or "").split(",") if m.strip()]
    models = [MODEL] + [m for m in fallbacks if m != MODEL]
    if cheap:
        models.sort(key=lambda m: "lite" not in m)
    text, model = None, None
    call_id = uuid4().hex
    metadata = {"call_id": call_id, "tag": tag, "model": models[0], "attempt": 0}

    for attempt in range(retries + len(models)):
        now = time.time()
        live = [m for m in models if _unavailable.get(m, 0) <= now]
        if not live:
            wait = min(_unavailable[m] for m in models) - now
            if wait > 90:
                _notify("llm.error", **metadata, code="models_unavailable", retry_after_seconds=wait)
                raise LLMError("all Gemini models are out of quota for now (daily limits reset "
                               "~08:00 UK); enable billing or use another project's key")
            _notify("llm.retry", **metadata, code="models_busy", wait_seconds=wait)
            print(f"[llm:{tag}] all models busy, waiting {wait:.0f}s")
            await asyncio.sleep(wait)
            continue
        model = live[0]
        metadata = {"call_id": call_id, "tag": tag, "model": model, "attempt": attempt + 1}
        _notify("llm.start", **metadata)
        try:
            async with _sem:
                text = await asyncio.wait_for(
                    _generate(model, user, cfg, metadata),
                    timeout=LLM_TIMEOUT)
            stats["calls"] += 1
            break
        except (errors.APIError, TimeoutError) as e:
            code = getattr(e, "code", "timeout")
            if code == 404:
                _mark(model, 86400, persist=True)
            elif code == 429 and _daily_exhausted(e):
                _mark(model, _retry_delay(e) or 6 * 3600, persist=True)
            elif code == 429:
                _mark(model, min(_retry_delay(e) or 20, 90))
            elif code in (500, 503, "timeout"):
                _mark(model, 120)
            else:
                _notify("llm.error", **metadata, code=code)
                raise
            _notify("llm.retry", **metadata, code=code, wait_seconds=0, switching_model=True)
            print(f"[llm:{tag}] {model} -> {code}; switching model")
        except Exception as e:
            _notify("llm.error", **metadata, code=type(e).__name__)
            raise

    if text is None:
        _notify("llm.error", **metadata, code="no_response")
        raise LLMError(f"[{tag}] no response after trying {len(models)} models")
    log_path = DATA / "logs" / f"{time.time():.3f}_{tag}.json"
    log_path.write_text(json.dumps({"model": model, "system": system,
                                    "user": user, "response": text}, indent=1))
    if not text:
        _notify("llm.error", **metadata, code="empty_response")
        raise LLMError(f"[{tag}] empty response (truncated or blocked); see {log_path}")
    try:
        parsed = _extract_json(text)
    except (json.JSONDecodeError, LLMError) as e:
        _notify("llm.error", **metadata, code="invalid_json")
        raise LLMError(f"[{tag}] bad JSON ({e}); see {log_path}") from e
    _notify("llm.response", **metadata, response=parsed)
    return parsed
