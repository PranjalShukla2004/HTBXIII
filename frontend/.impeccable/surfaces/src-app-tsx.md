---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

Scope: the whole dashboard (single screen). Visitor mode: Operate.
User override (K, 2026-11-07): flight-strip colours rejected; palette replaced with graphite dark + one violet accent, name CopyCat. Strip styling dropped; live windows kept.
Audience/job: ops user (and demo judges) records a web chore once, then asks for variations and watches the agent replay it on unseen sites.
Constraints: live Playwright windows open beside it; much less text; live mini browser windows in the chat; nothing final without approval.

## Direction contract
THESIS: The run is watched, not read. Each site the agent works on is a flight strip in a rack; the live one opens into a mini browser. Refuses the chat-bubble-plus-progress-bar SaaS default and the cream/serif/red look of v1.
OWN-WORLD: Dark slate-green rack board (#121c1b). Strips in printed-card colours: buff (skills, queued), sky blue (live), salmon (needs you). Grease-pencil amber for annotations and highlight rings. Archivo at condensed widths for strip codes and labels, normal width for UI; JetBrains Mono only for data (prices, steps, URLs). Strips divided by hairline vertical rules into fields.
STORY: Pick a strip (skill), type a task, see strips light up and pages move in mini windows, get one table with the best row and an approve button.
FIRST VIEWPORT: Left rail 288px: Record control on top, skill strips below. Main: thread centred max 920px; composer docked bottom. During a run: one-line plan, then 3 site windows across (16:10 mini browsers with a strip as title bar), result table under them.
FORM: Flight progress strips in a rack, candidate 7 of 7 on my list. seed:1f1e81a2f79cb1b1
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
