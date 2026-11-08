import asyncio
import inspect
import logging
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

from .console import capture_console, console_passthrough, flush_console
from .messages import action_message, recorder_message
from .storage import SkillStore
from .streams import EventStream

logger = logging.getLogger(__name__)
TERMINAL = {"done", "failed", "needs_human", "cancelled"}


def _accepts(function, name):
    """Whether a backend method takes this keyword (older/test backends may not)."""
    try:
        parameters = inspect.signature(function).parameters
    except (TypeError, ValueError):
        return False
    return name in parameters or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values())


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


@dataclass
class Job:
    id: str
    kind: str
    skill_id: str
    url: str
    streams: dict[str, EventStream]
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    result: dict | None = None
    error: dict | None = None
    trace: dict | None = None
    screenshot: Path | None = None
    console_log: Path | None = None
    log_error: bool = False
    task: asyncio.Task | None = None
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    # A run that is waiting for the shopper: {"field", "question", "options"} and its answer.
    question: dict | None = None
    answer: asyncio.Future | None = None
    deadline: asyncio.Timeout | None = None
    timeout: float | None = None        # overrides the manager's limit (e.g. several products)

    def snapshot(self):
        return {"job_id": self.id, "kind": self.kind, "skill_id": self.skill_id,
                "url": self.url, "status": self.status,
                "created_at": self.created_at, "updated_at": self.updated_at,
                "result": self.result, "error": self.error, "question": self.question,
                "log_url": f"/api/jobs/{self.id}/logs",
                "streams": {channel: f"/ws/jobs/{self.id}/{channel}"
                            for channel in self.streams}}


class JobManager:
    def __init__(self, store, backend, state_dir, *, run_timeout=600,
                 recording_timeout=3600, history_limit=512, retained_jobs=100,
                 answer_timeout=900):
        self.store = store
        self.backend = backend
        self.state_dir = Path(state_dir)
        self.run_timeout = run_timeout
        self.recording_timeout = recording_timeout
        self.answer_timeout = answer_timeout
        self.history_limit = history_limit
        self.retained_jobs = retained_jobs
        self.jobs: dict[str, Job] = {}
        self._active: str | None = None
        self._closing = False

    def get(self, job_id):
        try:
            return self.jobs[job_id]
        except KeyError:
            raise ServiceError(404, "job_not_found", "Job not found") from None

    def skill(self, skill_id):
        try:
            return self.store.load(skill_id)
        except FileNotFoundError:
            raise ServiceError(404, "skill_not_found", "Skill not found") from None
        except (ValueError, OSError):
            raise ServiceError(422, "invalid_skill", "The saved skill is invalid") from None

    def _create(self, kind, skill_id, url):
        if self._closing:
            raise ServiceError(503, "shutting_down", "The API is shutting down")
        if self._active is not None:
            raise ServiceError(409, "busy", "A recording or skill run is already active")
        while len(self.jobs) >= self.retained_jobs:
            oldest = next((j for j in self.jobs.values() if j.status in TERMINAL), None)
            if oldest is None:
                raise ServiceError(409, "busy", "No job slot is available")
            self.jobs.pop(oldest.id)
        job_id = uuid4().hex
        streams = {channel: EventStream(job_id, channel, limit=self.history_limit)
                   for channel in ("llm", "events")}
        job = Job(job_id, kind, skill_id, url, streams)
        job.console_log = self.state_dir / job_id / "console.log"
        self.jobs[job_id] = job
        self._active = job_id
        self._status(job, "queued")
        return job

    def start_run(self, skill_id, request):
        program = self.skill(skill_id)
        unknown = request.arguments.keys() - program.variables.keys()
        if unknown:
            raise ServiceError(422, "unknown_arguments", "Unknown arguments: " + ", ".join(sorted(unknown)))
        job = self._create("run", skill_id, str(request.url))
        arguments = {**program.variables, **request.arguments}
        constraints = request.constraints.model_dump() if request.constraints else None
        if request.constraints and request.constraints.items > 1:
            job.timeout = self.run_timeout * request.constraints.items   # one budget per product
        self._schedule(job, self._run(job, program, arguments, choices=dict(request.choices),
                                      constraints=constraints))
        return job

    def answer(self, job_id, request):
        """Hand the shopper's answer to a run that is waiting for one."""
        job = self.get(job_id)
        if job.question is None or job.answer is None or job.answer.done():
            raise ServiceError(409, "no_question", "This job is not waiting for an answer")
        if request.field and request.field != job.question["field"]:
            raise ServiceError(409, "question_changed", "The agent is asking a different question now")
        self._log(job, f"Answer received: {job.question['field']} = {request.value}", source="status")
        job.answer.set_result(request.value)
        return job

    async def _ask(self, job, field_name, question, options):
        """run_program's ask(): publish the question, then wait for POST /api/jobs/{id}/answer."""
        loop = asyncio.get_running_loop()
        job.answer = loop.create_future()
        job.question = {"field": field_name, "question": question, "options": list(options)}
        self._status(job, "needs_input")
        # Time spent waiting for a person doesn't count against the run's time limit.
        remaining = None
        if job.deadline is not None and job.deadline.when() is not None:
            remaining = job.deadline.when() - loop.time()
            job.deadline.reschedule(None)
        try:
            return await asyncio.wait_for(job.answer, timeout=self.answer_timeout)
        except TimeoutError:
            self._log(job, f"No answer within {self.answer_timeout // 60} minutes: {question}",
                      source="status", level="warning")
            return None
        finally:
            job.question, job.answer = None, None
            if remaining is not None and job.deadline is not None:
                job.deadline.reschedule(loop.time() + max(remaining, 60))
            if job.status == "needs_input":
                self._status(job, "running", log=False)

    def start_plan(self, skill_id, request):
        program = self.skill(skill_id)
        job = self._create("plan", skill_id, "")
        self._schedule(job, self._plan(job, program, request.prompt))
        return job

    async def _plan(self, job, program, prompt):
        self._status(job, "planning")
        plan = await self.backend.plan(prompt, program, on_llm=lambda payload: self._llm(job, payload))
        return plan.model_dump(mode="json"), "done"

    def start_recording(self, request):
        path = self.store.path(request.skill_id)
        if path.exists() and not request.replace:
            raise ServiceError(409, "skill_exists", "Skill already exists; choose a new ID or set replace=true")
        job = self._create("recording", request.skill_id, str(request.url))
        self._schedule(job, self._record(job, replace=request.replace))
        return job

    def _schedule(self, job, operation):
        job.task = asyncio.create_task(self._execute(job, operation), name=f"webagent-{job.id}")

        def complete(task):
            # A task cancelled before its first instruction never enters finally.
            if task.cancelled():
                operation.close()
                if job.status not in TERMINAL:
                    self._finish(job, "cancelled")
            elif task.exception() is not None:
                logger.error("Unhandled job failure", exc_info=task.exception())
                if job.status not in TERMINAL:
                    self._finish(job, "failed", error={"code": "execution_failed", "message": "Execution failed"})
            if self._active == job.id:
                self._active = None

        job.task.add_done_callback(complete)

    async def _execute(self, job, operation):
        loop, owner = asyncio.get_running_loop(), threading.get_ident()

        def output(payload):
            if threading.get_ident() == owner:
                self._publish_log(job, payload)
            else:
                loop.call_soon_threadsafe(self._publish_log, job, payload)

        with capture_console(output):
            await self._execute_captured(job, operation)

    async def _execute_captured(self, job, operation):
        timeout = job.timeout or (self.recording_timeout if job.kind == "recording" else self.run_timeout)
        try:
            async with asyncio.timeout(timeout) as deadline:
                job.deadline = deadline
                result, status = await operation
            self._finish(job, status, result=result)
        except asyncio.CancelledError:
            self._finish(job, "cancelled")
            raise
        except TimeoutError:
            self._finish(job, "failed", error={"code": "timeout", "message": "Job exceeded its time limit"})
        except Exception:
            self._log(job, "Execution failed; check the API server logs", source="status", level="error")
            logger.exception("Job %s failed", job.id)
            self._finish(job, "failed", error={"code": "execution_failed",
                                               "message": "Execution failed; check the API server logs"})

    def _status(self, job, status, *, log=True):
        job.status, job.updated_at = status, time.time()
        for stream in job.streams.values():
            stream.publish("status", {"status": status, "kind": job.kind, "skill_id": job.skill_id})
        if not log:
            return
        message = {
            "queued": f"Queued {job.kind} for skill {job.skill_id} on {job.url}",
            "running": f"Running skill {job.skill_id} on {job.url}",
            "recording": f"Recording {job.url}. Interact with the browser, then stop the recording.",
            "stopping": "Stopping recording...",
            "processing": "Recording stopped. Creating the skill from the recorded actions...",
            "planning": f"Planning a run for skill {job.skill_id}",
            "needs_input": f"Waiting for the shopper: {(job.question or {}).get('question', '')}",
        }.get(status, status)
        self._log(job, message, source="status")

    def _publish_log(self, job, payload):
        if job.streams["events"].closed:
            return
        if job.console_log is not None:
            try:
                job.console_log.parent.mkdir(parents=True, exist_ok=True)
                with job.console_log.open("a", encoding="utf-8") as output:
                    output.write(payload["message"] + ("" if payload.get("partial") else "\n"))
            except OSError:
                if not job.log_error:
                    job.log_error = True
                    job.streams["events"].publish("log", {"source": "status", "level": "warning",
                        "message": "The job log could not be saved; live messages remain available.", "partial": False})
        job.streams["events"].publish("log", payload)

    def _log(self, job, message, *, source="agent", level="info"):
        with console_passthrough():
            self._publish_log(job, {"source": source, "level": level,
                                    "message": message, "partial": False})
            print(message, flush=True)

    def _agent_event(self, job, event):
        job.streams["events"].publish("agent", event.model_dump(mode="json"))
        self._log(job, f"[{event.kind:6}] {event.message}", level="error" if event.kind == "error" else "info")

    def _action(self, job, action):
        job.streams["events"].publish("action", action)
        self._log(job, action_message(action, job.url), source="action")

    def _recorder_event(self, job, event):
        job.streams["events"].publish("recorder", event)
        self._log(job, recorder_message(event), source="recorder")

    def _finish(self, job, status, *, result=None, error=None):
        if job.status in TERMINAL:
            return
        flush_console()
        detail = (error or {}).get("message") or (result or {}).get("error")
        self._log(job, f"RESULT: {status}" + (f" - {detail}" if detail else ""), source="status",
                  level="error" if status == "failed" else "info")
        if job.kind == "run":
            self._log(job, f"screenshot: {(result or {}).get('screenshot')}", source="status")
        job.status, job.updated_at = status, time.time()
        job.result, job.error = result, error
        kind = {"done": "completed", "failed": "failed", "needs_human": "needs_human",
                "cancelled": "cancelled"}[status]
        payload = {"status": status, "result": result, "error": error}
        for stream in job.streams.values():
            stream.finish(kind, payload)

    def _llm(self, job, payload):
        job.streams["llm"].publish(payload["type"], {k: v for k, v in payload.items() if k != "type"})

    async def _run(self, job, program, arguments, *, choices=None, constraints=None):
        self._status(job, "running")
        extra = {}
        if _accepts(self.backend.run, "ask"):
            extra["ask"] = lambda field_name, question, options: self._ask(job, field_name, question, options)
        if choices and _accepts(self.backend.run, "answers"):
            extra["answers"] = dict(choices)
        if constraints and _accepts(self.backend.run, "constraints"):
            extra["constraints"] = constraints
        result = await self.backend.run(
            job.url, program, arguments,
            on_event=lambda event: self._agent_event(job, event),
            on_action=lambda action: self._action(job, action),
            on_llm=lambda payload: self._llm(job, payload), **extra)
        payload = result.model_dump(mode="json")
        if result.screenshot:
            destination = self.state_dir / job.id / "screenshot.png"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(result.screenshot, destination)
            job.screenshot = destination
            payload["screenshot"] = f"/api/jobs/{job.id}/screenshot"
        SkillStore.atomic_json(self.state_dir / job.id / "result.json", payload)
        return payload, result.status

    async def _record(self, job, *, replace):
        self._status(job, "recording")
        trace = await self.backend.record(
            job.url, stop=job.stop,
            on_event=lambda event: self._recorder_event(job, event))
        job.trace = trace.model_dump(mode="json")
        SkillStore.atomic_json(self.state_dir / job.id / "trace.json", job.trace)
        self._log(job, f"Saved {len(trace.events)} cleaned events. Trace: /api/recordings/{job.id}/trace", source="recorder")
        if not trace.events:
            raise ValueError("Recording is empty")
        self._status(job, "processing")
        program, warnings = await self.backend.abstract(trace, on_llm=lambda payload: self._llm(job, payload))
        self._log(job, f"GOAL: {program.goal}", source="skill")
        self._log(job, f"VARIABLES: {program.variables}", source="skill")
        for i, step in enumerate(program.steps):
            optional = " (optional)" if step.optional else ""
            value = f"  <- {step.value}" if step.value else ""
            self._log(job, f"{i:2}. {step.op:12} {step.target}{value}{optional}", source="skill")
        for warning in warnings:
            self._log(job, f"warning: {warning}", source="skill", level="warning")
        self.store.save(job.skill_id, program, replace=replace)
        self.store.update_metadata(job.skill_id, site={"url": job.url, "title": job.url})
        self._log(job, f"Saved skill {job.skill_id}", source="skill")
        return {"skill": self.store.describe(job.skill_id, program),
                "warnings": warnings, "event_count": len(trace.events),
                "trace_url": f"/api/recordings/{job.id}/trace"}, "done"

    def stop_recording(self, job_id):
        job = self.get(job_id)
        if job.kind != "recording":
            raise ServiceError(409, "not_recording", "This job is not a recording")
        if job.status not in TERMINAL and job.status != "processing":
            job.stop.set()
            self._status(job, "stopping")
        return job

    async def cancel(self, job_id):
        job = self.get(job_id)
        if job.task and not job.task.done():
            job.task.cancel()
            await asyncio.gather(job.task, return_exceptions=True)
        return job

    async def close(self):
        self._closing = True
        tasks = [job.task for job in self.jobs.values() if job.task and not job.task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if close := getattr(self.backend, "close", None):
            await close()
