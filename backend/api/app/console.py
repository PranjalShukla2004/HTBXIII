"""Tee Python output from a job while keeping unrelated terminal output separate."""

import re
import sys
import threading
from contextlib import contextmanager
from contextvars import ContextVar

_current: ContextVar["Capture | None"] = ContextVar("job_console", default=None)
_LINE_END = re.compile(r"\r\n|\r|\n")
_CHUNK_SIZE = 16384
_routes_lock = threading.RLock()


class Capture:
    def __init__(self, callback):
        self.callback = callback
        self.buffers = {"stdout": "", "stderr": ""}
        self.lock = threading.RLock()

    def emit(self, source, message, *, partial=False):
        try:
            self.callback({"source": source, "level": "error" if source == "stderr" else "info",
                           "message": message, "partial": partial})
        except Exception:
            # An observer must never interfere with the original console write.
            pass

    def write(self, source, text):
        with self.lock:
            self._write(source, text)

    def _write(self, source, text):
        text = self.buffers[source] + text
        start = 0
        for match in _LINE_END.finditer(text):
            line = text[start:match.start()]
            while len(line) > _CHUNK_SIZE:
                self.emit(source, line[:_CHUNK_SIZE], partial=True)
                line = line[_CHUNK_SIZE:]
            self.emit(source, line)
            start = match.end()
        remainder = text[start:]
        while len(remainder) >= _CHUNK_SIZE:
            self.emit(source, remainder[:_CHUNK_SIZE], partial=True)
            remainder = remainder[_CHUNK_SIZE:]
        self.buffers[source] = remainder

    def flush(self, source=None):
        with self.lock:
            for name in (source,) if source else tuple(self.buffers):
                if self.buffers[name]:
                    self.emit(name, self.buffers[name], partial=True)
                    self.buffers[name] = ""


class RoutedStream:
    def __init__(self, original, source):
        self.original, self.source, self.users = original, source, 0

    def write(self, text):
        result = self.original.write(text)
        if capture := _current.get():
            capture.write(self.source, text)
        return result

    def flush(self):
        self.original.flush()
        if capture := _current.get():
            capture.flush(self.source)

    def __getattr__(self, name):
        return getattr(self.original, name)


@contextmanager
def capture_console(callback):
    # Reference counts allow overlapping task contexts to share the same tee.
    routes = []
    with _routes_lock:
        for name in ("stdout", "stderr"):
            stream = getattr(sys, name)
            route = stream if isinstance(stream, RoutedStream) else RoutedStream(stream, name)
            route.users += 1
            setattr(sys, name, route)
            routes.append((name, route))
    capture = Capture(callback)
    token = _current.set(capture)
    try:
        yield
    finally:
        capture.flush()
        _current.reset(token)
        with _routes_lock:
            for name, route in routes:
                route.users -= 1
                if route.users == 0 and getattr(sys, name) is route:
                    setattr(sys, name, route.original)


def flush_console():
    if capture := _current.get():
        capture.flush()


@contextmanager
def console_passthrough():
    """Print an already-published progress message without publishing it twice."""
    flush_console()
    token = _current.set(None)
    try:
        yield
    finally:
        _current.reset(token)
