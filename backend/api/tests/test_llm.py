import asyncio
import importlib
import json
from types import SimpleNamespace

import pytest

from app import AGENT_ROOT  # Initializes the source path without importing config.
from app.console import capture_console
from webagent.schemas import Step


class Models:
    def __init__(self):
        self.plain_calls = 0
        self.stream_calls = 0
        self.closed = 0

    async def generate_content(self, **kwargs):
        self.plain_calls += 1
        return SimpleNamespace(text='{"ok":true}')

    async def generate_content_stream(self, **kwargs):
        self.stream_calls += 1

        async def chunks():
            try:
                for text in ('{"ok":', "true}"):
                    yield SimpleNamespace(text=text)
            finally:
                self.closed += 1
        return chunks()


@pytest.fixture
def llm(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "offline-test-key")
    module = importlib.import_module("webagent.llm")
    (tmp_path / "logs").mkdir()
    monkeypatch.setattr(module, "DATA", tmp_path)
    monkeypatch.setattr(module, "STATUS_FILE", tmp_path / "model_status.json")
    monkeypatch.setattr(module, "_unavailable", {})
    monkeypatch.setattr(module, "stats", {"calls": 0})
    monkeypatch.setattr(module, "MODEL", "primary-model")
    monkeypatch.setattr(module, "FALLBACK_MODEL", None)
    monkeypatch.setattr(module, "_sem", asyncio.Semaphore(2))
    models = Models()
    monkeypatch.setattr(module, "client", SimpleNamespace(aio=SimpleNamespace(models=models)))
    return module, models


def test_cli_still_uses_nonstreaming_request(llm):
    module, models = llm
    assert asyncio.run(module.llm_json("system", "user")) == {"ok": True}
    assert models.plain_calls == 1
    assert models.stream_calls == 0


def test_observer_gets_live_deltas_and_complete_json(llm):
    module, models = llm
    events = []

    async def scenario():
        with module.observe_llm(events.append):
            assert await module.llm_json("private-system", "private-user", tag="ground") == {"ok": True}
        assert module._observer.get() is None
    asyncio.run(scenario())
    assert [event["type"] for event in events] == ["llm.start", "llm.delta", "llm.delta", "llm.response"]
    assert "".join(event["text"] for event in events if event["type"] == "llm.delta") == '{"ok":true}'
    assert events[-1]["response"] == {"ok": True}
    assert "private-system" not in repr(events)
    assert "private-user" not in repr(events)
    assert models.closed == 1


def test_observers_are_isolated_between_tasks(llm):
    module, _ = llm
    left, right = [], []

    async def call(tag, events):
        with module.observe_llm(events.append):
            await module.llm_json("system", "user", tag=tag)

    async def scenario():
        await asyncio.gather(call("left", left), call("right", right))
    asyncio.run(scenario())
    assert {event["tag"] for event in left} == {"left"}
    assert {event["tag"] for event in right} == {"right"}


def test_observer_failure_cannot_change_agent_result(llm):
    module, _ = llm

    def broken(event):
        raise RuntimeError("disconnected")

    async def scenario():
        with module.observe_llm(broken):
            return await module.llm_json("system", "user")
    assert asyncio.run(scenario()) == {"ok": True}


def test_partial_failed_attempt_is_not_concatenated_into_retry(llm, monkeypatch):
    module, models = llm
    events, console = [], []
    original = models.generate_content_stream
    monkeypatch.setattr(module, "FALLBACK_MODEL", "fallback-model")

    async def stream(**kwargs):
        if models.stream_calls == 0:
            models.stream_calls += 1

            async def broken():
                yield SimpleNamespace(text='{"discard":')
                raise TimeoutError()
            return broken()
        return await original(**kwargs)

    async def no_wait(seconds):
        return None

    monkeypatch.setattr(models, "generate_content_stream", stream)
    monkeypatch.setattr(module.asyncio, "sleep", no_wait)

    async def scenario():
        with capture_console(console.append), module.observe_llm(events.append):
            return await module.llm_json("system", "user", retries=2)
    assert asyncio.run(scenario()) == {"ok": True}
    assert [e["attempt"] for e in events if e["type"] == "llm.start"] == [1, 2]
    assert any(e["type"] == "llm.retry" for e in events)
    assert len({e["call_id"] for e in events}) == 1
    assert events[-1]["response"] == {"ok": True}
    assert [e["model"] for e in events if e["type"] == "llm.start"] == ["primary-model", "fallback-model"]
    assert module.stats["calls"] == 1
    assert any("[llm:llm]" in frame["message"] and "switching model" in frame["message"] for frame in console)


def test_stream_timeout_closes_provider_iterator(llm, monkeypatch):
    module, models = llm
    events, closed = [], []

    async def stream(**kwargs):
        async def chunks():
            try:
                yield SimpleNamespace(text='{"partial":')
                await asyncio.sleep(10)
            finally:
                closed.append(True)
        return chunks()

    monkeypatch.setattr(models, "generate_content_stream", stream)
    monkeypatch.setattr(module, "LLM_TIMEOUT", 0.01)

    async def scenario():
        with module.observe_llm(events.append):
            with pytest.raises(module.LLMError):
                await module.llm_json("system", "user", retries=1)
    asyncio.run(scenario())
    assert closed == [True]
    assert events[-1]["type"] == "llm.error"


def test_executed_action_hook_preserves_cli_events(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "offline-test-key")
    runner = importlib.import_module("webagent.run")
    (tmp_path / "results").mkdir()
    (tmp_path / "cache").mkdir()
    monkeypatch.setattr(runner, "DATA", tmp_path)
    actions, executed, events = [], [], []

    class Page:
        url = "https://shop.example"

        async def goto(self, url, **kwargs):
            self.url = url

        async def screenshot(self, path):
            path.write_bytes(b"screenshot")

        async def bring_to_front(self):
            pass

        async def close(self):
            pass

    class Context:
        async def new_page(self):
            return Page()

        async def close(self):
            pass

    async def settle(page):
        pass

    async def describe(page):
        return [{"id": 1, "tag": "input", "label": "Search"}]

    async def ground(*args):
        return [{"step": 0, "status": "ok", "element_id": 1, "action": "search", "value": "ps5"}]

    async def act(page, element, op, value):
        executed.append(op)

    def action(payload):
        assert executed == ["search"]  # Report only after act() actually succeeds.
        actions.append(payload)

    monkeypatch.setattr(runner, "settle", settle)
    monkeypatch.setattr(runner, "dismiss_overlays", settle)
    monkeypatch.setattr(runner, "describe_page", describe)
    monkeypatch.setattr(runner, "ground", ground)
    monkeypatch.setattr(runner, "act", act)
    program = runner.IntentProgram(goal="Search", variables={},
                                   steps=[Step(op="search", target="search", value="ps5")])
    result = asyncio.run(runner.run_program(Context(), "https://shop.example", program,
                                           on_event=events.append, on_action=action))
    assert result.status == "done"
    assert actions[0]["value"] == "ps5"
    assert events[-1].kind == "status" and events[-1].message == "done"


def test_cheap_calls_prefer_lite_fallback_without_losing_streaming(llm, monkeypatch):
    module, _ = llm
    monkeypatch.setattr(module, "FALLBACK_MODEL", "backup-model, cheap-lite-model")
    events = []

    async def scenario():
        with module.observe_llm(events.append):
            return await module.llm_json("system", "user", cheap=True)

    assert asyncio.run(scenario()) == {"ok": True}
    assert events[0]["model"] == "cheap-lite-model"
    assert events[-1]["type"] == "llm.response"
    assert module.stats["calls"] == 1


@pytest.mark.parametrize("code,message", [(404, "model not found"), (429, "PerDay quota exceeded")])
def test_unavailable_models_are_persisted_and_stream_fails_over(llm, monkeypatch, code, message):
    module, models = llm
    monkeypatch.setattr(module, "FALLBACK_MODEL", "backup-model")
    original = models.generate_content_stream
    events, requested = [], []

    async def generate(**kwargs):
        requested.append(kwargs["model"])
        if kwargs["model"] == "primary-model":
            raise module.errors.APIError(code, {"error": {"message": message}})
        return await original(**kwargs)

    monkeypatch.setattr(models, "generate_content_stream", generate)

    async def scenario():
        with module.observe_llm(events.append):
            return await module.llm_json("system", "user")

    assert asyncio.run(scenario()) == {"ok": True}
    assert requested == ["primary-model", "backup-model"]
    assert json.loads(module.STATUS_FILE.read_text())["primary-model"] > module.time.time()
    assert module.stats["calls"] == 1
    assert any(event["type"] == "llm.retry" and event["code"] == code for event in events)
    assert events[-1]["model"] == "backup-model"


def test_cached_repeated_actions_are_reported_after_execution(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "offline-test-key")
    runner = importlib.import_module("webagent.run")
    actions, performed = [], []

    async def resolve(page, locator):
        return object()

    async def act_on(page, locator, tag, op, value):
        performed.append((op, value))

    async def settle(page):
        pass

    def report(payload):
        assert len(performed) == payload["repetition"]
        actions.append(payload)

    monkeypatch.setattr(runner, "resolve_locator", resolve)
    monkeypatch.setattr(runner, "act_on", act_on)
    monkeypatch.setattr(runner, "settle", settle)
    page = SimpleNamespace(url="https://shop.example")
    cache = [{"action": "click", "locator": {"tag": "button", "text": "+"},
              "value": None, "repeat": 2, "status": "ok"}]
    assert asyncio.run(runner.replay_step(page, cache, None, on_action=report))
    assert len(actions) == 2
    assert all(action["cached"] for action in actions)
    assert [action["repetition"] for action in actions] == [1, 2]
