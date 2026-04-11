"""LENS API -- unified entry point"""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.config import settings
from core.app_state import app_state
from routers import health, lending, market
from routers.ws import router as ws_router, broadcast


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: connect adapter and start streaming
    await app_state.adapter.connect()
    app_state._stream_task = asyncio.create_task(
        app_state._run_streams(broadcast)
    )
    yield
    # Shutdown: clean up
    if app_state._stream_task:
        app_state._stream_task.cancel()
    await app_state.adapter.disconnect()


app = FastAPI(title=settings.APP_NAME, debug=settings.DEBUG, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(lending.router, prefix="/api")
app.include_router(market.router, prefix="/api")
app.include_router(ws_router)
