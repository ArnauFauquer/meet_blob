"""One lock around model calls so only one runs on the GPU at a time."""

import asyncio
from collections.abc import Callable


class Gpu:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    async def run[T](self, fn: Callable[..., T], *args: object) -> T:
        """Run fn(*args) in a worker thread under the lock.

        The lock is released only when the thread returns, so a cancelled caller
        cannot let a second model call start while the first one still runs.
        """
        await self._lock.acquire()
        try:
            fut = asyncio.ensure_future(asyncio.to_thread(fn, *args))
        except BaseException:
            self._lock.release()
            raise

        def _done(f: asyncio.Future[T]) -> None:
            self._lock.release()
            if not f.cancelled():
                f.exception()  # mark retrieved when the caller was cancelled

        fut.add_done_callback(_done)
        return await asyncio.shield(fut)
