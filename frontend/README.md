# CopyCat — dashboard

Frontend for the show-and-replicate browser agent. Record a workflow once, save it as a
skill card, then ask for a new task in chat and watch the agent replay it on other sites.

**Stack:** Vite + React 19 + TypeScript + Tailwind v4, zustand for state, lucide icons.
Fonts are bundled through npm (no Google Fonts call), so it works on bad venue Wi-Fi.

## Run it

```bash
npm ci
cp .env.example .env.local
npm run dev          # http://localhost:5173
```

It connects to the real agent by default. In another terminal, start the backend:

```bash
cd ../backend/api
uv sync --locked
uv run python -m playwright install chromium
uv run python serve.py
```

The Gemini key stays in the backend environment or project `.env`; see the
[backend setup](../backend/api/README.md). Existing saved skills appear in the rail.
Select one and give the task a full shop URL, for example “Find ps5 at
https://your-test-shop.example”. Use a site you can test.

For the offline demo set `VITE_USE_MOCK=true` in `.env.local` and restart Vite.
The protocol, event mapping, lifecycle and limitations are in [API.md](./API.md).
If you use port 5180, add `http://localhost:5180` to the backend's
`FRONTEND_ORIGINS` environment variable before starting it.

## Where things are

| File | What |
|---|---|
| `src/api/types.ts` | Existing `Skill`, `Step`, `RunEvent` view models |
| `src/api/backend.ts`, `mapping.ts` | Backend wire types, validation and mapping into the existing UI |
| `src/api/http.ts` | Real HTTP commands and composite run/recording sessions |
| `src/api/websocket.ts` | Native WebSocket subscriptions, cursors, reconnect and cleanup |
| `src/api/mock.ts` | Fake recorder and parallel runs, with a self-heal moment for the demo |
| `src/store.ts` | App state and the reducer that turns run events into UI |
| `src/components/Rail.tsx` | Record control, draft strip after Stop, skill strips |
| `src/components/RunView.tsx` | Live site windows, results table, approval, logs |
| `src/components/SimPage.tsx` | Synthetic supplier pages shown in mock mode only |
| `src/components/Chat.tsx` | Empty state, thread, composer with `@skill` picker |
| `src/components/Strip.tsx` | The strip primitive and step ticks |
| `DESIGN.md`, `PRODUCT.md`, `.impeccable/` | Design system and product notes for the Impeccable skill |

## How it works

- Pick a skill: click its strip, type `@`, or name it ("use the shopping skill…").
- Each site gets a mini browser window with live step/footer updates, then its final
  screenshot. The real backend reports completion; matcher-tier colours and simulated
  previews remain available in mock mode.
- Logs stay folded. The tab title shows progress while Playwright windows cover the app.
- Open Logs for terminal output; enable debug to watch generated Gemini text.
- Results contain actual extracted outputs. A needs-attention outcome uses the existing
  error treatment; there is no backend resume/payment approval endpoint.
- Mock-mode pages and prices are synthetic.

## Testing

Use Node 22.18+ (or a newer supported release) for the dependency-free TypeScript
tests. Vite and the API need not be running for these checks:

```sh
npm test             # transport, replay, mapping, run/recording sessions
npm run build       # TypeScript checking and production build
npm run lint
```

For a real Chromium UI test over actual FastAPI HTTP/WebSocket connections:

```sh
cd ../backend/api
uv sync --locked --group dev
uv run python -m playwright install chromium
RUN_FRONTEND_E2E=1 uv run python -m pytest tests/test_frontend.py -o addopts= -vv -s
```

This starts isolated API/Vite servers, uses a deterministic agent, makes no Gemini
calls, and tests live actions/text, reconnect/replay, results, Stop/New task cleanup,
needs-attention, skill discovery retry, recording, save/delete/discard, and the mobile
rail. It uses temporary skills and stops its servers automatically. Screenshots,
received frames, page errors and a Playwright trace are saved under
`backend/api/tests/result/frontend/` (ignored by Git). The ordinary backend test
suite skips this browser test. See [API test docs](../backend/api/tests/README.md)
for the separate opt-in test that makes real Gemini calls.
