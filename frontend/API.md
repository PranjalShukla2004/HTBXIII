# Frontend integration

The existing React/Vite dashboard uses Zustand and an `AgentApi` adapter. It has
one screen, with a responsive Skills rail, recording controls, chat/composer,
per-site run cards, a results table, and folded logs. There is no router or second
UI. `src/api/types.ts` describes these view models; `src/api/backend.ts` describes
the actual Python API. `mapping.ts` translates between them.

Real mode is the default. Set `VITE_USE_MOCK=true` to retain the offline demo.
`VITE_API_URL` defaults to `http://localhost:8000`; restart Vite after changing it.
Never put the Gemini key in a `VITE_` variable: it belongs on the backend.

## HTTP commands

| Method | Path | Dashboard use |
|---|---|---|
| GET | `/api/skills` | Load the existing skill strips and variable/step details. |
| GET | `/api/skills/{id}` | Get the selected skill before planning. |
| POST | `/api/skills/{id}/plans` | Submit `{ "prompt": "Find ps5 at https://…" }`; returns a job. |
| POST | `/api/skills/{id}/runs` | Submit `{ "url": "https://…", "arguments": { "query": "ps5" } }`; returns a job. |
| POST | `/api/recordings` | Submit `{ "url": "https://…", "skill_id": "recorded_UNIQUE_ID" }`; returns a job. |
| POST | `/api/recordings/{id}/stop` | Stop and compile; wait for terminal frames before showing the draft. |
| PATCH | `/api/skills/{id}` | Save the draft's `{ "name": "…", "description": "…" }`. |
| DELETE | `/api/skills/{id}` | Delete a saved skill or discard a compiled provisional skill. |
| POST | `/api/jobs/{id}/cancel` | Stop a run or discard an active recording. |
| GET | `/api/jobs/{id}` | Recover an oversized terminal result. |
| GET | `/api/jobs/{id}/logs` | Recover complete terminal text after a replay gap. |
| GET | `/api/jobs/{id}/screenshot` | Display the final screenshot in the existing site card. |

Planning and skill metadata/delete HTTP handlers were added because the dashboard's
existing chat and Save/Delete controls had no matching backend routes. Planning
calls the existing `webagent.planner.plan_from_chat`; name/description/site metadata
is stored beside the intents in `skill_metadata.json`. Naming does not rewrite the
intent program. No `webagent` source or WebSocket protocol changes were required.

Skill selection still works by clicking a strip, typing `@`, or naming the skill.
The adapter plans each selected skill, displays the returned summary and sites,
then runs each skill/site in sequence. This respects the backend's single active
job limit. Arguments come from the actual planner, rather than frontend heuristics.

## WebSocket envelope and UI mapping

Every start returns `job_id`, `streams.events`, `streams.llm`, and `log_url`.
The client resolves these paths against the API origin, using `ws://` for HTTP and
`wss://` for HTTPS. Both sockets are read-only; all commands above use HTTP.

```json
{
  "v": 1,
  "job_id": "JOB_ID",
  "channel": "llm",
  "seq": 3,
  "type": "llm.delta",
  "data": { "call_id": "CALL_ID", "attempt": 1, "tag": "ground", "text": "{\"action\":" },
  "t": 1794060000.0
}
```

| Backend event | Existing UI destination |
|---|---|
| Planning job result | `RunView` heading (summary), input chips (`variables`), dashed option chips (`choices`) and queued site cards (`sites`). |
| `recorder` | `Rail` REC bar's readable latest action and action count. |
| Recording `status: stopping/processing` | Draft strip's “Reading … actions” state. |
| Recording terminal result's `skill` | Existing draft name/Steps/Save/Discard controls. Closing the backend browser also triggers compilation. |
| `agent` status/step/log/error | Reworded into a per-site Activity line (`mapping.ts` → `describeAgent`; original kept as `raw`), the card footer, and step ticks: cached replays, `already_done`, passed verifies and captures complete a tick; `skipped verify N` / `skipped optional step N` (step only in the text) mark it skipped. `needs_human` with `reason`/`options` shows the question on the card. |
| `action` | Completed step tick after the action succeeds (partial/navigation/repeated actions stay active), an Activity line such as “Clicked “Add to cart””, and the site's last page URL. |
| Run/plan `log` | Console panel, including clicks, cart activity, stdout/stderr, errors and final outcome. Partial text fragments are joined. |
| Run/plan `llm.start` / `llm.delta` | A progressively updated row per call/attempt under Console → debug. Generated text is usually JSON; it does not replace the task heading or results. The recording compiler's result instead populates the draft's Steps and variables. |
| `llm.retry` / `llm.error` | Warning/error in Console. |
| `llm.response` | No duplicate display: streamed text is already available, and structured UI uses the final job result. |
| `completed` / `failed` / `needs_human` / `cancelled` | Terminal site status label, final screenshot (click to open), and one results-table row per site: Site, Status, every key of `result.outputs`, the last page reported by `action` frames, and a reworded `result.error` / `error.message` (original in the card footer tooltip). |
| `gap` | Recover console text via `log_url` and `X-Log-Sequence`; skip already-recovered log frames. Warn if earlier generated text has expired. |
| Socket lifecycle | Run header reconnect indicator, recorder reconnect message, and existing error UI if recovery fails. Rail availability reflects skill discovery, with Retry on failure. |

The backend does not report exact/synonym/fuzzy/heal matcher tiers or live video.
Actual completed steps therefore use a neutral completion tick. While working,
the card shows its current activity while the agent works in a visible Chrome window
on the backend machine (API runs follow the project's `HEADLESS` setting; `HEADLESS=1`
hides it); afterward it uses the final screenshot, when available. The progress grid
(`RunProgress.tsx`) shows one bar per skill step per site and marks the step a site
stopped on; selecting a row or site window enlarges that site. Synthetic pages, prices, tiers and approval
buttons remain confined to explicit mock mode.

## Lifecycle and recovery

`websocket.ts` owns socket listeners, a separate cursor for each channel, ordered
async delivery, deduplication, and bounded exponential reconnect (0.5 seconds up to
10 seconds, six attempts). Reconnect uses `?after=LAST_DELIVERED_SEQ`; it never starts
another job. Invalid envelopes and unknown events are ignored. Origin/policy
rejections fail immediately. Both terminal frames are consumed before moving on,
so a fast events socket cannot drop late generated text from the LLM socket.

`http.ts` owns composite run/recording sessions and AbortControllers. `store.ts`
reduces view events into existing components. Terminal outcomes, Stop, New task,
and app unmount release listeners, timers and sockets. Stop/New task also request
backend cancellation. Starting a job after its chat was cleared is detected and
the late job is cancelled. Effects and the API subscriptions have cleanup paths.

## Limits

- Recording opens an interactive browser on the backend machine; the website does
  not provide a remote desktop. Its visible action count counts received events;
  expired recorder history cannot reconstruct every earlier raw action. The backend
  still compiles its complete cleaned trace.
- The backend saves compiled recordings before naming. The adapter hides its own
  provisional skill until Save and deletes it on Discard. Refreshing during draft
  review loses this in-memory draft state; the saved skill remains discoverable.
- Job history and chat sessions are not restored after refresh or server restart.
  A disconnected browser does not automatically cancel the backend job; use the
  job cancel endpoint if it remains active.
- Planning uses the existing shopping-oriented planner and checked-shop list.
  Extracted columns depend on the selected skill. The adapter executes run jobs;
  it does not add spreadsheet export or a payment/approval API.
- `needs_human` is terminal; the current backend has no resume command.
- The planner returns `choices` (e.g. a size from the message), but
  `POST /api/skills/{id}/runs` accepts only the skill's own `arguments` and rejects
  unknown names, and the API run passes no `answers` to the agent. Choices are shown
  as dashed chips only; a site that needs one ends as `needs_human`.
- API runs call `run_program` for one site, not the CLI orchestrator, so no extra
  product name/price extraction or sheet write happens. The results table shows
  `outputs` only when the skill has `extract` steps.
- Only task output is streamed; independently started CLI/server process output
  is outside the job's console capture.

See [the backend protocol guide](../backend/WEBSOCKETS.md) and
[test instructions](README.md#testing) for complete setup and validation commands.

## Changed files

Paths in this table are relative to the repository root.

| Files | Change |
|---|---|
| `frontend/src/api/backend.ts`, `mapping.ts`, `websocket.ts` | New wire types, event translation and reusable socket transport. |
| `frontend/src/api/http.ts`, `types.ts`, `index.ts` | Real API adapter, view events and default real-mode selection. |
| `frontend/src/api/mock.ts` | Match the recording callback contract, stop its timer during compilation, handle optional run counts. |
| `frontend/src/store.ts` | Reactive run/recording updates, draft persistence, cancellation and subscription cleanup. |
| `frontend/src/App.tsx` | App-disposal cleanup. |
| `frontend/src/components/Chat.tsx`, `Rail.tsx`, `RunView.tsx` | Existing loading/error/recording/run/results/log UI integration. |
| `frontend/src/lib/ui.ts` | Neutral completed-step tick metadata. |
| `frontend/.env.example`, `package.json` | Real connection defaults and dependency-free test command. |
| `frontend/tests/helpers.ts`, `websocket.test.ts`, `mapping.test.ts`, `http.test.ts` | Transport, protocol-to-view and session tests. |
| `backend/api/app/agent.py`, `jobs.py`, `main.py`, `models.py`, `storage.py` | HTTP planning, skill naming/deletion and recording-site metadata. |
| `backend/api/tests/test_api.py`, `test_frontend.py` | HTTP adapter checks and opt-in real-browser integration. |
| `frontend/API.md`, `frontend/README.md`, `backend/WEBSOCKETS.md`, `backend/api/tests/README.md` | Actual protocol, event mapping, setup, tests and limitations. |
