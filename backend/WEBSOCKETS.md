# Webagent API and WebSocket guide

The implementation is in `backend/api/`. Saved intent JSON files are exposed
as skills. HTTP controls recording and execution; two independent WebSocket
channels deliver generated LLM text and browser/recorder events. There is no
frontend dependency.

## Start the server

Run these commands in your terminal:

```sh
cd /Users/burphh/Desktop/HTB/HTBXIII/backend/api
uv sync --locked
uv run python -m playwright install chromium
uv run python serve.py
```

Keep `GEMINI_API_KEY` in `HTBXIII/.env`, `backend/webagent/.env`, or the server
environment. The API uses the existing `MODEL`, `FALLBACK_MODEL`,
`LLM_CONCURRENCY`, and `LLM_TIMEOUT` settings. Skill discovery and API tests do
not require a Gemini key. Agent imports happen when a job runs.

The server listens on `http://127.0.0.1:8000`. Open `/docs` for interactive
HTTP documentation, or `/health` to check the process is running. The API's
startup code explicitly includes the agent source directory, avoiding the
recurring macOS hidden `.pth` problem without a `PYTHONPATH` export.

Use one server worker and one API process for this shared agent data
directory. The service admits one recording or skill run at a time, and
returns HTTP 409 for another start. This prevents the current runner's
hostname-based result files from colliding inside the service. Independent
CLI runs using the same directory can still collide with API runs.

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Process health. |
| GET | `/api/skills` | List saved skills, steps, and argument defaults. |
| GET | `/api/skills/{skill_id}` | Get one skill. |
| POST | `/api/skills/{skill_id}/plans` | Plan a chat prompt using the existing planner; returns a job with both streams. |
| PATCH | `/api/skills/{skill_id}` | Set display name/description without rewriting the intent program. |
| DELETE | `/api/skills/{skill_id}` | Delete a skill and its display metadata; active skills return 409. |
| POST | `/api/skills/{skill_id}/runs` | Trigger a skill with a URL and argument overrides. |
| POST | `/api/recordings` | Start recording a new skill. |
| POST | `/api/recordings/{job_id}/stop` | Stop recording, save the trace, and generate the skill. |
| GET | `/api/recordings/{job_id}/trace` | Get the saved trace once available. |
| GET | `/api/jobs/{job_id}` | Get status, results, errors, and stream URLs. |
| GET | `/api/jobs/{job_id}/logs` | Get the complete saved progress/console text, including messages older than WebSocket history. |
| POST | `/api/jobs/{job_id}/cancel` | Cancel a recording/run and await cleanup. |
| GET | `/api/jobs/{job_id}/screenshot` | Fetch this run's copied screenshot, if available. |

A skill's ID is the filename without `.json` under
`backend/webagent/data/intents/`. Existing skills such as `shopping_demo`
remain usable through the original CLI.

### List skills and their arguments

```sh
curl http://127.0.0.1:8000/api/skills
```

Example skill metadata:

```json
{
  "id": "shopping_demo",
  "goal": "Search for {{query}}",
  "arguments": {"query": {"type": "string", "default": "shoes"}},
  "steps": [{"op": "search", "target": "product search", "value": "{{query}}", "optional": false}]
}
```

`GET /api/skills` wraps these in `skills` and includes `invalid_files` for
saved JSON files that cannot be loaded. All arguments have saved defaults.
Send only overrides; unknown argument names, non-string values, and unknown
request fields are rejected. Skill IDs use letters, digits, underscores,
and hyphens, up to 80 characters, starting with a letter or digit.

### Trigger a skill

```sh
curl -X POST http://127.0.0.1:8000/api/skills/shopping_demo/runs \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.amazon.com","arguments":{"query":"ps5"}}'
```

Use a real saved skill and the argument names returned by skill discovery.
The API adds `https://` to bare hostnames and accepts only HTTP(S) URLs
without embedded credentials. This normalization belongs to the API;
the existing replay CLI still requires a complete URL.

Starts return HTTP 202 with a job handle:

```json
{
  "job_id": "SERVER_GENERATED_ID",
  "kind": "run",
  "skill_id": "shopping_demo",
  "url": "https://www.amazon.com/",
  "status": "queued",
  "created_at": 1794060000.0,
  "updated_at": 1794060000.0,
  "result": null,
  "error": null,
  "log_url": "/api/jobs/SERVER_GENERATED_ID/logs",
  "streams": {
    "llm": "/ws/jobs/SERVER_GENERATED_ID/llm",
    "events": "/ws/jobs/SERVER_GENERATED_ID/events"
  }
}
```

The job may already have advanced when the response arrives. Use the
returned ID to poll, cancel, or subscribe to both streams.

### Record, stop, and create a skill

```sh
curl -X POST http://127.0.0.1:8000/api/recordings \
  -H 'Content-Type: application/json' \
  -d '{"skill_id":"new_shopping_skill","url":"https://www.amazon.com"}'
```

A visible Playwright browser opens **on the machine running the backend**.
Interact with that browser, then stop from another terminal or the frontend:

```sh
curl -X POST http://127.0.0.1:8000/api/recordings/JOB_ID/stop
```

Replace `JOB_ID` with the returned ID. Stop is asynchronous: the job advances
from `recording`/`stopping` to `processing` while Gemini abstracts the trace,
then `done`. A successfully created skill appears in `/api/skills` and is
immediately executable. Closing all recorded browser pages also ends
recording and begins abstraction. Empty recordings cannot create skills.

Skill IDs must be new unless you explicitly send `"replace": true` in the
start request. The trace is saved before abstraction and is available through
its trace endpoint even if skill generation subsequently fails. Cancel
aborts the job; stop preserves the recording and creates a skill.

Remote recording requires access to the backend browser's desktop. This API
does not record clicks in the frontend browser or provide a remote desktop.

### Poll and cancel

```sh
curl http://127.0.0.1:8000/api/jobs/JOB_ID
curl -X POST http://127.0.0.1:8000/api/jobs/JOB_ID/cancel
```

Statuses are `queued`, `planning`, `recording`, `stopping`, `processing`, `running`,
`done`, `failed`, `needs_human`, or `cancelled`. A skill's `needs_human`
result is terminal; the current agent has no pause/resume interface.
Cancellation waits for worker/browser cleanup. A completed job retains its
outcome if cancellation arrives afterward.

Runs have a 10-minute overall limit; recording plus abstraction has a
one-hour limit. These are separate from the existing per-LLM-attempt timeout.

## The two WebSocket channels

For each job, connect to:

- `ws://127.0.0.1:8000/ws/jobs/JOB_ID/llm` for generated LLM text and complete JSON responses.
- `ws://127.0.0.1:8000/ws/jobs/JOB_ID/events` for agent decisions, executed actions, and recorder events.

The channels are read-only. Use HTTP for start, stop, and cancel. Both
channels send status and terminal messages so either can drive a progress
indicator independently.

Each frame has this envelope:

```json
{
  "v": 1,
  "job_id": "SERVER_GENERATED_ID",
  "channel": "llm",
  "seq": 3,
  "type": "llm.delta",
  "data": {
    "call_id": "MODEL_CALL_ID",
    "tag": "ground",
    "model": "CONFIGURED_MODEL",
    "attempt": 1,
    "text": "{\"status\":"
  },
  "t": 1794060000.0
}
```

Sequence numbers start at 1 and are independent for each channel. Times are
Unix seconds.

### LLM channel

| Type | Data |
| --- | --- |
| `status` | Job status, kind, and skill ID. |
| `llm.start` | `call_id`, `tag`, `model`, `attempt`. Begin a fresh attempt buffer. |
| `llm.delta` | The same identifiers plus a generated `text` chunk. |
| `llm.retry` | Identifiers plus error `code` and `wait_seconds`. Discard this attempt's partial text. |
| `llm.response` | Identifiers plus the complete parsed JSON in `response`. |
| `llm.error` | Identifiers plus an error `code`. |
| Terminal type | Final status, result, and error. |

Tags include `ground`, `verify`, and `abstract`. Group chunks by both
`call_id` and `attempt`; multiple model calls occur during one skill run.
The model is asked for JSON, so generated text is usually incremental JSON,
not a separate conversational explanation. Partial chunks are display data:
parse/use the complete `llm.response`, and trust the final job outcome.
Abstraction may reject a model response during validation and request another.
System prompts, request/page content, and private LLM log files are not sent
on this channel.

The opt-in agent hook uses Gemini's actual
[asynchronous streaming API](https://googleapis.github.io/python-genai/#generate-content-asynchronous-streaming).
CLI calls without the observer retain their non-streaming requests, retries,
JSON parsing, and return types.

### Actions and recorder channel

| Type | Data |
| --- | --- |
| `status` | Job status, kind, and skill ID. |
| `agent` | Existing `AgentEvent`: kind, site, message, data, timestamp. |
| `action` | A completed action: step, op, target, value where relevant, element, and current URL. Navigation hops are marked separately. |
| `recorder` | Raw recording event: kind, element information, value, URL, timestamp. |
| `log` | Readable progress/console text in `message`, with `source`, `level`, and `partial`. |
| Terminal type | Final status, result, and error. |

Grounding `agent` messages can precede browser execution. `action` is emitted
after the browser action succeeds. A recorder stream is live and raw; the
saved trace is cleaned/deduplicated by the existing recorder.

No visible-page-text stream is added: the requested text stream is generated
LLM output. An agent `status: done` progress message is not terminal; final
artifact saving and browser cleanup still need to finish.

### Readable terminal output for the frontend

The events channel also sends `log` frames so a frontend console can show
the progress text that is printed by an API-triggered job:

```json
{
  "v": 1,
  "job_id": "SERVER_GENERATED_ID",
  "channel": "events",
  "seq": 8,
  "type": "log",
  "data": {
    "source": "action",
    "level": "info",
    "message": "Clicked \"Add to cart\" on https://www.amazon.com/",
    "partial": false
  },
  "t": 1794060000.0
}
```

This includes CLI-style agent messages, readable completed actions, raw
recorder descriptions, start/stop status, saved-trace notices, generated
skill goals/variables/steps/warnings, final results, screenshot references,
and Python text printed to stdout/stderr while the job runs. Existing print
statements such as Gemini retry messages are captured automatically. Output
is still printed to the backend terminal. Each job has its own capture
context; unrelated server output and separately launched CLI processes are
not included.

For example, append `log` messages to a frontend text panel:

```javascript
const socket = new WebSocket(`ws://127.0.0.1:8000${job.streams.events}`);
socket.addEventListener("message", ({ data }) => {
  const frame = JSON.parse(data);
  if (frame.type === "log") {
    const suffix = frame.data.partial ? "" : "\n";
    document.querySelector("#agent-log").textContent += frame.data.message + suffix;
  }
});
```

`#agent-log` can be a `<pre>` element or your framework's text state. Use the
API origin appropriate to your deployment. Keep structured `agent`, `action`,
and `recorder` frames for other UI components; render `log` frames in the
console to avoid showing each action twice. An action log confirms the
browser action happened. Cart success is established by the agent's
verification evidence, rather than inferred from clicking a button.

All readable output is also appended to
`backend/api/data/JOB_ID/console.log`. `GET /api/jobs/JOB_ID/logs` returns a
plain-text snapshot, including messages older than the bounded WebSocket
history. The job response supplies this path as `log_url`. The
`X-Log-Sequence` response header is the events-channel cursor corresponding
to that snapshot; after replacing a console with the downloaded text, skip
log frames at or below that sequence to avoid duplicates. The header is
exposed to allowed frontend Origins.

`partial: true` means text has no terminating newline yet. Append the message
without a newline; the next fragment continues it. Long lines are split
into bounded fragments. Diagnostics written directly by native subprocesses
or to a saved original stream are outside the Python text capture.

### Completion, replay, and disconnects

Terminal frame types are `completed`, `failed`, `needs_human`, and `cancelled`.
Each contains `data.status`, `data.result`, and `data.error`. The server sends
one terminal frame per channel and closes the subscription. A run result
includes the agent's bindings and outcome; its screenshot field is an HTTP
API path, rather than a local filesystem path.
Agent execution errors are in `data.result.error`; service-level failures
such as a job timeout are in `data.error`.

Both streams buffer events before any client connects. Reconnect with the
last processed sequence number, for example:

```text
/ws/jobs/JOB_ID/llm?after=12
```

Each channel retains up to 512 frames and about 1 MiB. When earlier events
have expired, a `gap` frame reports the missing range before retained events
are replayed. Fetch the job snapshot to recover final state, and `log_url`
to recover the complete readable console. Oversized
individual payloads are marked `truncated`; use the job result endpoint for
full results. A stalled send is timed out after 10 seconds.

Disconnecting a socket only unsubscribes it. The job continues, so reconnecting
one stream does not interrupt the other. Explicitly use HTTP cancel when
work should stop. Do not automatically start a new job on reconnect.

Job handles and replay history live in one process. The latest 100 jobs are
retained in memory; completed jobs are evicted as new jobs start. API restart
loses those handles/history. Saved skills remain on disk, and traces/results/
screenshots are saved under `backend/api/data/JOB_ID/`. Artifact files are
not automatically deleted when a handle is evicted.

## Test from a terminal, without a frontend

Keep the server running. In a second terminal:

```sh
cd /Users/burphh/Desktop/HTB/HTBXIII/backend/api

uv run python client.py skills
uv run python client.py run shopping_demo --url https://www.amazon.com --arg query=ps5
```

The client prints the job handle and frames from both channels. To watch one
channel, add `--channel llm` or `--channel events`. To attach to an existing
job, run:

```sh
uv run python client.py watch JOB_ID --channel llm
```

For recording:

```sh
uv run python client.py record another_skill --url https://www.amazon.com
```

Interact with the opened browser, then use a third terminal to stop:

```sh
cd /Users/burphh/Desktop/HTB/HTBXIII/backend/api
uv run python client.py stop JOB_ID
```

Other controls:

```sh
uv run python client.py status JOB_ID
uv run python client.py cancel JOB_ID
uv run python client.py logs JOB_ID
```

Ctrl+C disconnects the watching client; it does not cancel the job.

Automated tests exercise HTTP and WebSocket behavior with a fake agent,
and test the actual LLM observer with a mocked provider. They launch no
browser and make no Gemini requests:

```sh
cd /Users/burphh/Desktop/HTB/HTBXIII/backend/api
uv run python -m pytest
```

To run a real browser agent and make actual Gemini calls:

```sh
RUN_LIVE_GEMINI=1 uv run python -m pytest tests/test_live_gemini.py -o addopts= -vv -s
```

This opt-in test starts its own API and a local shop page. Gemini grounds
the browser actions and verifies the search/cart results. Both WebSocket
streams, readable logs, complete model responses, a screenshot, and a test
summary are saved under `backend/api/tests/result/TIMESTAMP_RUN_ID/`.
`tests/result/latest.json` identifies the latest run. See
[the test guide](api/tests/README.md) for the artifact layout. The default
suite skips this test and makes no model requests.

## Frontend integration and scope

The React/Vite frontend now uses these two channels in its existing recording,
chat, site-card and log components. See [the frontend integration guide](../frontend/API.md)
for its event mapping, HTTP planning/name/delete adapters, recovery behavior and
limitations. The WebSocket envelope and endpoints are unchanged.

Use the HTTP start response's two `streams` paths with the browser's native
`WebSocket` API. Use `wss://` when serving over HTTPS, retain a cursor per
channel, and close subscriptions when their view is disposed. React, Vue,
Next.js, and other browser frameworks use the same protocol. Frontend hosts
can serve the UI separately from the Python backend.
Resolve returned screenshot paths against the API origin as well.

By default, allowed frontend Origins are `http://localhost:3000`,
`http://127.0.0.1:3000`, `http://localhost:5173`, and `http://127.0.0.1:5173`.
To change them, export `FRONTEND_ORIGINS` as a comma-separated list before
starting the server. HTTP CORS and explicit WebSocket Origin checks use the
same list. Clients without Origin headers, including the terminal client,
are accepted for local development.

This is a local development API without authentication. Keep the default
loopback binding. A remote deployment needs authentication, job/artifact
ownership checks, browser network restrictions, and shared/persistent job
coordination before adding multiple workers. The recording browser also
needs a desktop on the backend host.

## Changes to webagent

Only two source files needed additions:

- `llm.py`: an optional per-task observer, generated text chunks, and complete response events. Existing callers use the original non-streaming path.
- `run.py`: an optional `on_action` callback reporting successful browser actions. Existing `on_event` and CLI behavior remain available.

Recorder, browser, schemas, configuration, abstraction, and the agent's
project dependencies were left unchanged. The HTTP server, lifecycle,
storage adapter, stream buffers, terminal client, and tests live in the
sibling `backend/api/` project.
