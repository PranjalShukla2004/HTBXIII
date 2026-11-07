"""Preview or replay semantic actions on a different site using Playwright."""
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

from .dom import discover
from .semantic import SemanticMatcher


def replay(workflow_path: str, url: str, execute: bool = False, submit: bool = False,
           threshold: float = 0.45, min_margin: float = 0.03) -> None:
    workflow = json.loads(Path(workflow_path).read_text(encoding="utf-8"))
    if not workflow.get("steps"):
        raise ValueError("Workflow has no supported steps. Check import warnings.")
    matcher = SemanticMatcher()
    used_ids: set[str] = set()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            for i, step in enumerate(workflow["steps"], start=1):
                # In execution mode each DOM observation is fresh. Do not reuse
                # temporary element IDs across navigation or dynamic UI changes.
                controls = discover(page)
                ranked = matcher.rank(step, controls, used_ids=used_ids)
                print(f"\n{i}. {step['action']} : {step['target']['label']}")
                if not ranked:
                    print("   No compatible visible control. Stopping.")
                    return
                for score, el in ranked[:3]:
                    print(f"   {score:.3f}  {el['label'] or '(unnamed)'} [id={el['id']}, action={el['action']}]")
                best_score, best = ranked[0]
                next_score = ranked[1][0] if len(ranked) > 1 else -1.0
                if best_score < threshold or (best_score - next_score) < min_margin:
                    print("   Low-confidence or ambiguous match. No action taken. Stopping.")
                    return
                if not execute:
                    used_ids.add(best["id"])
                    print("   DRY RUN: would target", best["label"])
                    continue
                if step.get("requires_approval"):
                    if not submit:
                        print("   Final click blocked. Add --submit to request explicit approval.")
                        return
                    answer = input(f"   Confirm click '{best['label']}'? [y/N]: ").strip().lower()
                    if answer not in {"y", "yes"}:
                        print("   Cancelled by user.")
                        return

                control = page.locator(f'[data-swa-id="{best["id"]}"]')
                if control.count() != 1:
                    print("   Element changed after observation. Stop and retry.")
                    return
                if step["action"] == "fill":
                    control.fill(step["value"])
                elif step["action"] == "click":
                    control.click()
                elif step["action"] == "check":
                    control.check()
                elif step["action"] == "uncheck":
                    control.uncheck()
                elif step["action"] == "select_option":
                    control.select_option(step["value"])
                # A click may navigate or re-render the DOM: all IDs become stale.
                if step["action"] == "click":
                    used_ids.clear()
                else:
                    used_ids.add(best["id"])
                print("   Executed")
            print("\nReplay steps processed. Inspect the resulting page; this MVP does NOT establish submission success.")
            if execute:
                Path("artifacts").mkdir(exist_ok=True)
                page.screenshot(path="artifacts/last_replay.png", full_page=True)
        finally:
            browser.close()
