"""
FastAPI server for Sonara Voice VS Code extension.
Receives audio, transcribes via faster-whisper, returns text.

Usage:
    python server.py --port 0 --model large-v3 --device auto
                     --compute-type auto --storage-dir /path/to/models
                     --token <secret> --port-file /path/to/server.port
                     --log-file /path/to/server.log
"""

import argparse
import asyncio
import io
import json
import os
import socket
import struct
import sys
import threading
import time
from contextlib import asynccontextmanager
from typing import Optional


def _force_tqdm_progress_even_without_tty() -> None:
    """faster-whisper / huggingface_hub use tqdm, which auto-disables when stderr is not a TTY.
    When VS Code spawns us through a pipe there is no TTY, so the progress bar never prints
    and the extension can't parse percent updates. Force tqdm to stay enabled."""
    print("[tqdm-patch] starting", flush=True)
    try:
        import tqdm as tqdm_pkg
        import tqdm.std
        print(f"[tqdm-patch] tqdm version: {tqdm_pkg.__version__}", flush=True)
        original_init = tqdm.std.tqdm.__init__

        def patched_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs["disable"] = False
            kwargs["mininterval"] = 0.1
            kwargs["miniters"] = 1
            original_init(self, *args, **kwargs)

        tqdm.std.tqdm.__init__ = patched_init  # type: ignore[method-assign]
        print("[tqdm-patch] patched tqdm.std.tqdm.__init__", flush=True)
    except Exception as exc:
        print(f"[tqdm-patch] FAILED: {exc}", flush=True)


_force_tqdm_progress_even_without_tty()


import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from loguru import logger
from pydantic import BaseModel

from hallucination_filter import sanitize_transcription
from streaming_transcriber import StreamingTranscriber


def setup_logging(log_file: Optional[str]) -> None:
    logger.remove()
    logger.add(sys.stdout, level="INFO", format="{time:YYYY-MM-DD HH:mm:ss} [{level}] {message}")
    if log_file:
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
        logger.add(log_file, level="INFO", rotation="5 MB", retention=5, enqueue=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sonara Voice Whisper server")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--model", type=str, default="large-v3")
    parser.add_argument("--device", type=str, default="auto")
    parser.add_argument("--compute-type", type=str, default="auto", dest="compute_type")
    parser.add_argument("--beam-size", type=int, default=5, dest="beam_size")
    parser.add_argument("--storage-dir", type=str, required=True, dest="storage_dir")
    parser.add_argument("--token", type=str, required=True)
    parser.add_argument("--port-file", type=str, required=True, dest="port_file")
    parser.add_argument("--log-file", type=str, default=None, dest="log_file")
    return parser.parse_args()


def is_cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except ImportError:
        return False


class WhisperModel:
    def __init__(self) -> None:
        self._model = None
        self._model_name: str = ""
        self._device: str = ""
        self._compute_type: str = ""
        self._storage_dir: str = ""
        self._beam_size: int = 5
        self._loaded_at: float = 0.0

    def load(
        self,
        model_name: str,
        device: str,
        compute_type: str,
        storage_dir: str,
        beam_size: int,
    ) -> None:
        from faster_whisper import WhisperModel as FasterWhisperModel

        logger.info("Loading model {} on {} ({})...", model_name, device, compute_type)

        resolved_device, resolved_compute = self._resolve_device_compute(device, compute_type)

        self._model = FasterWhisperModel(
            model_name,
            device=resolved_device,
            compute_type=resolved_compute,
            download_root=storage_dir,
        )
        self._model_name = model_name
        self._device = resolved_device
        self._compute_type = resolved_compute
        self._storage_dir = storage_dir
        self._beam_size = beam_size
        self._loaded_at = time.time()
        logger.info("Model loaded: {} on {}", model_name, resolved_device)

    def _resolve_device_compute(self, device: str, compute_type: str) -> tuple[str, str]:
        if device != "auto":
            resolved_device = device
        else:
            resolved_device = "cuda" if is_cuda_available() else "cpu"

        if compute_type != "auto":
            return resolved_device, compute_type

        if resolved_device.startswith("cuda"):
            return resolved_device, "float16"
        return resolved_device, "int8"

    def transcribe(
        self,
        audio_data: np.ndarray,
        language: Optional[str],
        vad_filter: bool,
        initial_prompt: Optional[str] = None,
    ) -> dict:
        if self._model is None:
            raise RuntimeError("Model not loaded")

        lang = language if language and language != "auto" else None

        segments, info = self._model.transcribe(
            audio_data,
            language=lang,
            beam_size=self._beam_size,
            vad_filter=vad_filter,
            initial_prompt=initial_prompt,
        )

        text = " ".join(segment.text for segment in segments).strip()
        text = sanitize_transcription(text, info.language)
        return {
            "text": text,
            "language": info.language,
            "duration_sec": float(info.duration),
        }

    def transcribe_samples_with_words(
        self,
        audio_data: np.ndarray,
        language: Optional[str],
        initial_prompt: Optional[str] = None,
    ):
        """Return (segments_list, info) with word-level timestamps. Used by the streaming transcriber."""
        if self._model is None:
            raise RuntimeError("Model not loaded")

        lang = language if language and language != "auto" else None

        segments, info = self._model.transcribe(
            audio_data,
            language=lang,
            beam_size=self._beam_size,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            word_timestamps=True,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            temperature=0.0,
            initial_prompt=initial_prompt,
        )
        return list(segments), info

    def transcribe_file_stream(self, file_path: str, language: Optional[str], initial_prompt: Optional[str] = None):
        """Return (segments_iterable, info) for a media file. faster-whisper handles ffmpeg internally."""
        if self._model is None:
            raise RuntimeError("Model not loaded")

        lang = language if language and language != "auto" else None

        segments, info = self._model.transcribe(
            file_path,
            language=lang,
            beam_size=self._beam_size,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            initial_prompt=initial_prompt,
        )
        return segments, info

    def reload(self, model_name: str, device: str, compute_type: str, beam_size: int) -> None:
        self.load(model_name, device, compute_type, self._storage_dir, beam_size)

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def info(self) -> dict:
        return {
            "model": self._model_name,
            "device": self._device,
            "compute_type": self._compute_type,
        }


whisper = WhisperModel()
server_args: argparse.Namespace
start_time: float = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    whisper.load(
        server_args.model,
        server_args.device,
        server_args.compute_type,
        server_args.storage_dir,
        server_args.beam_size,
    )
    yield


app = FastAPI(title="Sonara Voice", lifespan=lifespan)


def verify_token(x_extension_token: str = Header(...)) -> None:
    if x_extension_token != server_args.token:
        raise HTTPException(status_code=401, detail="Invalid token")


class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    uptime_sec: float


class TranscribeResponse(BaseModel):
    text: str
    language: str
    duration_sec: float
    processing_time_sec: float


class InfoResponse(BaseModel):
    status: str
    model: str
    device: str
    compute_type: str
    cuda_available: bool
    uptime_sec: float
    pid: int


class ReloadResponse(BaseModel):
    status: str
    model: str


class ShutdownResponse(BaseModel):
    status: str


class TranscribeFileRequest(BaseModel):
    path: str
    language: Optional[str] = None
    initial_prompt: Optional[str] = None


@app.get("/health", response_model=HealthResponse, summary="Server health check", tags=["System"], status_code=200)
async def health(x_extension_token: str = Header(...)) -> HealthResponse:
    verify_token(x_extension_token)
    return HealthResponse(
        status="ready" if whisper.is_loaded else "loading",
        model=whisper.info.get("model", ""),
        device=whisper.info.get("device", ""),
        uptime_sec=round(time.time() - start_time, 1),
    )


@app.post(
    "/transcribe",
    response_model=TranscribeResponse,
    summary="Transcribe audio",
    tags=["Transcription"],
    status_code=200,
)
async def transcribe(
    audio: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
    vad_filter: bool = Form(default=True),
    initial_prompt: Optional[str] = Form(default=None),
    x_extension_token: str = Header(...),
) -> TranscribeResponse:
    verify_token(x_extension_token)

    if not whisper.is_loaded:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    t0 = time.time()

    audio_bytes = await audio.read()
    audio_array = _decode_wav(audio_bytes)

    result = await asyncio.to_thread(whisper.transcribe, audio_array, language, vad_filter, initial_prompt)

    processing_time = round(time.time() - t0, 3)
    logger.info(
        "Transcribed {:.1f}s audio in {:.2f}s | lang={} | text={}...",
        result["duration_sec"],
        processing_time,
        result["language"],
        result["text"][:60],
    )

    return TranscribeResponse(
        text=result["text"],
        language=result["language"],
        duration_sec=result["duration_sec"],
        processing_time_sec=processing_time,
    )


@app.post(
    "/transcribe-file",
    summary="Transcribe media file with timestamps (streaming)",
    tags=["Transcription"],
    status_code=200,
)
async def transcribe_file(
    body: TranscribeFileRequest,
    request: Request,
    x_extension_token: str = Header(...),
) -> StreamingResponse:
    verify_token(x_extension_token)

    if not whisper.is_loaded:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    if not os.path.isfile(body.path):
        raise HTTPException(status_code=400, detail=f"File not found: {body.path}")

    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()
    abort_event = threading.Event()
    progress_interval_sec = 1.0
    disconnect_poll_interval_sec = 0.5

    def worker() -> None:
        try:
            t0 = time.time()
            segments, info = whisper.transcribe_file_stream(body.path, body.language, body.initial_prompt)
            duration = float(info.duration)
            collected_segments: list[dict] = []
            last_wall = time.time()

            loop.call_soon_threadsafe(
                queue.put_nowait,
                {"type": "progress", "current_sec": 0.0, "total_sec": duration},
            )

            cancelled = False
            for seg in segments:
                if abort_event.is_set():
                    cancelled = True
                    break
                cleaned_text = sanitize_transcription(seg.text, info.language)
                if not cleaned_text.strip():
                    continue
                collected_segments.append({
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": cleaned_text,
                })
                now = time.time()
                if now - last_wall >= progress_interval_sec:
                    loop.call_soon_threadsafe(
                        queue.put_nowait,
                        {"type": "progress", "current_sec": float(seg.end), "total_sec": duration},
                    )
                    last_wall = now

            if cancelled:
                # Best-effort close of the underlying generator so faster-whisper releases resources.
                close_fn = getattr(segments, "close", None)
                if callable(close_fn):
                    try:
                        close_fn()
                    except Exception as exc:
                        logger.debug("segments.close() raised: {}", exc)
                logger.info("Transcription cancelled by client: {}", body.path)
                return

            processing_time = round(time.time() - t0, 3)
            logger.info(
                "File transcribed: {} | {:.1f}s audio in {:.2f}s | lang={} | segments={}",
                body.path,
                duration,
                processing_time,
                info.language,
                len(collected_segments),
            )
            loop.call_soon_threadsafe(queue.put_nowait, {
                "type": "result",
                "segments": collected_segments,
                "language": info.language,
                "duration_sec": duration,
                "processing_time_sec": processing_time,
            })
        except Exception as exc:
            if abort_event.is_set():
                logger.info("Transcription cancelled by client (during exception): {}", body.path)
                return
            logger.error("File transcribe failed: {}", exc)
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "error", "message": str(exc)})
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=worker, daemon=True).start()

    async def stream():
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=disconnect_poll_interval_sec)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        abort_event.set()
                        logger.info("Client disconnected, aborting transcription: {}", body.path)
                        return
                    continue
                if msg is None:
                    return
                if await request.is_disconnected():
                    abort_event.set()
                    logger.info("Client disconnected, aborting transcription: {}", body.path)
                    return
                yield json.dumps(msg, ensure_ascii=False) + "\n"
        finally:
            abort_event.set()

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.websocket("/transcribe-stream")
async def transcribe_stream_ws(ws: WebSocket) -> None:
    token = ws.query_params.get("token", "")
    if token != server_args.token:
        await ws.close(code=1008, reason="Invalid token")
        return

    language = ws.query_params.get("language") or None
    initial_prompt = ws.query_params.get("initial_prompt") or None
    process_interval_sec = float(ws.query_params.get("interval", "2.0"))

    await ws.accept()

    if not whisper.is_loaded:
        await ws.send_json({"type": "error", "message": "Model not loaded yet"})
        await ws.close()
        return

    transcriber = StreamingTranscriber(whisper=whisper, language=language, initial_prompt=initial_prompt)
    stop_event = asyncio.Event()
    processing_lock = asyncio.Lock()

    async def emit_partial() -> None:
        async with processing_lock:
            result = await asyncio.to_thread(transcriber.process_iter)
        try:
            await ws.send_json({
                "type": "partial",
                "confirmed": result.confirmed_text,
                "pending": result.pending_text,
                "duration_sec": result.duration_sec,
            })
        except Exception:
            stop_event.set()

    async def periodic_loop() -> None:
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=process_interval_sec)
                return
            except asyncio.TimeoutError:
                pass
            if transcriber.buffered_seconds >= 1.0:
                await emit_partial()

    periodic_task = asyncio.create_task(periodic_loop())
    logger.info("Streaming session started (language={}, interval={}s)", language, process_interval_sec)

    try:
        while True:
            msg = await ws.receive()
            msg_type = msg.get("type")

            if msg_type == "websocket.disconnect":
                break

            if msg.get("bytes") is not None:
                transcriber.insert_audio_chunk(msg["bytes"])
                continue

            text = msg.get("text")
            if not text:
                continue

            try:
                command = json.loads(text)
            except json.JSONDecodeError:
                continue

            action = command.get("action")
            if action == "process":
                await emit_partial()
            elif action == "finalize":
                async with processing_lock:
                    result = await asyncio.to_thread(transcriber.finalize)
                await ws.send_json({
                    "type": "final",
                    "text": result.confirmed_text,
                    "duration_sec": result.duration_sec,
                })
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.error("Streaming session error: {}", exc)
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        stop_event.set()
        periodic_task.cancel()
        try:
            await periodic_task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await ws.close()
        except Exception:
            pass
        logger.info("Streaming session ended")


@app.post("/reload", response_model=ReloadResponse, summary="Reload model with new settings", tags=["System"], status_code=200)
async def reload_model(
    model: str = Form(...),
    device: str = Form(default="auto"),
    compute_type: str = Form(default="auto"),
    beam_size: int = Form(default=5),
    x_extension_token: str = Header(...),
) -> ReloadResponse:
    verify_token(x_extension_token)
    await asyncio.to_thread(whisper.reload, model, device, compute_type, beam_size)
    return ReloadResponse(status="reloaded", model=model)


@app.get("/info", response_model=InfoResponse, summary="Detailed server info", tags=["System"], status_code=200)
async def info(x_extension_token: str = Header(...)) -> InfoResponse:
    verify_token(x_extension_token)
    return InfoResponse(
        status="ready" if whisper.is_loaded else "loading",
        model=whisper.info.get("model", ""),
        device=whisper.info.get("device", ""),
        compute_type=whisper.info.get("compute_type", ""),
        cuda_available=is_cuda_available(),
        uptime_sec=round(time.time() - start_time, 1),
        pid=os.getpid(),
    )


@app.post("/shutdown", response_model=ShutdownResponse, summary="Graceful shutdown", tags=["System"], status_code=200)
async def shutdown(x_extension_token: str = Header(...)) -> ShutdownResponse:
    verify_token(x_extension_token)
    logger.info("Shutdown requested")
    os.kill(os.getpid(), 15)
    return ShutdownResponse(status="shutting_down")


def _decode_wav(data: bytes) -> np.ndarray:
    """Decode 16-bit PCM WAV to float32 numpy array."""
    buf = io.BytesIO(data)

    riff = buf.read(4)
    if riff != b"RIFF":
        raise HTTPException(status_code=400, detail="Expected RIFF WAV file")

    buf.read(4)
    wave = buf.read(4)
    if wave != b"WAVE":
        raise HTTPException(status_code=400, detail="Expected WAVE format")

    while True:
        chunk_id = buf.read(4)
        if len(chunk_id) < 4:
            raise HTTPException(status_code=400, detail="No data chunk in WAV")
        chunk_size = struct.unpack("<I", buf.read(4))[0]
        if chunk_id == b"data":
            raw = buf.read(chunk_size)
            break
        buf.read(chunk_size)

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def main() -> None:
    global server_args
    server_args = parse_args()
    setup_logging(server_args.log_file)

    if server_args.port == 0:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
    else:
        port = server_args.port

    os.makedirs(os.path.dirname(server_args.port_file), exist_ok=True)
    with open(server_args.port_file, "w") as f:
        f.write(str(port))

    logger.info("Starting Sonara Voice server on 127.0.0.1:{}", port)

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
