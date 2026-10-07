"""Bounded producer/consumer handoff between the acquisition source and the consumer thread.

A 2a `Ring` is a bounded `queue.Queue` of chunk tuples. The producer (source thread) copies each
chunk in and returns; a single consumer thread drains it, writing raw-to-disk (never dropped) and
producing display frames. The bound provides backpressure: for the rate-limited sim the queue stays
near-empty; with a real DAQ a persistent backlog signals a consumer overrun (surfaced by the
caller). Kept deliberately simple — a pre-allocated ndarray ring is a 2b optimisation if needed.
"""

from __future__ import annotations

import queue
import threading
import time

import numpy as np

_SENTINEL = object()
_POLL_S = 0.1  # how often a blocked get() re-checks `closed`


class Ring:
    def __init__(self, maxsize: int = 64):
        self._q: queue.Queue = queue.Queue(maxsize=maxsize)
        self._closed = threading.Event()

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def put(self, t: np.ndarray, data: np.ndarray, timeout: float | None = None) -> bool:
        """Enqueue a chunk. Returns False if it timed out (consumer overrun) or the ring is closed
        (the consumer is gone or the stream ended: nothing will ever drain it)."""
        if self._closed.is_set():
            return False
        try:
            self._q.put((t, data), timeout=timeout)
            return True
        except queue.Full:
            return False

    def get(self, timeout: float | None = None) -> tuple[np.ndarray, np.ndarray] | None:
        """Dequeue a chunk, or None when the stream has been closed and drained. Raises
        `queue.Empty` if `timeout` elapses first. Every queued chunk is delivered before the
        close is seen, so a normal stop never loses data."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            wait = _POLL_S
            if deadline is not None:
                wait = max(0.0, min(wait, deadline - time.monotonic()))
            try:
                item = self._q.get(timeout=wait)
            except queue.Empty:
                if self._closed.is_set():
                    return None  # closed and nothing left (the sentinel didn't fit, or was taken)
                if deadline is not None and time.monotonic() >= deadline:
                    raise
                continue
            if item is _SENTINEL:
                return None
            return item

    def close(self) -> None:
        """Signal end-of-stream to the consumer. Never blocks: the sentinel is only a wake-up (the
        consumer also notices `closed` once the queue is empty), so when the queue is full, as it
        is when the consumer has died, nothing is waited for and no queued chunk is dropped."""
        self._closed.set()
        try:
            self._q.put_nowait(_SENTINEL)
        except queue.Full:
            pass

    def drain(self) -> None:
        """Discard everything queued (the consumer is gone), freeing slots for a blocked producer."""
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                return

    def qsize(self) -> int:
        return self._q.qsize()
