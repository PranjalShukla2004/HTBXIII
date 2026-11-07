import asyncio, json, re, time
from google import genai
from google.genai import types, errors
from .config import (MODEL, FALLBACK_MODEL, DATA, GEMINI_API_KEY,
                     LLM_CONCURRENCY, LLM_TIMEOUT)

client = genai.Client(api_key=GEMINI_API_KEY)
_sem = asyncio.Semaphore(LLM_CONCURRENCY)

class LLMError(Exception):
    pass

def _extract_json(text: str):
    text = re.sub(r"```(?:json)?", "", text)
    match = re.search(r"(\{.*\}|\[.*\])", text, re.S)
    if not match:
        raise LLMError(f"No JSON in response: {text[:300]}")
    return json.loads(match.group(1))

def _retry_delay(e: Exception) -> float | None:
    m = re.search(r"retryDelay['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)s", str(e))
    return float(m.group(1)) if m else None

async def llm_json(system: str, user: str, *, max_tokens: int = 8192, tag: str = "llm",
                   retries: int = 6, cheap: bool = False):
    cfg = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        max_output_tokens=max_tokens,
        temperature=0,
    )
    models = [MODEL] + ([FALLBACK_MODEL] if FALLBACK_MODEL else [])
    if cheap and FALLBACK_MODEL:
        models.reverse()                       # easy calls go to the lite model first
    idx, resp, model = 0, None, models[0]

    for attempt in range(retries):
        model = models[idx % len(models)]
        try:
            async with _sem:
                resp = await asyncio.wait_for(
                    client.aio.models.generate_content(model=model, contents=user, config=cfg),
                    timeout=LLM_TIMEOUT)
            break
        except (errors.APIError, TimeoutError) as e:
            code = getattr(e, "code", "timeout")
            if code not in (429, 500, 503, "timeout") or attempt == retries - 1:
                raise
            idx += 1                            # other model has its own quota
            switched = len(models) > 1
            if switched and attempt == 0:
                wait = 1                        # try the other model immediately
            else:
                wait = _retry_delay(e) or 3 * 2 ** attempt
            wait = min(wait, 60)
            print(f"[llm:{tag}] {model} -> {code}, next {models[idx % len(models)]} in {wait:.0f}s")
            await asyncio.sleep(wait)

    text = resp.text or ""
    log_path = DATA / "logs" / f"{time.time():.3f}_{tag}.json"
    log_path.write_text(json.dumps({"model": model, "system": system,
                                    "user": user, "response": text}, indent=1))
    if not text:
        raise LLMError(f"[{tag}] empty response (truncated or blocked); see {log_path}")
    try:
        return _extract_json(text)
    except (json.JSONDecodeError, LLMError) as e:
        raise LLMError(f"[{tag}] bad JSON ({e}); see {log_path}") from e