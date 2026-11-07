# Webagent API

HTTP controls for saved skills and recordings, with separate WebSocket
streams for generated LLM text and browser/recorder events.
The events channel includes `log` frames with readable terminal/progress
messages. Complete per-job console logs are available through
`GET /api/jobs/{job_id}/logs` and `client.py logs JOB_ID`.

```sh
cd /Users/burphh/Desktop/HTB/HTBXIII/backend/api
uv sync --locked
uv run python -m playwright install chromium
uv run python serve.py
```

Set `GEMINI_API_KEY` in `HTBXIII/.env` or `backend/webagent/.env` before
starting real recordings/runs. Existing CLI-created skills under
`backend/webagent/data/intents/` are discovered automatically.

The launcher binds to `127.0.0.1:8000`, with one worker. Interactive API
documentation is at <http://127.0.0.1:8000/docs>.

In another terminal:

```sh
cd /Users/burphh/Desktop/HTB/HTBXIII/backend/api
uv run python client.py skills
uv run python client.py run shopping_demo --url https://www.amazon.com --arg query=ps5
```

The client prints the job ID and watches both WebSocket streams. Start a
recording with `client.py record NEW_SKILL_ID --url YOUR_SHOP_URL`, interact
with the browser opened on the backend machine, and stop it from another
terminal using `client.py stop JOB_ID`. Stopping saves the trace and asks
Gemini to create the skill automatically.

See [the API and WebSocket guide](../WEBSOCKETS.md) for the complete protocol,
curl examples, cancellation, replay, and frontend integration.

Run the automated tests without browser launches or Gemini API calls:

```sh
uv run python -m pytest
```

For the real browser/Gemini test, with output saved under `tests/result/`:

```sh
RUN_LIVE_GEMINI=1 uv run python -m pytest tests/test_live_gemini.py -o addopts= -vv -s
```

This starts its own local API and shop, makes real model requests, and saves
both WebSocket streams, readable logs, model responses, and a screenshot.
It is skipped during ordinary test runs. See [the test guide](tests/README.md)
for the result files and requirements.
