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
| POST | `/api/skills/{id}/runs` | Submit `{ "url": "https://…", "arguments": { "query": "ps5" } }`, plus optional `"choices": { "size": "M" }` and `"constraints": { "items": 3, "max_price": 30, "currency": "GBP", "requirements": [] }`; returns a job. |
| POST | `/api/jobs/{id}/answer` | Submit `{ "field": "size", "value": "M" }` while a run waits for the shopper (`needs_input`); the run continues. |
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
intent program. The answer endpoint and run `choices`/`constraints` connect the
agent's existing `ask`/`answers` hooks and its budget/item checks to the dashboard;
the WebSocket envelope is unchanged.

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
| Planning job result | `RunView` heading (summary), input chips (`variables`; an empty one is a personal choice such as size that the agent asks for), dashed option chips (`choices`), constraint chips (`constraints`: items, max price, total budget, requirements) and queued site cards (`sites`). `choices` (plus answers given so far) and `constraints` are sent with every site run. |
| `agent` status `needs_input` (`field`, `question`, `options`) | The run is paused, waiting for the shopper: an answer box (option buttons and a text box) inside the spotlight window under "Waiting for you" (or under the windows if another site is pinned), a hand marker on the route map, and the spotlight moves to that site. Questions are only asked when the agent can't proceed without one: a known answer that matches a visible option is clicked directly, and no question is asked when no choices are on screen. The answer goes to `POST /api/jobs/{id}/answer` and is reused for later sites; the `shopper chose …` log clears the card. |
| `agent` logs `product check passed` / `product rejected` / `item N of M in the basket` | Activity lines; with constraints the agent reads each chosen product's name and price, skips ones over budget or not matching, and repeats until it has the requested number of different products. |
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
hides it); afterward it uses the final screenshot, when available. The route map
(`RouteMap.tsx`) shows one bar per skill step per site, a moving marker per site, and
the step a site stopped on (taken from the backend's `step N` error text when present);
selecting a lane or thumbnail pins that site in the spotlight (`SiteWindow.tsx`), and
selecting it again returns to automatic focus. Synthetic pages, prices, tiers and approval
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
- Without named shops or a number of shops in the message, the planner uses 4 shops.
- `needs_human` is terminal; there is no resume command for it.
  Questions are different: a site waiting on `needs_input` pauses (its time limit is
  paused too) for up to 15 minutes, then ends as `needs_human` if nobody answers.
- Budget checks compare numbers in one currency only: a product priced in a different
  currency from the budget is accepted and noted rather than converted. A price the
  page doesn't show is also noted, not guessed.
- Item count and budget need a step that chooses the product (e.g. "the product that
  best matches {{query}}"); a skill without one runs as before and says so in its notes.
- API runs call `run_program` for one site, not the CLI orchestrator, so no sheet write
  happens. Product name/price are read only when the message has constraints (or the
  skill has `extract` steps); the results table then has one row per product.
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
