# Multi-stage build for fast iteration
FROM rust:1.94-slim AS builder
WORKDIR /app

# 의존성 캐시 레이어: Cargo.toml만 먼저 복사 후 빌드
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

# 소스 복사 후 실제 빌드
COPY src ./src
RUN touch src/main.rs && cargo build --release

# 실행 이미지
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/lens-realtime /usr/local/bin/
EXPOSE 8200
CMD ["lens-realtime"]
