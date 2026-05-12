from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "LENS API"
    DEBUG: bool = True

    DATABASE_URL: str = "postgresql+asyncpg://lens:lens@localhost:5432/lens"
    # Finance_Data DB (한국 주식/ETF 시계열). peer 인증 — 비밀번호 X.
    # 신규 테이블: etf_portfolio_daily / etf_master_daily (5일 슬라이딩 윈도우).
    DATABASE_URL_KOREA: str = "postgresql+asyncpg://una0@/korea_stock_data?host=/var/run/postgresql"
    REDIS_URL: str = "redis://localhost:6379/0"

    NETWORK_MODE: str = "mock"

    CORS_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:3100",
        "http://100.64.229.73:3100",
    ]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
