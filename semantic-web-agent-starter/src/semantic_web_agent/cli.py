"""Command-line entry point for demonstration import and semantic replay."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .recorder_import import import_codegen


def main() -> None:
    parser = argparse.ArgumentParser(description="Semantic Web Agent (MVP)")
    subs = parser.add_subparsers(dest="command", required=True)

    imp = subs.add_parser("import-demo", help="Convert Playwright codegen Python to JSON workflow")
    imp.add_argument("recording", help="Path to Python codegen output")
    imp.add_argument("--out", default="workflows/manufacturer_a.json")

    run = subs.add_parser("replay", help="Match a workflow semantically on a new site")
    run.add_argument("--workflow", required=True)
    run.add_argument("--url", required=True)
    run.add_argument("--execute", action="store_true", help="Actually fill fields and run intermediary clicks")
    run.add_argument("--submit", action="store_true", help="Ask before the final recorded click (also requires --execute)")
    run.add_argument("--threshold", type=float, default=0.45)
    run.add_argument("--min-margin", type=float, default=0.03)

    insp = subs.add_parser("inspect", help="Print visible controls on a website")
    insp.add_argument("--url", required=True)

    args = parser.parse_args()
    if args.command == "import-demo":
        workflow = import_codegen(args.recording)
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(workflow, indent=2), encoding="utf-8")
        print(f"Imported {len(workflow['steps'])} steps to {path}")
        for warning in workflow["import_warnings"]:
            print("WARNING:", warning)
        print("Review the JSON and redact personal data before sharing it.")
    elif args.command == "replay":
        from .replay import replay
        replay(args.workflow, args.url, args.execute, args.submit, args.threshold, args.min_margin)
    elif args.command == "inspect":
        from playwright.sync_api import sync_playwright
        from .dom import discover
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            try:
                page = browser.new_page()
                page.goto(args.url, wait_until="domcontentloaded")
                print(json.dumps(discover(page), indent=2))
            finally:
                browser.close()
