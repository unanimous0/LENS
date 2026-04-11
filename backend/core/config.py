from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "LENS API"
    DEBUG: bool = True

    DATABASE_URL: str = "postgresql+asyncpg://lens:lens@localhost:5432/lens"
    REDIS_URL: str = "redis://localhost:6379/0"

    NETWORK_MODE: str = "mock"

    CORS_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:3100",
        "http://100.64.229.73:3100",
    ]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
