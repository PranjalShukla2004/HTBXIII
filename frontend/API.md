# Backend API the dashboard expects

The frontend talks to the agent over plain HTTP + Server-Sent Events. Types live in
`src/api/types.ts`; this file is the same contract in words for whoever builds the
Python/Node side. Base URL comes from `VITE_API_URL` (default `http://localhost:8000`).
Enable CORS for `http://localhost:5173`.

Until this exists, the UI runs on `src/api/mock.ts` (`VITE_USE_MOCK=true`).

## Skills

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/skills` | | `Skill[]` |
| POST | `/skills` | `SkillDraft` (name filled in by the user) | `Skill` |
| DELETE | `/skills/{id}` | | 204 |

```jsonc
// Skill
{
  "id": "sk_ab12",
  "name": "Supplier quote request",
  "description": "Fill a supplier's quote form ...",
  "site": { "url": "http://localhost:5173/northwind", "title": "Northwind Supply" },
  "createdAt": "2026-11-07T17:00:00Z",
  "runs": 3,
  "variables": [{ "name": "qty", "example": "500" }],
  "steps": [
    { "id": "s4", "intent": "fill", "description": "Enter the quantity",
      "action_type": "field.quantity", "slot": "qty", "value": "{{qty}}",
      "fingerprint": { "role": "spinbutton", "label": "Quantity" } }
  ]
}
```

`intent` is one of `navigate | fill | click | select | check | chat | wait`. `optional: true` marks steps like cookie banners.

## Recording

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/record/start` | `{ "startUrl": "..." }` | `{ "sessionId": "rec_1" }` — opens the headed Playwright window |
| GET (SSE) | `/record/{id}/events` | | stream of `RecordedAction` |
| POST | `/record/{id}/stop` | | `SkillDraft` — runs the intent compiler; `name` may be `""` |
| POST | `/record/{id}/cancel` | | 204 — close the browser, drop the log |

```jsonc
// RecordedAction (one SSE `data:` line each)
{ "id": "a1", "kind": "change", "summary": "Typed \"500\" into Quantity", "url": "...", "ts": "..." }
```
`kind`: `navigate | click | change | submit`. `summary` is shown verbatim in the REC bar, so make it human.

## Runs

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/runs` | `{ "skillIds": ["sk_shop"], "prompt": "I need 5 laptops under £1000" }` | `{ "runId": "run_1" }` |
| GET (SSE) | `/runs/{id}/events` | | stream of `RunEvent` (send past events again on reconnect) |
| POST | `/runs/{id}/stop` | | 204, then emit an `error` event "Run stopped" |

`RunEvent` is a tagged union on `type`. Typical order:

```jsonc
{ "type": "plan", "summary": "Find 5 × laptop under £1000 each across 3 shops",
  "variables": { "product": "laptop", "qty": "5", "budget": "£1000" },
  "targets": [{ "id": "t1", "name": "VoltMart", "url": "http://..." }] }

{ "type": "target_start", "targetId": "t1", "totalSteps": 7 }
{ "type": "browser", "targetId": "t1", "status": "opened", "url": "http://..." }
{ "type": "step", "targetId": "t1", "stepIndex": 0, "description": "Open the shop", "status": "running" }
{ "type": "step", "targetId": "t1", "stepIndex": 0, "description": "Open the shop", "status": "ok", "tier": "exact" }
{ "type": "heal", "targetId": "t2", "stepIndex": 5, "message": "Didn't recognise the button, picked \"Get my price\".",
  "learned": { "action_type": "submit_quote", "phrase": "Get my price" } }
{ "type": "frame", "targetId": "t1", "image": "data:image/jpeg;base64,..." }   // live mini-window preview
{ "type": "log", "level": "debug", "message": "aria_snapshot: 31 nodes", "targetId": "t1", "ts": "..." }
{ "type": "target_done", "targetId": "t1", "status": "ok", "result": { "shop": "VoltMart", "total": "£4,700.00" } }
{ "type": "browser", "targetId": "t1", "status": "closed", "url": "http://..." }

{ "type": "done", "summary": "Cheapest option is Parcel & Pixel ...",
  "table": { "columns": ["Shop", "Total"], "rows": [["VoltMart", "£4,700.00"]], "bestRow": 0 },
  "needsApproval": "Place the order with Parcel & Pixel" }
// or
{ "type": "error", "message": "..." }
```

- `tier` (`exact | synonym | fuzzy | heal`) colours the step bar green / blue / amber / red, matching the scope doc.
- `step.status` can also be `failed` or `skipped`.
- `frame` drives the mini browser window for each site. Send a small JPEG every ~300-500 ms, e.g.
  `base64.b64encode(await page.screenshot(type="jpeg", quality=50, scale="css"))`, or use CDP
  `Page.startScreencast` for smoother video. Without frames the window shows "Running in its browser window".
  Sites can run in parallel (one browser context each); the UI shows them side by side.
- `log` events only show when the user opens "Show logs"; send as many as you like.
- `needsApproval` is the label of the button the user presses to confirm the final, money-spending action. The agent should never take it on its own.

### Minimal FastAPI SSE example

```python
from fastapi.responses import StreamingResponse
import json, asyncio

@app.get("/runs/{run_id}/events")
async def run_events(run_id: str):
    async def gen():
        q = runs[run_id].queue          # asyncio.Queue the agent pushes dicts into
        for e in runs[run_id].history:  # replay for late subscribers
            yield f"data: {json.dumps(e)}\n\n"
        while True:
            e = await q.get()
            yield f"data: {json.dumps(e)}\n\n"
            if e["type"] in ("done", "error"):
                break
    return StreamingResponse(gen(), media_type="text/event-stream")
```
