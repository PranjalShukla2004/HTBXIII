# CopyCat — dashboard

Frontend for the show-and-replicate browser agent. Record a workflow once, save it as a
skill card, then ask for a new task in chat and watch the agent replay it on other sites.

**Stack:** Vite + React 19 + TypeScript + Tailwind v4, zustand for state, lucide icons.
Fonts are bundled through npm (no Google Fonts call), so it works on bad venue Wi-Fi.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

It starts on a **mock backend** (`src/api/mock.ts`) so you can click through every flow
now. When the agent server is up:

```bash
cp .env.example .env.local
# set VITE_USE_MOCK=false and VITE_API_URL=http://localhost:8000
```

The contract the backend must implement is in [API.md](./API.md).
Note: if the mock supplier sites also use Vite on 5173, run this on another port:
`npm run dev -- --port 5180`.

## Where things are

| File | What |
|---|---|
| `src/api/types.ts` | `Skill`, `Step`, `RunEvent` … the shared contract |
| `src/api/http.ts` | Real client (fetch + EventSource) |
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
- Each site gets a mini browser window in the chat. Step ticks colour by matcher tier
  (green exact, blue synonym, amber fuzzy, red self-heal). A heal pins a "Learned …" note.
- Logs stay folded. The tab title shows progress while Playwright windows cover the app.
- The agent stops before anything that spends money; the run ends with an approval button.
- Mock-mode pages and prices are synthetic.
