import asyncio
import threading
import time

import pytest

from blob.gpu import Gpu
from tests.conftest import eventually


async def test_returns_result_and_raises() -> None:
    gpu = Gpu()
    assert await gpu.run(lambda a, b: a + b, 2, 3) == 5

    def boom() -> None:
        raise RuntimeError("oom")

    with pytest.raises(RuntimeError, match="oom"):
        await gpu.run(boom)
    assert await gpu.run(lambda: "free") == "free"  # the lock was released


async def test_cancelled_caller_keeps_lock_until_thread_returns() -> None:
    gpu = Gpu()
    release = threading.Event()
    order: list[str] = []

    def slow() -> None:
        order.append("slow start")
        release.wait(5)
        order.append("slow end")

    def fast() -> None:
        order.append("fast")

    first = asyncio.create_task(gpu.run(slow))
    await eventually(lambda: order)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(gpu.run(fast))
    await asyncio.sleep(0.1)
    assert order == ["slow start"]  # the second call waits for the first thread
    release.set()
    await asyncio.wait_for(second, 5)
    assert order == ["slow start", "slow end", "fast"]


async def test_cancelled_caller_with_failing_thread() -> None:
    gpu = Gpu()

    def fail() -> None:
        time.sleep(0.05)
        raise RuntimeError("late")

    task = asyncio.create_task(gpu.run(fail))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await asyncio.wait_for(gpu.run(lambda: 1), 5) == 1
