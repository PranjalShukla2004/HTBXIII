import asyncio
import json
import sys
import threading

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import create_app
from app.models import RunRequest
from app.storage import SkillStore
from app.streams import EventStream
from webagent.schemas import AgentEvent, IntentProgram, SiteResult, Step, Trace, TraceEvent

FINAL = {"completed", "failed", "needs_human", "cancelled"}


def program():
    return IntentProgram(goal="Search for {{query}}", variables={"query": "shoes"},
                         steps=[Step(op="search", target="product search", value="{{query}}")])


class FakeBackend:
    def __init__(self, *, block=False, fail=False, outcome="done"):
        self.block, self.fail, self.outcome = block, fail, outcome
        self.started = threading.Event()
        self.cleaned = threading.Event()
        self.arguments = None

    @staticmethod
    def llm(on_llm):
        on_llm({"type": "llm.start", "call_id": "test-call", "attempt": 1, "tag": "ground"})
        on_llm({"type": "llm.delta", "call_id": "test-call", "attempt": 1, "text": '{"status":'})
        on_llm({"type": "llm.delta", "call_id": "test-call", "attempt": 1, "text": '"ok"}'})
        on_llm({"type": "llm.response", "call_id": "test-call", "attempt": 1, "response": {"status": "ok"}})

    async def run(self, url, saved, arguments, *, on_event, on_action, on_llm):
        self.arguments = arguments
        self.started.set()
        try:
            if self.fail:
                raise RuntimeError("private internal details")
            on_event(AgentEvent(kind="step", message="Searching", data={"step": 0}))
            self.llm(on_llm)
            on_action({"op": "search", "value": arguments["query"], "step": 0})
            on_event(AgentEvent(kind="status", message="done"))
            if self.block:
                await asyncio.Event().wait()
            return SiteResult(url=url, status=self.outcome)
        finally:
            self.cleaned.set()

    async def record(self, url, *, on_event, stop):
        self.started.set()
        event = TraceEvent(kind="click", el={"text": "Search"}, url=url, t=1)
        on_event(event.model_dump(mode="json"))
        try:
            await stop.wait()
            return Trace(start_url=url, events=[event])
        finally:
            self.cleaned.set()

    async def abstract(self, trace, *, on_llm):
        self.llm(on_llm)
        return program(), []


@pytest.fixture
def make_app(tmp_path):
    def factory(backend=None, **kwargs):
        data_dir, state_dir = tmp_path / "agent", tmp_path / "api"
        store = SkillStore(data_dir)
        store.save("shopping_demo", program(), replace=True)
        return create_app(data_dir=data_dir, state_dir=state_dir,
                          backend=backend or FakeBackend(), **kwargs)
    return factory


def collect(client, job, channel):
    with client.websocket_connect(job["streams"][channel]) as websocket:
        frames = []
        while True:
            frame = websocket.receive_json()
            frames.append(frame)
            if frame["type"] in FINAL:
                return frames


def start(client, **kwargs):
    return client.post("/api/skills/shopping_demo/runs",
                       json={"url": "https://shop.example", **kwargs})


def test_list_skills_and_defaults_without_loading_llm(make_app):
    with TestClient(make_app()) as client:
        assert client.get("/health").json() == {"status": "ok"}
        response = client.get("/api/skills").json()
        assert response["skills"][0]["id"] == "shopping_demo"
        assert response["skills"][0]["arguments"]["query"]["default"] == "shoes"
        assert client.get("/api/skills/missing").status_code == 404


def test_run_replays_both_streams_with_isolated_messages(make_app):
    backend = FakeBackend()
    with TestClient(make_app(backend)) as client:
        response = start(client, arguments={"query": "ps5"})
        assert response.status_code == 202
        job = response.json()
        events = collect(client, job, "events")
        llm = collect(client, job, "llm")
        assert backend.arguments == {"query": "ps5"}
        assert events[-1]["type"] == llm[-1]["type"] == "completed"
        assert any(f["type"] == "action" for f in events)
        assert not any(f["type"].startswith("llm.") for f in events)
        assert not any(f["type"] in {"action", "agent", "recorder"} for f in llm)
        assert "".join(f["data"]["text"] for f in llm if f["type"] == "llm.delta") == '{"status":"ok"}'
        assert [f["seq"] for f in llm] == list(range(1, len(llm) + 1))
        assert client.get(f'/api/jobs/{job["job_id"]}').json()["status"] == "done"
        assert client.get(f'/api/jobs/{job["job_id"]}/screenshot').status_code == 404


def test_validates_arguments_url_and_unknown_fields(make_app):
    with TestClient(make_app()) as client:
        assert start(client, arguments={"unknown": "x"}).status_code == 422
        assert start(client, arguments={"query": 42}).status_code == 422
        assert start(client, surprise=True).status_code == 422
        assert client.post("/api/skills/shopping_demo/runs", json={"url": "file:///etc/passwd"}).status_code == 422
        assert client.post("/api/skills/shopping_demo/runs", json={"url": "https://user:pass@shop.example"}).status_code == 422
        response = client.post("/api/skills/shopping_demo/runs", json={"url": "www.amazon.com"})
        assert response.status_code == 202
        assert response.json()["url"] == "https://www.amazon.com/"
        collect(client, response.json(), "events")


def test_record_stop_creates_a_skill_and_preserves_trace(make_app):
    with TestClient(make_app()) as client:
        response = client.post("/api/recordings", json={"url": "https://shop.example", "skill_id": "new_skill"})
        assert response.status_code == 202
        job = response.json()
        assert start(client).status_code == 409
        assert client.post(f'/api/recordings/{job["job_id"]}/stop').status_code == 202
        events = collect(client, job, "events")
        llm = collect(client, job, "llm")
        assert any(f["type"] == "recorder" for f in events)
        assert any(f["type"] == "status" and f["data"]["status"] == "processing" for f in events)
        assert llm[-1]["type"] == "completed"
        assert client.get("/api/skills/new_skill").status_code == 200
        trace = client.get(f'/api/recordings/{job["job_id"]}/trace').json()
        assert trace["events"][0]["kind"] == "click"
        assert client.post(f'/api/recordings/{job["job_id"]}/stop').json()["status"] == "done"


def test_recording_requires_explicit_replace(make_app):
    with TestClient(make_app()) as client:
        assert client.post("/api/recordings", json={"url": "https://shop.example", "skill_id": "shopping_demo"}).status_code == 409
        assert client.post("/api/recordings", json={"url": "https://shop.example", "skill_id": "../escape"}).status_code == 422


def test_disconnect_does_not_cancel_job_and_http_cancel_cleans_up(make_app):
    backend = FakeBackend(block=True)
    app = make_app(backend)
    with TestClient(app) as client:
        job = start(client).json()
        assert backend.started.wait(2)
        with client.websocket_connect(job["streams"]["events"]) as websocket:
            websocket.receive_json()
        assert client.portal.call(lambda: len(app.state.manager.get(job["job_id"]).streams["events"]._waiters)) == 0
        assert client.get(f'/api/jobs/{job["job_id"]}').json()["status"] == "running"
        cancelled = client.post(f'/api/jobs/{job["job_id"]}/cancel').json()
        assert cancelled["status"] == "cancelled"
        assert backend.cleaned.is_set()
        for channel in ("llm", "events"):
            frames = collect(client, job, channel)
            assert frames[-1]["type"] == "cancelled"
            assert sum(f["type"] in FINAL for f in frames) == 1
        assert start(client).status_code == 202


@pytest.mark.parametrize("outcome", ["failed", "needs_human"])
def test_agent_outcomes_are_not_reported_as_success(make_app, outcome):
    with TestClient(make_app(FakeBackend(outcome=outcome))) as client:
        job = start(client).json()
        assert collect(client, job, "events")[-1]["type"] == outcome


def test_startup_errors_are_terminal_without_private_details(make_app):
    with TestClient(make_app(FakeBackend(fail=True))) as client:
        job = start(client).json()
        frames = collect(client, job, "llm")
        assert frames[-1]["type"] == "failed"
        assert "private internal details" not in json.dumps(frames)


def test_timeout_releases_browser_admission(make_app):
    backend = FakeBackend(block=True)
    with TestClient(make_app(backend, run_timeout=0.02)) as client:
        job = start(client).json()
        final = collect(client, job, "events")[-1]
        assert final["data"]["error"]["code"] == "timeout"
        assert backend.cleaned.is_set()
        assert start(client).status_code == 202


def test_origin_and_unknown_job_are_rejected(make_app):
    with TestClient(make_app()) as client:
        assert client.post("/api/recordings", headers={"Origin": "https://untrusted.example"},
                           json={"url": "https://shop.example", "skill_id": "x"}).status_code == 403
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/jobs/missing/llm"):
                pass
        job = start(client).json()
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(job["streams"]["events"], headers={"Origin": "https://untrusted.example"}):
                pass


def test_history_replay_cursor_and_gap(make_app):
    with TestClient(make_app(history_limit=3)) as client:
        job = start(client).json()
        frames = collect(client, job, "llm")
        assert frames[0]["type"] == "gap"
        assert frames[-1]["type"] == "completed"
        after = frames[-2]["seq"]
        with client.websocket_connect(job["streams"]["llm"] + f"?after={after}") as websocket:
            assert websocket.receive_json()["type"] == "completed"


def test_stream_keeps_terminal_published_while_replaying():
    async def scenario():
        stream = EventStream("job", "events")
        stream.publish("agent", {"message": "before"})
        subscription = stream.subscribe()
        assert (await anext(subscription))["type"] == "agent"
        stream.finish("completed", {})
        assert [frame["type"] async for frame in subscription] == ["completed"]
        assert not stream._waiters
    asyncio.run(scenario())


def test_cancelling_before_worker_starts_releases_admission(make_app):
    async def scenario():
        app = make_app(FakeBackend(block=True))
        manager = app.state.manager
        job = manager.start_run("shopping_demo", RunRequest(url="https://shop.example"))
        await manager.cancel(job.id)
        assert job.status == "cancelled"
        following = manager.start_run("shopping_demo", RunRequest(url="https://shop.example"))
        await manager.cancel(following.id)
        await manager.close()
    asyncio.run(scenario())


def test_screenshot_is_copied_before_a_later_run_overwrites_it(make_app, tmp_path):
    source = tmp_path / "shared-site.png"

    class ScreenshotBackend(FakeBackend):
        async def run(self, *args, **kwargs):
            result = await super().run(*args, **kwargs)
            source.write_bytes(b"first screenshot")
            result.screenshot = str(source)
            return result

    with TestClient(make_app(ScreenshotBackend())) as client:
        job = start(client).json()
        final = collect(client, job, "events")[-1]
        url = final["data"]["result"]["screenshot"]
        source.write_bytes(b"later run screenshot")
        assert client.get(url).content == b"first screenshot"


def test_shutdown_cancels_the_worker_and_releases_admission(make_app):
    backend = FakeBackend(block=True)
    app = make_app(backend)
    with TestClient(app) as client:
        job = start(client).json()
        assert backend.started.wait(2)
    assert backend.cleaned.is_set()
    assert app.state.manager.get(job["job_id"]).status == "cancelled"
    assert app.state.manager._active is None


def test_frontend_gets_all_job_text_and_complete_saved_log(make_app):
    class PrintingBackend(FakeBackend):
        async def run(self, *args, **kwargs):
            print('Clicked on "test shop"')
            print("Added this item to cart")
            print("job diagnostic", file=sys.stderr)
            await asyncio.to_thread(print, "worker output")
            print("unfinished text", end="")
            return await super().run(*args, **kwargs)

    with TestClient(make_app(PrintingBackend())) as client:
        job = start(client).json()
        events = collect(client, job, "events")
        logs = [f["data"] for f in events if f["type"] == "log"]
        messages = [entry["message"] for entry in logs]
        for text in ('Clicked on "test shop"', "Added this item to cart", "worker output",
                     "unfinished text", "[step  ] Searching", "RESULT: done", "screenshot: None"):
            assert text in messages
        assert any("Searched for" in text and "shoes" in text for text in messages)
        assert any(entry["source"] == "stderr" and entry["message"] == "job diagnostic" for entry in logs)
        assert events[-1]["type"] == "completed"
        assert len(messages) == len(set(messages))
        response = client.get(job["log_url"])
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        assert int(response.headers["content-length"]) == len(response.content)
        assert int(response.headers["x-log-sequence"]) == events[-1]["seq"]
        for message in messages:
            assert message in response.text
        assert not any(f["type"] == "log" for f in collect(client, job, "llm"))


def test_log_endpoint_recovers_messages_after_websocket_history_expires(make_app):
    class PrintingBackend(FakeBackend):
        async def run(self, *args, **kwargs):
            for i in range(20):
                print(f"progress {i}")
            return await super().run(*args, **kwargs)

    with TestClient(make_app(PrintingBackend(), history_limit=3)) as client:
        job = start(client).json()
        events = collect(client, job, "events")
        assert events[0]["type"] == "gap"
        saved = client.get(job["log_url"]).text
        assert "Queued run" in saved
        for i in range(20):
            assert f"progress {i}\n" in saved
        assert "RESULT: done" in saved
        response = client.get(job["log_url"], headers={"Origin": "http://localhost:3000"})
        assert response.headers["access-control-expose-headers"] == "X-Log-Sequence"


def test_recording_logs_include_steps_warnings_and_saved_skill(make_app):
    class WarningBackend(FakeBackend):
        async def abstract(self, trace, *, on_llm):
            saved, _ = await super().abstract(trace, on_llm=on_llm)
            return saved, ["no verify step"]

    with TestClient(make_app(WarningBackend())) as client:
        job = client.post("/api/recordings", json={"url": "https://shop.example", "skill_id": "logged_skill"}).json()
        client.post(f'/api/recordings/{job["job_id"]}/stop')
        frames = collect(client, job, "events")
        messages = [f["data"]["message"] for f in frames if f["type"] == "log"]
        assert any(message.startswith("[rec] click") for message in messages)
        assert any(message.startswith("GOAL:") for message in messages)
        assert any(message.startswith("VARIABLES:") for message in messages)
        assert any("product search" in message for message in messages)
        assert "warning: no verify step" in messages
        assert "Saved skill logged_skill" in messages
        assert "Saved 1 cleaned events." in client.get(job["log_url"]).text
