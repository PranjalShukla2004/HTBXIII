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

client = genai.Client(api_key=GEMINI_API_KEY)
_sem = asyncio.Semaphore(LLM_CONCURRENCY)
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

def _extract_json(text: str):
    text = re.sub(r"```(?:json)?", "", text)
    match = re.search(r"(\{.*\}|\[.*\])", text, re.S)
    if not match:
        raise LLMError(f"No JSON in response: {text[:300]}")
    return json.loads(match.group(1))

def _model_for(attempt: int) -> str:
    return FALLBACK_MODEL if (FALLBACK_MODEL and attempt >= 2) else MODEL

async def llm_json(system: str, user: str, *, max_tokens: int = 8192,
                   tag: str = "llm", retries: int = 5):
    cfg = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        max_output_tokens=max_tokens,
        temperature=0,
    )
    text, model = "", MODEL
    call_id = uuid4().hex
    for attempt in range(retries):
        model = _model_for(attempt)
        metadata = {"call_id": call_id, "tag": tag, "model": model, "attempt": attempt + 1}
        _notify("llm.start", **metadata)
        try:
            async with _sem:
                text = await asyncio.wait_for(
                    _generate(model, user, cfg, metadata),
                    timeout=LLM_TIMEOUT)
            break
        except (errors.APIError, TimeoutError) as e:
            code = getattr(e, "code", "timeout")
            if code in (429, 500, 503, "timeout") and attempt < retries - 1:
                wait = 3 * 2 ** attempt
                _notify("llm.retry", **metadata, code=code, wait_seconds=wait)
                print(f"[llm:{tag}] {model} -> {code}, retrying in {wait}s")
                await asyncio.sleep(wait)
                continue
            _notify("llm.error", **metadata, code=code)
            raise
        except Exception as e:
            _notify("llm.error", **metadata, code=type(e).__name__)
            raise

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
