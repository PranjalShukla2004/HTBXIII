# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Primary: an operations or procurement person who repeats the same web chore across many sites (request a supplier quote, buy N items within budget). They show the task once, then hand off variations in plain language. Secondary, for this build: HackTheBurgh judges (Wordsmith challenge) watching a 4-minute live demo on a laptop or projector. *(Inferred from the scope doc and K's brief; confirm.)*

## Product Purpose
A show-and-replicate browser agent. The user records a workflow once in a real browser; it is compiled into a reusable skill of intentions (not clicks or selectors). Later the user picks a skill and types a task ("I need 5 laptops under £1000 each"); the agent replays the skill on sites it has never seen and returns a comparison. Success: the run finishes with no human input after the demonstration, and the user can see what it did and why.

## Positioning
It stores what the user meant ("enter the quantity"), not where they clicked. Replay re-finds each target by meaning in tiers (exact, synonym library, fuzzy, LLM self-heal) and visibly learns new phrases when it heals.

## Operating Context
Runs locally beside headed Playwright browser windows that open during record and run; the dashboard often sits in a narrow column next to them. Demo is live, on venue Wi-Fi, on mock supplier sites, with a backup video.

## Capabilities and Constraints
- Record start/stop, saved skill bank, chat to pick a skill (click, @mention, or by name) plus a natural-language task.
- Live run progress per target site; logs exist but are hidden by default.
- Agent must stop before anything that spends money and ask for approval.
- Backend (Python or Node, Playwright) is being built in parallel; frontend runs against a mock until then. Live page previews require the backend to stream screenshots (open decision).
- Stack: Vite + React + TypeScript + Tailwind (chosen in this thread).
- Name: CopyCat (working name from K).

## Brand Commitments
User asked for: clean, intuitive, nice to look at, impressive, not a copy-paste template; much less text; live mini browser windows inside the chat while the agent works.

## Evidence on Hand
No real customers, metrics or testimonials. All supplier sites and prices in the demo are mock data and must stay labelled as such.

## Product Principles
1. Show, don't tell: the run is watched, not read.
2. One glance answers "what is it doing right now?".
3. Detail on demand: logs, step lists and variables stay one click away.
4. A human signs off anything final.
