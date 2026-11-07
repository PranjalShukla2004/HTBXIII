"""Bounded per-job history, shared by independent WebSocket subscribers."""

import asyncio
import json
import time
from collections import deque


class EventStream:
    def __init__(self, job_id: str, channel: str, *, limit: int = 512,
                 byte_limit: int = 1_048_576):
        self.job_id = job_id
        self.channel = channel
        self.limit = limit
        self.byte_limit = byte_limit
        self.history = deque()
        self.sequence = 0
        self.closed = False
        self._bytes = 0
        self._waiters: set[asyncio.Event] = set()

    def publish(self, kind: str, data: dict) -> None:
        if self.closed:
            return
        self.sequence += 1
        frame = {"v": 1, "job_id": self.job_id, "channel": self.channel,
                 "seq": self.sequence, "type": kind, "data": data, "t": time.time()}
        size = len(json.dumps(frame).encode())
        if size > self.byte_limit:
            frame["data"] = {"truncated": True, "message": "Payload exceeds stream limit; fetch the job result."}
            size = len(json.dumps(frame).encode())
        self.history.append((frame, size))
        self._bytes += size
        while len(self.history) > self.limit or self._bytes > self.byte_limit:
            self._bytes -= self.history.popleft()[1]
        for waiter in tuple(self._waiters):
            waiter.set()

    def finish(self, kind: str, data: dict) -> None:
        self.publish(kind, data)
        self.closed = True
        for waiter in tuple(self._waiters):
            waiter.set()

    async def subscribe(self, after: int = 0):
        wake = asyncio.Event()
        self._waiters.add(wake)
        cursor = after
        try:
            while True:
                wake.clear()
                available = [frame for frame, _ in self.history if frame["seq"] > cursor]
                if available and available[0]["seq"] > cursor + 1:
                    yield {"v": 1, "job_id": self.job_id, "channel": self.channel,
                           "type": "gap", "seq": available[0]["seq"] - 1,
                           "data": {"after": cursor, "oldest_seq": available[0]["seq"]},
                           "t": time.time()}
                for frame in available:
                    yield frame
                    cursor = frame["seq"]
                if self.closed and cursor >= self.sequence:
                    return
                if self.closed:
                    continue
                await wake.wait()
        finally:
            self._waiters.discard(wake)
