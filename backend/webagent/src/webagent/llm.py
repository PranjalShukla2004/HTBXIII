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
    resp, model = None, MODEL
    for attempt in range(retries):
        model = _model_for(attempt)
        try:
            async with _sem:
                resp = await asyncio.wait_for(
                    client.aio.models.generate_content(model=model, contents=user, config=cfg),
                    timeout=LLM_TIMEOUT)
            break
        except (errors.APIError, TimeoutError) as e:
            code = getattr(e, "code", "timeout")
            if code in (429, 500, 503, "timeout") and attempt < retries - 1:
                wait = 3 * 2 ** attempt
                print(f"[llm:{tag}] {model} -> {code}, retrying in {wait}s")
                await asyncio.sleep(wait)
                continue
            raise

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