import asyncio
import os
from contextlib import aclosing, asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated, Literal

import anyio
from fastapi import FastAPI, Query, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import AGENT_ROOT
from .agent import AgentBackend
from .jobs import JobManager, ServiceError
from .models import PlanRequest, RecordingRequest, RunRequest, SkillUpdate
from .storage import SkillStore


def create_app(*, data_dir=None, state_dir=None, backend=None, run_timeout=600,
               recording_timeout=3600, history_limit=512, retained_jobs=100,
                send_timeout=10, origins=None, max_parallel_runs=None):
    store = SkillStore(Path(data_dir) if data_dir is not None else AGENT_ROOT / "data")
    manager = JobManager(store, backend if backend is not None else AgentBackend(),
                        state_dir if state_dir is not None else Path(__file__).resolve().parents[1] / "data",
                        run_timeout=run_timeout, recording_timeout=recording_timeout,
                        history_limit=history_limit, retained_jobs=retained_jobs,
                        max_parallel_runs=max_parallel_runs)
    allowed_origins = origins if origins is not None else [
        value.strip() for value in os.getenv("FRONTEND_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173").split(",")
        if value.strip()]

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            await manager.close()

    app = FastAPI(title="Webagent API", version="0.1.0", lifespan=lifespan)
    app.state.manager = manager
    app.add_middleware(CORSMiddleware, allow_origins=allowed_origins,
                       allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type"],
                       expose_headers=["X-Log-Sequence"])

    @app.middleware("http")
    async def check_origin(request, call_next):
        origin = request.headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            return JSONResponse({"error": {"code": "origin_denied", "message": "Origin is not allowed"}}, status_code=403)
        return await call_next(request)

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/skills")
    async def list_skills():
        skills, invalid = store.list()
        return {"skills": skills, "invalid_files": invalid}

    @app.get("/api/skills/{skill_id}")
    async def get_skill(skill_id: str):
        return store.describe(skill_id, manager.skill(skill_id))

    @app.post("/api/skills/{skill_id}/runs", status_code=202)
    async def run_skill(skill_id: str, command: RunRequest):
        return manager.start_run(skill_id, command).snapshot()

    @app.post("/api/skills/{skill_id}/plans", status_code=202)
    async def plan_skill(skill_id: str, command: PlanRequest):
        return manager.start_plan(skill_id, command).snapshot()

    @app.patch("/api/skills/{skill_id}")
    async def update_skill(skill_id: str, command: SkillUpdate):
        manager.skill(skill_id)
        return store.update_metadata(skill_id, name=command.name.strip(), description=command.description.strip())

    @app.delete("/api/skills/{skill_id}", status_code=204)
    async def delete_skill(skill_id: str):
        manager.skill(skill_id)
        if manager.skill_busy(skill_id):
            raise ServiceError(409, "skill_busy", "Wait for this skill's active job to finish before deleting it")
        store.delete(skill_id)
        return Response(status_code=204)

    @app.post("/api/recordings", status_code=202)
    async def record(command: RecordingRequest):
        return manager.start_recording(command).snapshot()

    @app.post("/api/recordings/{job_id}/stop", status_code=202)
    async def stop_recording(job_id: str):
        return manager.stop_recording(job_id).snapshot()

    @app.get("/api/recordings/{job_id}/trace")
    async def get_trace(job_id: str):
        job = manager.get(job_id)
        if job.kind != "recording" or job.trace is None:
            raise ServiceError(404, "trace_unavailable", "No saved trace is available yet")
        return job.trace

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        return manager.get(job_id).snapshot()

    @app.get("/api/jobs/{job_id}/logs")
    async def get_logs(job_id: str):
        job = manager.get(job_id)
        path = job.console_log
        if path is None or not path.is_file():
            raise ServiceError(404, "logs_unavailable", "No job log is available")
        size = path.stat().st_size

        def chunks():
            # Snapshot the current length so an active job can keep appending.
            remaining = size
            with path.open("rb") as output:
                while remaining:
                    data = output.read(min(65536, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(chunks(), media_type="text/plain", headers={
            "Content-Length": str(size), "X-Log-Sequence": str(job.streams["events"].sequence)})

    @app.post("/api/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str):
        return (await manager.cancel(job_id)).snapshot()

    @app.get("/api/jobs/{job_id}/screenshot")
    async def screenshot(job_id: str):
        path = manager.get(job_id).screenshot
        if path is None or not path.is_file():
            raise ServiceError(404, "screenshot_unavailable", "No screenshot is available")
        return FileResponse(path, media_type="image/png")

    @app.websocket("/ws/jobs/{job_id}/{channel}")
    async def stream(websocket: WebSocket, job_id: str,
                     channel: Literal["llm", "events"],
                     after: Annotated[int, Query(ge=0)] = 0):
        origin = websocket.headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            await websocket.close(code=1008, reason="Origin is not allowed")
            return
        try:
            history = manager.get(job_id).streams[channel]
        except ServiceError:
            await websocket.close(code=1008, reason="Job not found")
            return
        if after > history.sequence:
            await websocket.close(code=1008, reason="Cursor is ahead of the stream")
            return
        await websocket.accept()

        async def send():
            async with aclosing(history.subscribe(after)) as subscription:
                async for frame in subscription:
                    await asyncio.wait_for(websocket.send_json(frame), timeout=send_timeout)

        async def receive():
            # HTTP controls jobs. A separate receive task detects idle disconnects.
            return await websocket.receive()

        sender = asyncio.create_task(send())
        receiver = asyncio.create_task(receive())
        code = 1000
        try:
            done, _ = await asyncio.wait([sender, receiver], return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                message = task.result()
                if task is receiver and message.get("type") != "websocket.disconnect":
                    code = 1008  # Streams are read-only.
        except (TimeoutError, OSError):
            code = 1013
        except WebSocketDisconnect:
            pass
        except asyncio.CancelledError:
            # ASGI may cancel an abandoned connection before receive() reports it.
            # Only this subscription stops; the HTTP-created job is independent.
            pass
        finally:
            sender.cancel()
            receiver.cancel()
            with anyio.CancelScope(shield=True):
                await asyncio.gather(sender, receiver, return_exceptions=True)
                with suppress(WebSocketDisconnect, RuntimeError, OSError):
                    await websocket.close(code=code)

    return app


app = create_app()
