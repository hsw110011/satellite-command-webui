from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import shutil
import tempfile
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional, Set, Tuple

import uvicorn
from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .localization_manager import LocalizationManager
from .ros_bridge import RosBridge
from .settings import Settings
from .geotiff_provider import GeoTiffProvider


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_json(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): sanitize_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_json(item) for item in value]
    return value


def sse_message(event: str, data: Any) -> str:
    payload = json.dumps(sanitize_json(data), ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


class EventHub:
    def __init__(self) -> None:
        self._clients: Set[asyncio.Queue] = set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._clients.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._clients.discard(queue)

    async def publish(self, event: str, data: Any) -> None:
        item = (event, sanitize_json(data))
        for queue in tuple(self._clients):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(item)
            except asyncio.QueueFull:
                pass

    def publish_from_thread(self, event: str, data: Dict[str, Any]) -> None:
        if self._loop is None or self._loop.is_closed():
            return
        asyncio.run_coroutine_threadsafe(self.publish(event, data), self._loop)


class GatewayState:
    def __init__(self, settings: Settings, hub: EventHub) -> None:
        self.settings = settings
        self.hub = hub
        self.regions = []
        self.publications: Dict[str, Dict[str, Any]] = {}
        self.latest_topic: Dict[str, Any] = {
            "name": settings.globalpose_topic,
            "payload": None,
            "receivedAt": None,
        }
        self.latest_telemetry: Optional[Dict[str, Any]] = None
        self.publish_generation = 0
        self.region_lock = asyncio.Lock()
        self.publish_lock = asyncio.Lock()
        self.ros = RosBridge(settings, self._on_ros_event)
        self.localization = LocalizationManager(settings)

    async def load_regions(self) -> None:
        try:
            raw = await run_blocking(self.settings.region_store.read_text, encoding="utf-8")
            parsed = json.loads(raw)
            if not isinstance(parsed, list):
                self.regions = []
                return
            self.regions = [self.ros.normalize_region(region) for region in parsed]
            if self.regions != parsed:
                await self.save_regions(self.regions)
        except FileNotFoundError:
            self.regions = []
        except Exception:
            self.regions = []

    async def save_regions(self, regions: list) -> None:
        payload = json.dumps(regions, ensure_ascii=False, indent=2)
        await run_blocking(self._atomic_write, self.settings.region_store, payload)

    @staticmethod
    def _atomic_write(target: Path, payload: str) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(target.parent), delete=False) as handle:
            handle.write(payload)
            temporary = Path(handle.name)
        temporary.replace(target)

    def hello(self) -> Dict[str, Any]:
        publications = self.publication_list()
        return {
            "time": now_iso(),
            "regions": self.regions,
            "latestTopic": self.latest_topic,
            "latestTelemetry": self.latest_telemetry,
            "publishing": publications[0] if publications else None,
            "publications": publications,
            "localization": self.localization.status(),
            "system": self.system_status(),
        }

    def publication_list(self) -> list:
        return [
            {key: value for key, value in publication.items() if not key.startswith("_")}
            for publication in self.publications.values()
        ]

    def publication_payload(self) -> Dict[str, Any]:
        publications = self.publication_list()
        return {
            "publishing": publications[0] if publications else None,
            "publications": publications,
        }

    def system_status(self) -> Dict[str, Any]:
        return {
            "time": now_iso(),
            "gateway": {"online": True, "implementation": "fastapi-rospy", "pid": os.getpid()},
            "ros": self.ros.status(),
            "localization": self.localization.status(),
            "settings": self.settings.public_status(),
        }

    def _on_ros_event(self, event: str, data: Dict[str, Any]) -> None:
        if event == "telemetry":
            self.latest_telemetry = data
            self.latest_topic = {
                "name": data.get("topic", self.settings.globalpose_topic),
                "payload": data,
                "receivedAt": data.get("time", now_iso()),
            }
        self.hub.publish_from_thread(event, data)


settings = Settings.from_env()
hub = EventHub()
state = GatewayState(settings, hub)
map_providers = {
    "dom": GeoTiffProvider(),
    "dsm": GeoTiffProvider(),
}
map_upload_dir = settings.map_store_dir
persistent_map_paths = {
    "dom": map_upload_dir / "dom.tif",
    "dsm": map_upload_dir / "dsm.tif",
}
MAX_MAP_UPLOAD_BYTES = max(1, int(os.getenv("SKYFORGE_MAP_MAX_UPLOAD_BYTES", str(4 * 1024**3))))
MIN_MAP_FREE_BYTES = max(0, int(os.getenv("SKYFORGE_MAP_MIN_FREE_BYTES", str(2 * 1024**3))))
MAX_UPLOAD_CONCURRENCY = max(1, min(8, int(os.getenv("SKYFORGE_MAP_UPLOAD_CONCURRENCY", "2"))))
SIMULATION_RATE_HZ = max(0.2, min(20.0, float(os.getenv("SKYFORGE_SIMULATION_RATE_HZ", "5"))))
SIMULATION_PERIOD_SECONDS = max(5.0, float(os.getenv("SKYFORGE_SIMULATION_PERIOD_SECONDS", "24")))
SIMULATION_RADIUS_RATIO = max(0.05, min(0.45, float(os.getenv("SKYFORGE_SIMULATION_RADIUS_RATIO", "0.32"))))
DEFAULT_REGION_PUBLISH_RATE_HZ = 50.0
MAX_REGION_PUBLISH_RATE_HZ = 50.0
map_upload_locks = {"dom": asyncio.Lock(), "dsm": asyncio.Lock()}
map_upload_semaphore = asyncio.Semaphore(MAX_UPLOAD_CONCURRENCY)
background_tasks = []


def simulation_map_extent() -> Tuple[Dict[str, float], str]:
    for source in ("dom", "dsm"):
        metadata = map_providers[source].metadata()
        bounds = metadata.get("bounds") if metadata.get("loaded") else None
        if not isinstance(bounds, dict):
            continue
        try:
            extent = {key: float(bounds[key]) for key in ("north", "south", "west", "east")}
        except (KeyError, TypeError, ValueError):
            continue
        if extent["north"] > extent["south"] and extent["east"] > extent["west"]:
            return extent, source
    return {
        "north": 39.9075,
        "south": 39.9009,
        "west": 116.4031,
        "east": 116.4117,
    }, "fallback"


def simulation_circle_sample(bounds: Dict[str, float], angle: float, radius_scale: float = 1.0) -> Dict[str, float]:
    center_lat = (bounds["north"] + bounds["south"]) / 2.0
    center_lon = (bounds["west"] + bounds["east"]) / 2.0
    latitude_span_m = (bounds["north"] - bounds["south"]) * 111_320.0
    longitude_scale = max(0.01, math.cos(math.radians(center_lat)))
    longitude_span_m = (bounds["east"] - bounds["west"]) * 111_320.0 * longitude_scale
    radius_m = max(
        1.0,
        min(latitude_span_m, longitude_span_m)
        * SIMULATION_RADIUS_RATIO
        * max(0.35, min(1.0, radius_scale)),
    )
    latitude_radius = radius_m / 111_320.0
    longitude_radius = radius_m / (111_320.0 * longitude_scale)
    angular_speed = 2.0 * math.pi / SIMULATION_PERIOD_SECONDS
    north_speed = radius_m * angular_speed * math.cos(angle)
    east_speed = -radius_m * angular_speed * math.sin(angle)
    return {
        "lat": center_lat + latitude_radius * math.sin(angle),
        "lon": center_lon + longitude_radius * math.cos(angle),
        "heading": (math.degrees(math.atan2(east_speed, north_speed)) + 360.0) % 360.0,
        "speed": math.hypot(north_speed, east_speed),
        "radiusMeters": radius_m,
    }


async def run_blocking(function: Any, *args: Any, **kwargs: Any) -> Any:
    loop = asyncio.get_running_loop()
    if kwargs:
        return await loop.run_in_executor(None, lambda: function(*args, **kwargs))
    return await loop.run_in_executor(None, function, *args)


async def system_status_loop() -> None:
    while True:
        await run_blocking(state.ros.master_online)
        if not state.ros.started:
            await run_blocking(state.ros.ensure_started)
        await hub.publish("system-status", state.system_status())
        await hub.publish("localization-state", state.localization.status())
        await asyncio.sleep(2.0)


async def simulation_telemetry_loop() -> None:
    angle = 0.0
    interval = 1.0 / SIMULATION_RATE_HZ
    angular_step = 2.0 * math.pi * interval / SIMULATION_PERIOD_SECONDS
    while True:
        if settings.simulation:
            bounds, map_source = simulation_map_extent()
            topics = settings.globalpose_topics or (settings.globalpose_topic,)
            for index, topic in enumerate(topics):
                phase = angle + index * (2.0 * math.pi / max(1, len(topics)))
                sample = simulation_circle_sample(bounds, phase, 1.0 - index * 0.12)
                telemetry = {
                    "time": now_iso(),
                    "lat": sample["lat"],
                    "lon": sample["lon"],
                    "altitude": 42.6 + 3.0 * math.sin(phase),
                    "heading": round(sample["heading"], 1),
                    "speed": round(sample["speed"], 2),
                    "source": f"tiff-circle-simulation:{map_source}:{index + 1}",
                    "topic": topic,
                    "positionUpdate": True,
                }
                state.latest_telemetry = telemetry
                state.latest_topic = {
                    "name": topic,
                    "payload": telemetry,
                    "receivedAt": telemetry["time"],
                }
                await hub.publish("telemetry", telemetry)
            angle = (angle + angular_step) % (2.0 * math.pi)
        await asyncio.sleep(interval if settings.simulation else 1.0)


async def region_publish_loop() -> None:
    while True:
        now = asyncio.get_running_loop().time()
        async with state.publish_lock:
            due_publications = []
            next_due_delay = 0.05
            for publication in state.publications.values():
                if not publication.get("active"):
                    continue
                next_publish_at = float(publication.get("_nextPublishAt", 0.0))
                if next_publish_at > now:
                    next_due_delay = min(next_due_delay, next_publish_at - now)
                    continue
                interval = 1.0 / max(
                    0.1,
                    min(float(publication.get("rateHz", DEFAULT_REGION_PUBLISH_RATE_HZ)), MAX_REGION_PUBLISH_RATE_HZ),
                )
                publication["_nextPublishAt"] = now + interval
                due_publications.append(dict(publication))
        if not due_publications:
            await asyncio.sleep(max(0.001, next_due_delay))
            continue
        await asyncio.gather(
            *(_publish_region_once(publication) for publication in due_publications),
            return_exceptions=True,
        )


async def _publish_region_once(publication: Dict[str, Any]) -> None:
    publication_id = publication["id"]
    generation = int(publication["generation"])
    try:
        result = await run_blocking(
            state.ros.publish_region,
            publication["topic"],
            publication["flag"],
            publication["region"],
        )
        connected = bool(result.get("simulated") or result.get("connections", 0) > 0)
        delivery_state = "RUNNING" if connected else "WAITING_SUBSCRIBER"
        async with state.publish_lock:
            current = state.publications.get(publication_id)
            if not current or current.get("generation") != generation:
                return
            state_changed = current.get("deliveryState") != delivery_state
            current["deliveryState"] = delivery_state
            current["lastAttemptAt"] = now_iso()
            if connected:
                current["lastPublishedAt"] = current["lastAttemptAt"]
            current["lastError"] = None
            publish_state = {key: value for key, value in current.items() if not key.startswith("_")}
            publish_payload = state.publication_payload()
        if state_changed:
            await hub.publish("publish-state", publish_payload)
        if connected:
            await hub.publish(
                "publish",
                {
                    "time": publish_state["lastPublishedAt"],
                    "publicationId": publication_id,
                    "topic": publication["topic"],
                    "flag": publication["flag"],
                    "region": publication["region"],
                    "data": {"flag": publication["flag"], "region": publication["region"]},
                    "transport": result,
                },
            )
    except Exception as exc:
        async with state.publish_lock:
            current = state.publications.get(publication_id)
            if not current or current.get("generation") != generation:
                return
            current["active"] = False
            current["deliveryState"] = "ERROR"
            current["lastError"] = str(exc)
            publish_payload = state.publication_payload()
        await hub.publish("publish-state", publish_payload)


def cleanup_stale_uploads() -> None:
    """Remove incomplete uploads while preserving validated map files."""
    map_upload_dir.mkdir(parents=True, exist_ok=True)
    for path in map_upload_dir.glob(".*-upload-*"):
        try:
            path.unlink()
        except OSError:
            pass


def restore_persisted_maps() -> None:
    map_upload_dir.mkdir(parents=True, exist_ok=True)
    for source, path in persistent_map_paths.items():
        if not path.is_file():
            continue
        provider = GeoTiffProvider()
        try:
            provider.load(str(path), source)
        except Exception as exc:
            provider.close()
            print(f"Failed to restore {source.upper()} GeoTIFF: {exc}")
            continue
        previous = map_providers[source]
        map_providers[source] = provider
        previous.close()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    hub.bind_loop(asyncio.get_running_loop())
    await run_blocking(cleanup_stale_uploads)
    await run_blocking(restore_persisted_maps)
    await state.load_regions()
    await run_blocking(state.ros.ensure_started)
    background_tasks.extend(
        [
            asyncio.create_task(system_status_loop()),
            asyncio.create_task(simulation_telemetry_loop()),
            asyncio.create_task(region_publish_loop()),
        ]
    )
    try:
        yield
    finally:
        for task in background_tasks:
            task.cancel()
        await asyncio.gather(*background_tasks, return_exceptions=True)
        await run_blocking(state.localization.close)
        await run_blocking(state.ros.shutdown)
        await asyncio.gather(
            *(run_blocking(provider.close) for provider in map_providers.values()),
            return_exceptions=True,
        )
        # Clean stale temp files from atomic writes
        try:
            data_dir = settings.region_store.parent
            if data_dir.exists():
                for tmp in data_dir.glob("tmp*"):
                    try:
                        tmp.unlink()
                    except Exception:
                        pass
        except Exception:
            pass


app = FastAPI(title="SkyForge ROS1 Gateway", version="0.3.0", lifespan=lifespan)


# Request body size limit (1MB)
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response as StarletteResponse


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    MAX_BODY = 1_048_576  # 1 MB

    async def dispatch(self, request: Request, call_next):
        # GeoTIFF uploads are streamed and size-checked by their endpoint.
        if request.url.path.startswith("/api/map/") and request.url.path.endswith("/upload"):
            return await call_next(request)
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > self.MAX_BODY:
            return StarletteResponse(
                content='{"ok":false,"error":"Request body too large (max 1MB)"}',
                status_code=413,
                media_type="application/json",
            )
        return await call_next(request)


app.add_middleware(RequestSizeLimitMiddleware)


class StaticAssetCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path.lower()
        if path == "/" or path.endswith((".html", ".js", ".css")):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response


app.add_middleware(StaticAssetCacheMiddleware)


@app.get("/api/system/status")
async def get_system_status() -> Dict[str, Any]:
    return state.system_status()


@app.get("/events")
async def events(request: Request) -> StreamingResponse:
    queue = hub.subscribe()

    async def stream() -> AsyncIterator[str]:
        try:
            yield sse_message("hello", state.hello())
            yield sse_message("system-status", state.system_status())
            while True:
                if await request.is_disconnected():
                    return
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield sse_message(event, data)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            hub.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.get("/api/regions")
async def get_regions() -> Dict[str, Any]:
    return {"regions": state.regions}


@app.post("/api/regions")
async def save_region(region: Dict[str, Any] = Body(...)) -> Any:
    try:
        region = state.ros.normalize_region(region)
    except (TypeError, ValueError) as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
    if not region.get("id"):
        return JSONResponse(status_code=400, content={"ok": False, "error": "Region id is required"})
    try:
        await run_blocking(state.ros.validate_region, region)
    except (TypeError, ValueError) as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
    async with state.region_lock:
        candidate = list(state.regions)
        index = next((i for i, item in enumerate(candidate) if item.get("id") == region["id"]), -1)
        if index >= 0:
            candidate[index] = region
        else:
            candidate.append(region)
        try:
            await state.save_regions(candidate)
        except Exception as exc:
            return JSONResponse(status_code=500, content={"ok": False, "error": f"Region persistence failed: {exc}"})
        state.regions = candidate
    await hub.publish("regions", {"regions": state.regions})
    return {"ok": True, "regions": state.regions}


@app.delete("/api/regions/{region_id}")
async def delete_region(region_id: str) -> Any:
    async with state.region_lock:
        region = next((item for item in state.regions if item.get("id") == region_id), None)
        if region is None:
            return JSONResponse(status_code=404, content={"ok": False, "error": "Region not found"})
        candidate = [item for item in state.regions if item.get("id") != region_id]
        try:
            await state.save_regions(candidate)
        except Exception as exc:
            return JSONResponse(status_code=500, content={"ok": False, "error": f"Region persistence failed: {exc}"})
        state.regions = candidate
    async with state.publish_lock:
        stopped_ids = [
            publication_id
            for publication_id, publication in state.publications.items()
            if publication.get("region", {}).get("id") == region_id
        ]
        for publication_id in stopped_ids:
            state.publications.pop(publication_id, None)
        publish_payload = state.publication_payload()
    if stopped_ids:
        await hub.publish("publish-state", publish_payload)
    await hub.publish("regions", {"regions": state.regions})
    return {"ok": True, "deleted": region, "regions": state.regions}


@app.post("/api/publish/start")
async def start_publishing(body: Dict[str, Any] = Body(...)) -> Any:
    region = body.get("region")
    flag = body.get("flag", "GPS_FLAG")
    if not isinstance(region, dict):
        return JSONResponse(status_code=400, content={"ok": False, "error": "Region is required"})
    try:
        region = state.ros.normalize_region(region)
        topic = state.ros.normalize_topic(body.get("topic", settings.default_region_topic))
        rate_hz = max(
            0.1,
            min(float(body.get("rateHz", DEFAULT_REGION_PUBLISH_RATE_HZ)), MAX_REGION_PUBLISH_RATE_HZ),
        )
        if flag not in {"GPS_FLAG", "DR_FLAG", "MATCH_FLAG"}:
            raise ValueError(f"Unsupported flag: {flag}")
        await run_blocking(state.ros.validate_region, region)
    except (TypeError, ValueError) as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
    if not await run_blocking(state.ros.ensure_started):
        ros_status = state.ros.status()
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": ros_status.get("lastError") or "ROS Gateway is not ready", "ros": ros_status},
        )
    async with state.publish_lock:
        state.publish_generation += 1
        generation = state.publish_generation
        publication_key = f"{region['id']}\0{topic}\0{flag}".encode("utf-8")
        publication_id = hashlib.sha256(publication_key).hexdigest()[:16]
        state.publications[publication_id] = {
            "id": publication_id,
            "active": True,
            "deliveryState": "PENDING",
            "generation": generation,
            "flag": flag,
            "topic": topic,
            "region": region,
            "rateHz": rate_hz,
            "startedAt": now_iso(),
            "lastAttemptAt": None,
            "lastPublishedAt": None,
            "lastError": None,
            "_nextPublishAt": 0.0,
        }
        publish_payload = state.publication_payload()
    await hub.publish("publish-state", publish_payload)
    return {"ok": True, **publish_payload}


@app.post("/api/publish/stop")
async def stop_publishing(body: Optional[Dict[str, Any]] = Body(default=None)) -> Dict[str, Any]:
    publication_id = str((body or {}).get("publicationId", "")).strip()
    async with state.publish_lock:
        if publication_id:
            stopped = state.publications.pop(publication_id, None)
        else:
            stopped = list(state.publications.values())
            state.publications.clear()
        publish_payload = state.publication_payload()
    await hub.publish("publish-state", publish_payload)
    return {"ok": True, "stopped": stopped, **publish_payload}


@app.post("/api/localization/start")
async def start_localization() -> Any:
    try:
        localization = await run_blocking(state.localization.start)
    except RuntimeError as exc:
        localization = state.localization.status()
        await hub.publish("localization-state", localization)
        return JSONResponse(status_code=503, content={"ok": False, "error": str(exc), "localization": localization})
    await hub.publish("localization-state", localization)
    await hub.publish("system-status", state.system_status())
    return {"ok": True, "localization": localization}


@app.post("/api/localization/stop")
async def stop_localization() -> Dict[str, Any]:
    localization = await run_blocking(state.localization.stop)
    await hub.publish("localization-state", localization)
    await hub.publish("system-status", state.system_status())
    return {"ok": True, "localization": localization}


@app.post("/api/agent/run")
async def run_agent(body: Dict[str, Any] = Body(...)) -> Any:
    endpoint = str(body.get("graphEndpoint") or "").strip()
    request_payload = {
        "prompt": body.get("prompt", ""),
        "mode": body.get("mode", "agent"),
        "region": body.get("region"),
        "context": body.get("context", {}),
    }
    if not endpoint:
        result = {
            "provider": "mock-langgraph",
            "answer": "未配置 LangGraph endpoint，ROS1 Gateway 已接收区域、定位和发布上下文。",
            "request": request_payload,
            "confidence": 0.82,
        }
    else:
        parsed = urllib.parse.urlparse(endpoint)
        if not settings.allow_remote_agent and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            return JSONResponse(
                status_code=403,
                content={"ok": False, "error": "默认只允许本机 Agent endpoint"},
            )
        try:
            result = await run_blocking(_post_agent, endpoint, request_payload)
        except Exception as exc:
            return JSONResponse(status_code=502, content={"ok": False, "error": str(exc)})
    event = {"time": now_iso(), "prompt": request_payload["prompt"], "result": result}
    await hub.publish("agent", event)
    return {"ok": True, "result": result}


def _post_agent(endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode("utf-8")
        try:
            answer: Any = json.loads(raw)
        except json.JSONDecodeError:
            answer = raw
        return {"provider": "langgraph", "status": response.status, "answer": answer}


@app.post("/api/topic/{topic_name:path}")
async def ingest_topic(topic_name: str, payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    name = f"/{topic_name.lstrip('/')}"
    state.latest_topic = {"name": name, "payload": payload, "receivedAt": now_iso()}
    await hub.publish("topic", state.latest_topic)
    latitude = payload.get("latitude", payload.get("lat"))
    longitude = payload.get("longitude", payload.get("lon"))
    if latitude is not None and longitude is not None:
        telemetry = {
            "time": now_iso(),
            "topic": name,
            "source": "http-ingest",
            **payload,
            "lat": latitude,
            "lon": longitude,
            "positionUpdate": payload.get(
                "positionUpdate",
                name in {*settings.globalpose_topics, settings.fix_topic},
            ),
        }
        state.latest_telemetry = telemetry
        await hub.publish("telemetry", telemetry)
    return {"ok": True, "latestTopic": state.latest_topic}


def _map_provider(source: str) -> GeoTiffProvider:
    normalized = source.lower().strip()
    if normalized not in map_providers:
        raise ValueError(f"未知地图源: {source}，仅支持 dom 或 dsm")
    return map_providers[normalized]


@app.post("/api/map/{source}/upload")
async def upload_geotiff(source: str, request: Request, filename: str = "map.tif") -> Any:
    """Stream a browser-selected TIFF and atomically replace one map source."""
    normalized = source.lower().strip()
    try:
        _map_provider(normalized)
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"ok": False, "error": str(exc)})

    safe_name = Path(urllib.parse.unquote(filename)).name
    suffix = Path(safe_name).suffix.lower()
    if suffix not in {".tif", ".tiff", ".geotiff"}:
        return JSONResponse(status_code=400, content={"ok": False, "error": "仅支持 .tif、.tiff 或 .geotiff 文件"})
    content_length: Optional[int] = None
    try:
        if request.headers.get("content-length"):
            content_length = int(request.headers["content-length"])
    except ValueError:
        pass
    limit_label = f"{MAX_MAP_UPLOAD_BYTES / 1024**3:.1f} GiB"
    if content_length is not None and content_length > MAX_MAP_UPLOAD_BYTES:
        return JSONResponse(status_code=413, content={"ok": False, "error": f"GeoTIFF 超过 {limit_label} 上传限制"})

    temporary_path: Optional[Path] = None
    total_bytes = 0
    try:
        async with map_upload_semaphore:
            async with map_upload_locks[normalized]:
                await run_blocking(map_upload_dir.mkdir, parents=True, exist_ok=True)
                free_bytes = (await run_blocking(shutil.disk_usage, map_upload_dir)).free
                required = (content_length or 0) + MIN_MAP_FREE_BYTES
                if free_bytes < required:
                    return JSONResponse(status_code=507, content={"ok": False, "error": "上传磁盘剩余空间不足"})

                with tempfile.NamedTemporaryFile(
                    mode="wb", prefix=f".{normalized}-upload-", suffix=suffix,
                    dir=str(map_upload_dir), delete=False,
                ) as handle:
                    temporary_path = Path(handle.name)
                    next_space_check = 64 * 1024**2
                    async for chunk in request.stream():
                        if not chunk:
                            continue
                        total_bytes += len(chunk)
                        if total_bytes > MAX_MAP_UPLOAD_BYTES:
                            raise ValueError(f"GeoTIFF 超过 {limit_label} 上传限制")
                        handle.write(chunk)
                        if total_bytes >= next_space_check:
                            free_bytes = (await run_blocking(shutil.disk_usage, map_upload_dir)).free
                            if free_bytes < MIN_MAP_FREE_BYTES:
                                raise OSError("上传磁盘剩余空间低于安全阈值")
                            next_space_check = total_bytes + 64 * 1024**2
                    handle.flush()
                    await run_blocking(os.fsync, handle.fileno())

                if total_bytes == 0:
                    raise ValueError("上传文件为空")

                candidate = GeoTiffProvider()
                try:
                    await run_blocking(candidate.load, str(temporary_path), normalized)
                except Exception:
                    candidate.close()
                    raise
                await run_blocking(candidate.close)

                persistent_path = persistent_map_paths[normalized]
                await run_blocking(os.replace, temporary_path, persistent_path)
                temporary_path = None
                candidate = GeoTiffProvider()
                try:
                    metadata = await run_blocking(candidate.load, str(persistent_path), normalized)
                except Exception:
                    candidate.close()
                    raise
                previous_provider = map_providers[normalized]
                map_providers[normalized] = candidate
                await run_blocking(previous_provider.close)

                return {
                    "ok": True, "source": normalized, "filename": safe_name,
                    "size": total_bytes, "map": metadata,
                }
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
    except OSError as exc:
        return JSONResponse(status_code=507, content={"ok": False, "error": str(exc)})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"ok": False, "error": f"上传失败: {exc}"})
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


@app.get("/api/map/{source}/metadata")
async def get_map_metadata(source: str) -> Any:
    try:
        return _map_provider(source).metadata()
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"ok": False, "error": str(exc)})


@app.get("/api/map/{source}/tile/{level}/{col}/{row}.png")
async def get_map_tile(source: str, level: int, col: int, row: int) -> Any:
    try:
        provider = _map_provider(source)
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"ok": False, "error": str(exc)})
    tile_bytes = await run_blocking(provider.get_tile, level, col, row)
    if tile_bytes is None:
        return JSONResponse(status_code=404, content={"ok": False, "error": "Tile not found"})
    from starlette.responses import Response as RawResponse
    return RawResponse(
        content=tile_bytes, media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.post("/api/map/{source}/coordinates")
async def transform_map_coordinates(source: str, body: Dict[str, Any] = Body(...)) -> Any:
    points = body.get("points")
    if not isinstance(points, list) or not points or len(points) > 1000:
        return JSONResponse(status_code=400, content={"ok": False, "error": "points 数量必须为 1 到 1000"})
    try:
        provider = _map_provider(source)
        fingerprint = provider.metadata().get("fingerprint")
        result = await run_blocking(provider.transform_points, str(body.get("direction", "")), points)
        return {"ok": True, "fingerprint": fingerprint, "points": result}
    except (KeyError, TypeError, ValueError) as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})


@app.get("/api/map/dsm/elevation")
async def query_elevation(lat: Optional[float] = None, lon: Optional[float] = None,
                          x: Optional[float] = None, y: Optional[float] = None) -> Any:
    provider = map_providers["dsm"]
    if not provider.loaded:
        return JSONResponse(status_code=400, content={"ok": False, "error": "未加载 DSM"})
    try:
        result = await run_blocking(provider.query_elevation, lat, lon, x, y)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
    if result is None:
        return JSONResponse(status_code=400, content={"ok": False, "error": "当前地图不是 DSM"})
    return {"ok": True, **result}


@app.get("/api/map/{source}/full.png")
async def get_full_image(source: str, max_dim: int = 0) -> Any:
    """Return the entire GeoTIFF rendered as a single PNG image.

    Optional query param max_dim caps width/height while keeping aspect ratio.
    Pass max_dim=0 (default) for native resolution.
    """
    try:
        provider = _map_provider(source)
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"ok": False, "error": str(exc)})
    if not provider.loaded:
        return JSONResponse(status_code=400, content={"ok": False, "error": f"未加载 {source.upper()} GeoTIFF"})
    image_bytes = await run_blocking(provider.get_full_image, max_dim)
    if image_bytes is None:
        return JSONResponse(status_code=500, content={"ok": False, "error": "渲染失败"})
    from starlette.responses import Response as RawResponse
    return RawResponse(
        content=image_bytes,
        media_type="image/png",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/api/maps/status")
async def get_maps_status() -> Dict[str, Any]:
    return {source: provider.metadata() for source, provider in map_providers.items()}


app.mount("/", StaticFiles(directory=str(settings.public_dir), html=True), name="public")


if __name__ == "__main__":
    uvicorn.run("ros_backend.app:app", host=settings.host, port=settings.port, workers=1, reload=False)
