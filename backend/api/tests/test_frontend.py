"""Opt-in browser integration: real HTTP/WebSockets, deterministic agent, no Gemini calls."""
import asyncio
import base64
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
from urllib.request import urlopen

import pytest
import uvicorn

from app.main import create_app
from app.storage import SkillStore
from webagent.schemas import AgentEvent, IntentProgram, RunPlan, SiteResult, Step, Trace, TraceEvent

pytestmark = pytest.mark.skipif(os.getenv("RUN_FRONTEND_E2E") != "1", reason="Set RUN_FRONTEND_E2E=1 to run the frontend browser test")
RESULTS = Path(__file__).parent / "result" / "frontend"
FRONTEND = Path(__file__).resolve().parents[3] / "frontend"


def skill():
    return IntentProgram(goal="Find {{query}} and add it to cart", variables={"query": "ps5"}, outputs=["price"], steps=[
        Step(op="search", target="Product search", value="{{query}}"),
        Step(op="click", target="Add to cart"), Step(op="extract", target="Cart total", output="price")])


class BrowserTestAgent:
    """Delays expose loading/progress states; the service itself stays unmodified."""
    def __init__(self, screenshot):
        self.screenshot = screenshot
        self.cancelled = threading.Event()

    @staticmethod
    def text(callback, tag, text):
        metadata = {"call_id": tag, "tag": tag, "attempt": 1}
        callback({"type": "llm.start", **metadata})
        callback({"type": "llm.delta", **metadata, "text": text})

    async def plan(self, prompt, program, *, on_llm):
        self.text(on_llm, "plan", '{"sites":["https://shop.example"]}')
        await asyncio.sleep(0.1)
        query = "hold" if "hold" in prompt else "needs-human" if "needs-human" in prompt else "ps5"
        return RunPlan(variables={"query": query}, sites=["https://shop.example"], summary=f"Find {query}")

    async def run(self, url, program, arguments, *, on_event, on_action, on_llm):
        on_event(AgentEvent(kind="status", site=url, message="acting"))
        on_event(AgentEvent(kind="step", site=url, message="Searching for product", data={"step": 0}))
        self.text(on_llm, "ground", '{"action":"search","value":"ps5"}')
        print('Clicked on "test shop"')
        try:
            if arguments["query"] == "hold":
                await asyncio.Event().wait()
            # Long enough to force a connection loss and resume before completion.
            await asyncio.sleep(1.5)
            on_action({"step": 0, "op": "search", "value": arguments["query"], "url": url})
            on_event(AgentEvent(kind="step", site=url, message="Adding product", data={"step": 1}))
            await asyncio.sleep(0.15)
            on_action({"step": 1, "op": "click", "target": "Add to cart", "url": url})
            print("Added this item to cart")
            on_event(AgentEvent(kind="step", site=url, message="Captured cart total", data={"step": 2, "outputs": {"price": "$499"}}))
            attention = arguments["query"] == "needs-human"
            return SiteResult(url=url, status="needs_human" if attention else "done", outputs={"price": "$499"},
                              screenshot=str(self.screenshot), error="Please check the cart" if attention else None)
        except asyncio.CancelledError:
            self.cancelled.set()
            raise

    async def record(self, url, *, on_event, stop):
        events = [TraceEvent(kind="navigate", url=url, t=time.time()),
                  TraceEvent(kind="click", el={"text": "Add to cart"}, url=url, t=time.time())]
        for event in events:
            on_event(event.model_dump(mode="json"))
        await stop.wait()
        return Trace(start_url=url, events=events)

    async def abstract(self, trace, *, on_llm):
        self.text(on_llm, "abstract", '{"goal":"Find {{query}} and add it to cart"}')
        await asyncio.sleep(0.25)
        return skill(), []


def available_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait_for_url(url):
    for _ in range(100):
        try:
            with urlopen(url, timeout=0.2) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"Server did not start: {url}")


def test_existing_frontend_workflows_over_real_websockets(tmp_path):
    from playwright.sync_api import sync_playwright, expect

    RESULTS.mkdir(parents=True, exist_ok=True)
    screenshot = tmp_path / "final.png"
    screenshot.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="))
    store = SkillStore(tmp_path / "agent")
    store.save("shopping_demo", skill())
    agent = BrowserTestAgent(screenshot)
    api_port, ui_port = available_port(), available_port()
    api_url, ui_url = f"http://127.0.0.1:{api_port}", f"http://127.0.0.1:{ui_port}"
    app = create_app(data_dir=store.data_dir, state_dir=tmp_path / "jobs", backend=agent, origins=[ui_url])
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=api_port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    env = {**os.environ, "VITE_USE_MOCK": "false", "VITE_API_URL": api_url}
    frames, page_errors = [], []
    with (RESULTS / "vite.log").open("w") as log:
        vite = subprocess.Popen(["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(ui_port), "--strictPort"], cwd=FRONTEND, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            wait_for_url(api_url + "/health")
            wait_for_url(ui_url)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                context.tracing.start(screenshots=True, snapshots=True, sources=True)
                page = context.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.on("websocket", lambda ws: ws.on("framereceived", lambda payload: frames.append({"url": ws.url, "frame": json.loads(payload)})))
                page.add_init_script("""window.__sockets = []; const Original = window.WebSocket;
                    window.WebSocket = class extends Original { constructor(...args) { super(...args); window.__sockets.push(this); } };""")
                try:
                    page.goto(ui_url)
                    rail = page.locator("aside:visible")
                    expect(rail.get_by_text("Agent connected", exact=True)).to_be_visible()

                    offline = context.new_page()
                    offline.on("pageerror", lambda error: page_errors.append(str(error)))
                    offline.route(api_url + "/api/skills", lambda route: route.abort())
                    offline.goto(ui_url)
                    expect(offline.locator("aside:visible")).to_contain_text("Agent unavailable")
                    offline.unroute(api_url + "/api/skills")
                    offline.locator("aside:visible").get_by_role("button", name="Retry", exact=True).click()
                    expect(offline.locator("aside:visible").get_by_text("Agent connected", exact=True)).to_be_visible()
                    offline.route(api_url + "/api/skills/shopping_demo/plans", lambda route: route.fulfill(status=503,
                        content_type="application/json", body=json.dumps({"error": {"message": "Agent is restarting"}})))
                    offline.locator("aside:visible").get_by_role("button", name=re.compile(r"^Shopping Demo")).click()
                    offline.get_by_role("textbox", name="Task").fill("Find ps5")
                    offline.get_by_role("button", name="Run", exact=True).click()
                    expect(offline.get_by_role("heading", name="Could not start this task", exact=True)).to_be_visible()
                    expect(offline.get_by_text("Error: Agent is restarting", exact=True)).to_be_visible()
                    offline.close()

                    def run(prompt):
                        rail.get_by_role("button", name=re.compile(r"^Shopping Demo")).click()
                        page.get_by_role("textbox", name="Task", exact=True).fill(prompt)
                        page.get_by_role("button", name="Run", exact=True).click()
                        expect(page.get_by_text("Browser is running", exact=True)).to_be_visible()

                    run("Find ps5 at https://shop.example")
                    expect(page.get_by_role("textbox", name="Task")).to_be_disabled()
                    page.evaluate("window.__sockets.find(s => s.readyState === 1 && s.url.includes('/events') && s.url.includes('after=0')).close()")
                    expect(page.get_by_text("Reconnecting…", exact=True)).to_be_visible()
                    expect(page.get_by_role("cell", name="$499", exact=True)).to_be_visible(timeout=10000)
                    assert page.evaluate("window.__sockets.some(s => new URL(s.url).searchParams.get('after') !== '0')")
                    expect(page.get_by_role("img", name="Final view of shop.example")).to_be_visible()
                    expect(page.get_by_role("img", name="Final view of shop.example")).to_have_js_property("naturalWidth", 1)
                    page.get_by_role("button", name=re.compile(r"^Logs")).click()
                    expect(page.get_by_text("Added this item to cart", exact=True)).to_be_visible()
                    expect(page.get_by_text('Clicked on "test shop"', exact=True)).to_be_visible()
                    page.get_by_role("checkbox", name="debug").check()
                    expect(page.get_by_text(re.compile('Gemini · ground'))).to_contain_text('"action":"search"')
                    page.screenshot(path=RESULTS / "completed.png", full_page=True)
                    expect(page.get_by_role("textbox", name="Task")).to_be_enabled()

                    page.get_by_role("button", name="New task", exact=True).click()
                    run("hold at https://shop.example")
                    page.get_by_role("button", name="Stop", exact=True).click()
                    expect(page.get_by_text("Stopped.", exact=True)).to_be_visible()
                    expect(page.get_by_text("Browser is running", exact=True)).to_have_count(0)
                    assert agent.cancelled.wait(2)
                    expect(page.get_by_role("textbox", name="Task")).to_be_enabled()

                    page.get_by_role("button", name="New task", exact=True).click()
                    agent.cancelled.clear()
                    run("hold at https://shop.example")
                    page.get_by_role("button", name="New task", exact=True).click()
                    expect(page.get_by_text("Show it once.", exact=False)).to_be_visible()
                    assert agent.cancelled.wait(2)

                    run("needs-human at https://shop.example")
                    expect(page.get_by_role("cell", name="Needs attention", exact=True)).to_be_visible(timeout=10000)
                    expect(page.get_by_text("Please check the cart", exact=True)).to_be_visible()

                    def record():
                        rail.get_by_role("button", name="Record a skill", exact=True).click()
                        rail.get_by_role("textbox", name="Start URL").fill("https://shop.example")
                        rail.get_by_role("button", name="Start", exact=True).click()
                        expect(rail.get_by_text("Clicked “Add to cart”", exact=True)).to_be_visible()
                        rail.get_by_role("button", name="Stop · 2 actions", exact=True).click()
                        expect(rail.get_by_text("Reading 2 actions…", exact=True)).to_be_visible()
                        expect(rail.get_by_role("textbox", name="Skill name")).to_be_visible()

                    record()
                    rail.get_by_role("textbox", name="Skill name").fill("My recorded skill")
                    rail.get_by_role("button", name="Save", exact=True).click()
                    expect(rail.get_by_role("button", name=re.compile(r"^My recorded skill"))).to_be_visible()
                    rail.get_by_role("button", name="Show steps for My recorded skill", exact=True).click()
                    rail.get_by_role("button", name="Delete", exact=True).click()
                    expect(rail.get_by_role("button", name=re.compile(r"^My recorded skill"))).to_have_count(0)
                    record()
                    with page.expect_response(lambda response: response.request.method == "DELETE" and "/api/skills/recorded_" in response.url) as discarded:
                        rail.get_by_role("button", name="Discard", exact=True).click()
                    assert discarded.value.status == 204
                    expect(rail.get_by_role("textbox", name="Skill name")).to_have_count(0)
                    assert len(store.list()[0]) == 1

                    page.set_viewport_size({"width": 390, "height": 844})
                    page.locator("main > header > button").first.click()
                    expect(page.locator("aside:visible").get_by_role("button", name=re.compile(r"^Shopping Demo"))).to_be_visible()
                    expect(page.get_by_role("button", name="Close skills", exact=True)).to_be_in_viewport(ratio=1)
                    page.screenshot(path=RESULTS / "mobile.png", full_page=True, animations="disabled")
                    assert not page_errors, page_errors
                    for _ in range(50):
                        if not page.evaluate("window.__sockets.some(s => s.url.includes('/ws/jobs/') && s.readyState !== 3)"):
                            break
                        time.sleep(0.02)
                    assert page.evaluate("window.__sockets.filter(s => s.url.includes('/ws/jobs/')).every(s => s.readyState === 3)")
                    assert all(not stream._waiters for job in app.state.manager.jobs.values() for stream in job.streams.values())
                finally:
                    (RESULTS / "websocket-frames.json").write_text(json.dumps(frames, indent=2))
                    (RESULTS / "page-errors.json").write_text(json.dumps(page_errors, indent=2))
                    page.screenshot(path=RESULTS / "last-state.png", full_page=True)
                    context.tracing.stop(path=RESULTS / "trace.zip")
                    browser.close()
        finally:
            vite.terminate()
            try:
                vite.wait(timeout=10)
            except subprocess.TimeoutExpired:
                vite.kill(); vite.wait(timeout=5)
            server.should_exit = True
            thread.join(timeout=10)
