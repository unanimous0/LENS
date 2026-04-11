"""App global state -- manages data adapter and streaming tasks"""
import asyncio

from core.data.adapter import MarketDataAdapter, NetworkMode
from core.data.mock_adapter import MockAdapter


class AppState:
    def __init__(self):
        self.network_mode = NetworkMode.MOCK
        self.adapter: MarketDataAdapter = MockAdapter()
        self._stream_task: asyncio.Task | None = None

    def _create_adapter(self, mode: NetworkMode) -> MarketDataAdapter:
        if mode == NetworkMode.MOCK:
            return MockAdapter()
        elif mode == NetworkMode.INTERNAL:
            from core.data.internal_adapter import InternalAdapter
            return InternalAdapter()
        elif mode == NetworkMode.EXTERNAL:
            from core.data.external_adapter import ExternalAdapter
            return ExternalAdapter()
        raise ValueError(f"Unknown mode: {mode}")

    async def switch_network(self, mode: NetworkMode, broadcast_fn):
        if self._stream_task:
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
        await self.adapter.disconnect()
        self.network_mode = mode
        self.adapter = self._create_adapter(mode)
        await self.adapter.connect()
        self._stream_task = asyncio.create_task(self._run_streams(broadcast_fn))

    async def _run_streams(self, broadcast_fn):
        async def stream_etf():
            async for tick in self.adapter.subscribe_etf():
                await broadcast_fn({"type": "etf_tick", "data": tick.model_dump()})

        async def stream_futures():
            async for tick in self.adapter.subscribe_futures():
                await broadcast_fn({"type": "futures_tick", "data": tick.model_dump()})

        await asyncio.gather(stream_etf(), stream_futures())


app_state = AppState()
