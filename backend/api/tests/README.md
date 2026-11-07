# API tests

The normal suite uses a fake agent and mocked Gemini responses:

```sh
cd /Users/burphh/Desktop/HTB/HTBXIII/backend/api
uv run python -m pytest -o addopts= -vv -s
```

The live Gemini test is skipped by default. To run it explicitly:

```sh
cd /Users/burphh/Desktop/HTB/HTBXIII/backend/api
RUN_LIVE_GEMINI=1 uv run python -m pytest tests/test_live_gemini.py -o addopts= -vv -s
```

It uses your existing `GEMINI_API_KEY` and configured model from the server
environment, `HTBXIII/.env`, or `backend/webagent/.env`. Chromium must be
installed; run `uv run python -m playwright install chromium` if necessary.
You do not need a frontend or an already-running API server.

## What the live test does

The test starts a separate API process on an available localhost port. It
uses the real `AgentBackend`, a real headless Chromium browser, the Google
Gen AI SDK, and network calls to Gemini. It does not patch/mock the browser,
agent, model client, or model responses.

A controlled local shop page is the browsing target. The agent:

1. Asks Gemini which search input to use, then searches for PS5.
2. Asks Gemini to verify the search results.
3. Asks Gemini which Add to cart button to click, then clicks it.
4. Asks Gemini to verify that the cart contains the console with quantity 1.

The test connects to both real WebSocket endpoints while the job runs and
prints generated model text and progress logs. It checks successful browser
actions, real generated-text chunks, four completed model calls, successful
verification responses, terminal frames, and a saved screenshot. Normally
this makes four Gemini requests; retries can add requests and API usage.

The subprocess has its own model client and event loop, so it cannot reuse
the mocked model client from the unit tests. The server and browser are
stopped automatically, including after failure. Your saved shopping skills
are not overwritten. The overall default job limit is 240 seconds; set
`LIVE_GEMINI_TIMEOUT_SECONDS` to change it.

## Inspect the results

Every opted-in run creates a new folder under `tests/result/`, such as:

```text
tests/result/20261107T180256Z_0ff9a14b/
```

`tests/result/latest.json` points to the most recent run. The test prints
the absolute result directory before starting and after finishing. Failed
runs keep their available diagnostics too.

| File | Contents |
| --- | --- |
| `summary.json` | Pass/fail, model, completed Gemini calls, chunk counts, executed actions, job ID, and error if any. |
| `console.log` | Complete readable progress log downloaded from the real API. |
| `llm.jsonl` | Every frame received from the real LLM WebSocket. |
| `events.jsonl` | Every frame received from the real actions/logs WebSocket. |
| `llm.txt` | Generated model text, grouped by model call and attempt. |
| `events.txt` | Readable log messages observed on the events WebSocket. |
| `gemini_responses.json` | Complete parsed model responses and call metadata. |
| `provider_logs/` | Copies of the agent's request/response JSON logs matching this test's unique run token. |
| `screenshot.png` | The real browser page after the cart operation. |
| `result.json`, `job.json` | Final agent outcome, actual bindings, and API job state. |
| `server.log` | The child API process's stdout/stderr, including server errors. |
| `request.json`, `skill.json` | The submitted run request and the four-step skill. |
| `metadata.json` | Configured model and provider-log location, with no API key. |
| `skills/`, `jobs/` | The test's isolated API skill store and job artifacts. |

For example, after the run shown above:

```sh
cat tests/result/20261107T180256Z_0ff9a14b/summary.json
cat tests/result/20261107T180256Z_0ff9a14b/console.log
cat tests/result/20261107T180256Z_0ff9a14b/llm.txt
```

Generated results are ignored by Git. Model calls still use the agent's
normal provider-log location; the relevant files are also copied into the
result folder. No API key or environment dump is written to test artifacts.
