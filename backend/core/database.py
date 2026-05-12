from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from .config import settings

engine = create_async_engine(settings.DATABASE_URL, echo=settings.DEBUG)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# Finance_Data DB engine — read-only 용도 (ETF master/portfolio, ohlcv 등 시계열).
# peer 인증이라 connection string에 비밀번호 X. 쿼리는 SELECT만 사용 (코드 차원 약속).
korea_engine = create_async_engine(settings.DATABASE_URL_KOREA, echo=False)
korea_async_session = async_sessionmaker(korea_engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        yield session


async def get_korea_db():
    """Finance_Data DB 세션. ETF master/portfolio, 시계열 시세 조회용 (read-only)."""
    async with korea_async_session() as session:
        yield session
