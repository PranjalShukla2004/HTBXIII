"""Opt-in end-to-end test: real HTTP/WebSockets, Playwright, and Gemini calls."""

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest
from websockets.asyncio.client import connect

API_ROOT = Path(__file__).resolve().parents[1]
RESULT_ROOT = Path(__file__).resolve().parent / "result"
TERMINAL = {"completed", "failed", "needs_human", "cancelled"}

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.getenv("RUN_LIVE_GEMINI") != "1",
                       reason="Set RUN_LIVE_GEMINI=1 to launch a real browser and make Gemini API calls"),
]


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def http(base, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(base + path, data=data,
                      headers={"Content-Type": "application/json"} if data is not None else {})
    with urlopen(request, timeout=15) as response:
        return response.read()


async def collect_streams(base, job, directory, frames, timeout):
    async def consume(channel):
        url = base.replace("http://", "ws://", 1) + job["streams"][channel]
        with (directory / f"{channel}.jsonl").open("w", encoding="utf-8") as output, \
                (directory / f"{channel}.txt").open("w", encoding="utf-8") as text:
            async with connect(url, open_timeout=15, close_timeout=5) as socket:
                async for raw in socket:
                    frame = json.loads(raw)
                    frames[channel].append(frame)
                    output.write(json.dumps(frame, ensure_ascii=False) + "\n")
                    output.flush()
                    payload, kind = frame["data"], frame["type"]
                    if kind == "log":
                        message = payload["message"] + ("" if payload.get("partial") else "\n")
                        text.write(message)
                        print(message, end="", flush=True)
                    elif kind == "llm.start":
                        message = f"\n[Gemini {payload['tag']} call={payload['call_id']} attempt={payload['attempt']} model={payload['model']}]\n"
                        text.write(message)
                        print(message, end="", flush=True)
                    elif kind == "llm.delta":
                        text.write(payload["text"])
                        print(payload["text"], end="", flush=True)
                    elif kind in TERMINAL:
                        text.write(f"\n[{kind}]\n")
                    text.flush()
                    if kind in TERMINAL:
                        return
        raise AssertionError(f"{channel} WebSocket closed without a terminal frame")

    async with asyncio.timeout(timeout + 20):
        async with asyncio.TaskGroup() as tasks:
            for channel in ("llm", "events"):
                tasks.create_task(consume(channel))


def test_real_agent_gemini_and_websocket_output():
    """Search, add to cart, and verify using real Gemini decisions/checks."""
    token = uuid4().hex
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = RESULT_ROOT / f"{stamp}_{token[:8]}"
    directory.mkdir(parents=True)
    write_json(RESULT_ROOT / "latest.json", {"result_dir": str(directory)})
    summary = {"passed": False, "run_token": token, "result_dir": str(directory),
               "started_at": datetime.now(timezone.utc).isoformat(),
               "real_agent": True, "real_gemini": True}
    frames = {"llm": [], "events": []}
    process, job, base, metadata = None, None, None, None
    timeout = float(os.getenv("LIVE_GEMINI_TIMEOUT_SECONDS", "240"))
    print(f"\nLive test artifacts: {directory}", flush=True)
    print("This run uses the real agent, headless Chromium, and your configured Gemini model.", flush=True)

    with (directory / "server.log").open("w", encoding="utf-8") as server_log:
        try:
            with socket.socket() as reserved:
                reserved.bind(("127.0.0.1", 0))
                port = reserved.getsockname()[1]
            base = f"http://127.0.0.1:{port}"
            environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
                           "PROFILE_DIR": str(directory / "browser_profile")}
            process = subprocess.Popen(
                [sys.executable, "-B", str(Path(__file__).with_name("live_server.py")),
                 "--port", str(port), "--result-dir", str(directory),
                 "--run-token", token, "--timeout", str(timeout)],
                cwd=API_ROOT, env=environment, stdout=server_log, stderr=subprocess.STDOUT)

            deadline = time.monotonic() + 20
            while True:
                if process.poll() is not None:
                    raise AssertionError(f"Live server exited; inspect {directory / 'server.log'}")
                try:
                    http(base, "/health")
                    break
                except (URLError, OSError):
                    if time.monotonic() > deadline:
                        raise AssertionError(f"Live server did not start; inspect {directory / 'server.log'}")
                    time.sleep(0.1)

            metadata = json.loads(http(base, "/__live__/metadata"))
            write_json(directory / "metadata.json", metadata)
            request = {"url": base + "/__live__/shop", "arguments": {"query": "PS5"}}
            write_json(directory / "request.json", request)
            job = json.loads(http(base, "/api/skills/live_cart_test/runs", request))
            write_json(directory / "start.json", job)
            print(f"Job: {job['job_id']}; model: {metadata['model']}", flush=True)

            try:
                asyncio.run(collect_streams(base, job, directory, frames, timeout))
            finally:
                final = json.loads(http(base, f"/api/jobs/{job['job_id']}"))
                write_json(directory / "job.json", final)
                (directory / "console.log").write_bytes(http(base, job["log_url"]))
                if final.get("result"):
                    write_json(directory / "result.json", final["result"])
                    if image := final["result"].get("screenshot"):
                        (directory / "screenshot.png").write_bytes(http(base, image))

            replies = [frame["data"] for frame in frames["llm"] if frame["type"] == "llm.response"]
            deltas = [frame for frame in frames["llm"] if frame["type"] == "llm.delta"]
            actions = [frame["data"] for frame in frames["events"] if frame["type"] == "action"]
            summary.update(job_id=job["job_id"], job_status=final["status"],
                           model=metadata["model"], models_used=sorted({reply["model"] for reply in replies}),
                           completed_gemini_calls=len(replies), text_chunks=len(deltas),
                           executed_actions=[action["op"] for action in actions])
            write_json(directory / "gemini_responses.json", replies)

            assert final["status"] == "done", f"Agent ended with {final['status']}; inspect console.log and server.log"
            assert len(replies) >= 3, "Expected real grounding and final-verification model responses"
            assert deltas, "No generated-text chunks reached the LLM WebSocket"
            assert [action["op"] for action in actions] == ["search", "click"]
            checks = [reply["response"] for reply in replies if reply["tag"] == "verify"]
            assert len(checks) == 1 and checks[0].get("passed") is True
            assert len(final["result"]["bindings"]) == 2
            assert (directory / "screenshot.png").is_file()
            assert 'Clicked "Add to cart"' in (directory / "console.log").read_text(encoding="utf-8")
            for channel in frames:
                assert frames[channel][-1]["type"] == "completed"
                assert sum(frame["type"] in TERMINAL for frame in frames[channel]) == 1
                assert not any(frame["type"] == "gap" for frame in frames[channel])
            summary["passed"] = True
        except BaseException as error:
            summary["error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            if process is not None and process.poll() is None:
                if job is not None:
                    try:
                        http(base, f"/api/jobs/{job['job_id']}/cancel", {})
                    except (URLError, OSError):
                        pass
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if metadata:
                originals = directory / "provider_logs"
                originals.mkdir(exist_ok=True)
                for path in Path(metadata["provider_log_dir"]).glob("*.json"):
                    try:
                        payload = json.loads(path.read_text())
                        if token in payload.get("user", ""):
                            shutil.copyfile(path, originals / path.name)
                    except (OSError, ValueError):
                        continue
                summary["provider_log_files"] = len(list(originals.glob("*.json")))
            summary["finished_at"] = datetime.now(timezone.utc).isoformat()
            summary["stream_frames"] = {name: len(items) for name, items in frames.items()}
            write_json(directory / "summary.json", summary)
            print(f"\nSaved live test results: {directory}", flush=True)
