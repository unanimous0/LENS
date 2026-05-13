"""Finance_Data PostgreSQL 연결 (read-only).

LENS backend는 자체 DB 없음 — Finance_Data DB의 ETF 마스터/PDF/시계열만 조회.
peer 인증이라 connection string에 비밀번호 없음. SELECT만 사용 (코드 차원 약속).
"""
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession

from .config import settings

# Finance_Data DB engine. echo=False — ETF 캐시 호출이 잦아 쿼리 로그가 너무 많아짐.
korea_engine = create_async_engine(settings.DATABASE_URL_KOREA, echo=False)
korea_async_session = async_sessionmaker(korea_engine, class_=AsyncSession, expire_on_commit=False)
