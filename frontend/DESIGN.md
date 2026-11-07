---
name: Understudy
description: Flight-strip control board for a show-and-replicate browser agent.
colors:
  bg: "#0a0a0b"
  side: "#101012"
  panel: "#17171a"
  chip: "#1f1f23"
  rule: "#26262b"
  rule-2: "#36363d"
  fg: "#f5f5f6"
  fg-2: "#b6b6bd"
  fg-3: "#8a8a93"
  accent: "#7c6bff"
  accent-2: "#9d90ff"
  sel: "#221f3d"
  warn: "#2b2210"
  rec: "#ff4d4d"
  tier-exact: "#4ade80"
  tier-synonym: "#60a5fa"
  tier-fuzzy: "#fbbf24"
  tier-heal: "#f87171"
typography:
  display:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 600
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    letterSpacing: "-0.025em"
  brand:
    fontFamily: "Geist Variable"
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: "Geist Variable"
    fontSize: "15px"
    fontWeight: 400
  ui:
    fontFamily: "Geist Variable"
    fontSize: "14px"
    fontWeight: 500
  label:
    fontFamily: "Geist Variable"
    fontSize: "13px"
    fontWeight: 500
  data:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "12px"
  micro:
    fontFamily: "Geist Variable or Geist Mono Variable"
    fontSize: "11px"
rounded:
  strip: "3px"
  panel: "4px"
  composer: "5px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
components:
  strip-skill:
    backgroundColor: "{colors.buff}"
    textColor: "{colors.strip-ink}"
    rounded: "{rounded.strip}"
    height: "44px"
  strip-skill-selected:
    backgroundColor: "{colors.sky}"
  button-primary:
    backgroundColor: "{colors.chalk}"
    textColor: "{colors.rack}"
    rounded: "{rounded.strip}"
  button-approve:
    backgroundColor: "{colors.salmon}"
    textColor: "{colors.strip-ink}"
    rounded: "{rounded.strip}"
---

# Design System: CopyCat

## Overview
Graphite dark, neutral (no hue tint), one vivid violet accent. The run is watched, not read: each site gets a live mini browser window; text stays to one line per thing.

## Colors
- **Accent violet** is for the primary action, selection, focus, the live step and the best-result underline. Nothing decorative.
- **Tier colours mean the matcher:** green exact, blue synonym, amber fuzzy, red self-heal. Amber also marks "Learned …" notes.
- **Red is recording only.**
- Neutrals: bg → side → panel → chip, separated by 1px rules rather than shadows.

## Typography
Geist for everything, Geist Mono only for data (prices, step counts, URLs, logs). Tabular numerals.

## Layout
Rail 300px on desktop, drawer under 1024px (the app often sits beside Playwright windows). Thread max 960px. Site windows: 3 across ≥1280px, 2 ≥640px, 1 below.

## Components
- **Row (Strip.tsx):** bordered rounded-lg row; tone says state (chip default, sel = selected/live, warn = needs attention).
- **Avatar:** letter mark tinted from the name, for skills and sites.
- **Site window:** header row (avatar, name, step ticks or final price), 16:10 live view with a ring on the element being acted on, one-line footer.
- **Step ticks:** one 4×12px bar per step, filled with its tier colour.

## Do's and Don'ts
- Do keep labels to one line and put detail behind toggles (logs, steps).
- Don't add eyebrows, numbered sections, explanatory paragraphs, or use accent/tier colours as decoration.
- Don't use mono for anything that is not data.
