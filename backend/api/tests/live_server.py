"""Private server for the real-Gemini test; uses the unmodified AgentBackend."""

import argparse
import html
import json
import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_ROOT))

import uvicorn
from fastapi.responses import HTMLResponse

from app.main import create_app
from app.storage import SkillStore
from webagent.config import DATA, FALLBACK_MODEL, MODEL
from webagent.schemas import IntentProgram, Step


def make_app(directory: Path, run_token: str, timeout: float):
    program = IntentProgram(
        goal=f"Search for {{{{query}}}} and add the matching console to the cart. Test run {run_token}.",
        variables={"query": "PS5"},
        steps=[
            Step(op="search", target="product search box", value="{{query}}"),
            Step(op="verify", target=f"Search results for PS5 are visible on the page for test run {run_token}"),
            Step(op="click", target="Add to cart button for PS5 Console in the search results"),
            Step(op="verify", target=f"The shopping cart states 'PS5 Console added to cart. Quantity: 1' for test run {run_token}"),
        ])
    store = SkillStore(directory / "skills")
    store.save("live_cart_test", program)
    (directory / "skill.json").write_text(program.model_dump_json(indent=2), encoding="utf-8")
    app = create_app(data_dir=store.data_dir, state_dir=directory / "jobs", run_timeout=timeout)

    @app.get("/__live__/shop", response_class=HTMLResponse)
    async def shop():
        return """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Gemini live test shop</title>
<style>body{font:18px sans-serif;max-width:800px;margin:40px auto}button,input{font:inherit;padding:12px}article,section{border:1px solid #ccc;padding:20px;margin:20px 0}</style>
</head><body>
<h1>Console shop</h1><p>Test run: RUN_TOKEN</p>
<form id="search-form"><label for="query">Product search</label>
<input id="query" type="search" name="query"><button type="submit">Search</button></form>
<div id="results" hidden><h2 id="results-title"></h2>
<article class="product-card"><h3>PS5 Console</h3><p>A PlayStation 5 games console.</p>
<button id="add-to-cart" type="button">Add to cart</button></article></div>
<section aria-label="Shopping cart"><h2>Shopping cart</h2><p id="cart">Your cart is empty.</p></section>
<script>
document.querySelector('#search-form').addEventListener('submit', event => {
  event.preventDefault();
  document.querySelector('#results-title').textContent = 'Search results for ' + document.querySelector('#query').value;
  document.querySelector('#results').hidden = false;
});
document.querySelector('#add-to-cart').addEventListener('click', () => {
  document.querySelector('#cart').textContent = 'PS5 Console added to cart. Quantity: 1';
});
</script></body></html>""".replace("RUN_TOKEN", html.escape(run_token))

    @app.get("/__live__/metadata")
    async def metadata():
        # No credentials or environment dumps are exposed/saved.
        return {"model": MODEL, "fallback_model": FALLBACK_MODEL,
                "provider_log_dir": str(DATA / "logs"), "run_token": run_token}

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--result-dir", required=True, type=Path)
    parser.add_argument("--run-token", required=True)
    parser.add_argument("--timeout", type=float, default=240)
    args = parser.parse_args()
    uvicorn.run(make_app(args.result_dir, args.run_token, args.timeout),
                host="127.0.0.1", port=args.port, workers=1, log_level="info")
