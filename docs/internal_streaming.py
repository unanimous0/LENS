import asyncio
import websockets
import orjson
import logging
from logging.handlers import RotatingFileHandler

# 로거 설정
logger = logging.getLogger("LENS_Internal_Stream")
logger.setLevel(logging.INFO)
handler = RotatingFileHandler("ws_stream.log", maxBytes=50 * 1024 * 1024, backupCount=10)
formatter = logging.Formatter('%(asctime)s - %(message)s')
handler.setFormatter(formatter)
logger.addHandler(handler)

HOST = "10.21.1.208"
PORT = 41001
URI = f"ws://{HOST}:{PORT}"

REQUEST = {
    "symbols": ["A365000", "KA0666000", "A005930", "KA1165000"],
    "real_nav": True,
}

async def log_worker(queue: asyncio.Queue):
    """비동기 큐에서 메시지를 꺼내어 로깅 처리"""
    while True:
        msg = await queue.get()
        if msg is None:
            break
        logger.info(msg)
        queue.task_done()

async def main():
    queue = asyncio.Queue()
    log_task = asyncio.create_task(log_worker(queue))

    try:
        async with websockets.connect(URI) as ws:
            payload = orjson.dumps(REQUEST)
            await ws.send(payload)
            await queue.put(f"sent: {payload.decode('utf-8')}")

            while True:
                msg = await ws.recv()
                
                # 타입(bytes/str)에 상관없이 무조건 JSON 파싱을 먼저 시도합니다.
                try:
                    data = orjson.loads(msg)
                    # 정상적인 JSON 포맷인 경우
                    await queue.put(f"recv(json): {orjson.dumps(data).decode('utf-8')}")
                except orjson.JSONDecodeError:
                    # JSON 파싱에 실패한 경우 (단순 텍스트이거나 깨진 바이트)
                    # 원본 타입에 따라 다르게 로깅하여 디버깅을 용이하게 합니다.
                    if isinstance(msg, bytes):
                        await queue.put(f"recv(bytes_raw): {msg}")
                    else:
                        await queue.put(f"recv(text_raw): {msg}")

    except websockets.exceptions.ConnectionClosed as e:
        await queue.put(f"Connection closed: {e}")
    except Exception as e:
        await queue.put(f"Fatal error: {e}")
    finally:
        await queue.put(None)
        await log_task

if __name__ == "__main__":
    asyncio.run(main())