from __future__ import annotations

import asyncio
import json
import math
import os
import random
import tempfile
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional, Set

import uvicorn
from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .localization_manager import LocalizationManager
from .ros_bridge import RosBridge
from .settings import Settings


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
        self.publishing: Optional[Dict[str, Any]] = None
        self.latest_topic: Dict[str, Any] = {
            "name": settings.fix_topic,
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
            self.regions = parsed if isinstance(parsed, list) else []
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
        return {
            "time": now_iso(),
            "regions": self.regions,
            "latestTopic": self.latest_topic,
            "latestTelemetry": self.latest_telemetry,
            "publishing": self.publishing,
            "localization": self.localization.status(),
            "system": self.system_status(),
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
                "name": data.get("topic", self.settings.fix_topic),
                "payload": data,
                "receivedAt": data.get("time", now_iso()),
            }
        self.hub.publish_from_thread(event, data)


settings = Settings.from_env()
hub = EventHub()
state = GatewayState(settings, hub)
background_tasks = []


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
    lat = 39.904214
    lon = 116.407413
    while True:
        if settings.simulation:
            lat += (random.random() - 0.5) * 0.00025
            lon += (random.random() - 0.5) * 0.00025
            telemetry = {
                "time": now_iso(),
                "lat": lat,
                "lon": lon,
                "altitude": 42.6 + (random.random() - 0.5) * 1.8,
                "heading": (86 + random.random() * 8) % 360,
                "speed": 3.2 + (random.random() - 0.5) * 0.4,
                "source": "ros1-simulation",
                "topic": settings.fix_topic,
            }
            state.latest_telemetry = telemetry
            state.latest_topic = {
                "name": settings.fix_topic,
                "payload": telemetry,
                "receivedAt": telemetry["time"],
            }
            await hub.publish("telemetry", telemetry)
        await asyncio.sleep(1.0)


async def region_publish_loop() -> None:
    while True:
        async with state.publish_lock:
            publishing = dict(state.publishing) if state.publishing else None
        if not publishing or not publishing.get("active"):
            await asyncio.sleep(0.2)
            continue

        generation = int(publishing["generation"])
        interval = 1.0 / max(0.1, min(float(publishing.get("rateHz", 1)), 20.0))
        try:
            result = await run_blocking(
                state.ros.publish_region,
                publishing["topic"],
                publishing["flag"],
                publishing["region"],
            )
            connected = bool(result.get("simulated") or result.get("connections", 0) > 0)
            delivery_state = "RUNNING" if connected else "WAITING_SUBSCRIBER"
            async with state.publish_lock:
                if not state.publishing or state.publishing.get("generation") != generation:
                    continue
                state_changed = state.publishing.get("deliveryState") != delivery_state
                state.publishing["deliveryState"] = delivery_state
                state.publishing["lastAttemptAt"] = now_iso()
                if connected:
                    state.publishing["lastPublishedAt"] = state.publishing["lastAttemptAt"]
                state.publishing["lastError"] = None
                publish_state = dict(state.publishing)
            if state_changed:
                await hub.publish("publish-state", publish_state)
            if connected:
                await hub.publish(
                    "publish",
                    {
                        "time": publish_state["lastPublishedAt"],
                        "topic": publishing["topic"],
                        "flag": publishing["flag"],
                        "region": publishing["region"],
                        "data": {"flag": publishing["flag"], "region": publishing["region"]},
                        "transport": result,
                    },
                )
        except Exception as exc:
            async with state.publish_lock:
                if not state.publishing or state.publishing.get("generation") != generation:
                    continue
                state.publishing["active"] = False
                state.publishing["deliveryState"] = "ERROR"
                state.publishing["lastError"] = str(exc)
                publish_state = dict(state.publishing)
            await hub.publish("publish-state", publish_state)
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    hub.bind_loop(asyncio.get_running_loop())
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


app = FastAPI(title="SkyForge ROS1 Gateway", version="0.2.0", lifespan=lifespan)


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
        if state.publishing and state.publishing.get("region", {}).get("id") == region_id:
            state.publish_generation += 1
            state.publishing = None
            await hub.publish("publish-state", None)
    await hub.publish("regions", {"regions": state.regions})
    return {"ok": True, "deleted": region, "regions": state.regions}


@app.post("/api/publish/start")
async def start_publishing(body: Dict[str, Any] = Body(...)) -> Any:
    region = body.get("region")
    flag = body.get("flag", "GPS_FLAG")
    if not isinstance(region, dict):
        return JSONResponse(status_code=400, content={"ok": False, "error": "Region is required"})
    try:
        topic = state.ros.normalize_topic(body.get("topic", settings.default_region_topic))
        rate_hz = max(0.1, min(float(body.get("rateHz", 1)), 20.0))
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
        state.publishing = {
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
        }
    await hub.publish("publish-state", state.publishing)
    return {"ok": True, "publishing": state.publishing}


@app.post("/api/publish/stop")
async def stop_publishing() -> Dict[str, Any]:
    async with state.publish_lock:
        state.publish_generation += 1
        state.publishing = None
    await hub.publish("publish-state", None)
    return {"ok": True, "publishing": None}


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
    if "lat" in payload and "lon" in payload:
        telemetry = {"time": now_iso(), "topic": name, "source": "http-ingest", **payload}
        state.latest_telemetry = telemetry
        await hub.publish("telemetry", telemetry)
    return {"ok": True, "latestTopic": state.latest_topic}


app.mount("/", StaticFiles(directory=str(settings.public_dir), html=True), name="public")


if __name__ == "__main__":
    uvicorn.run("ros_backend.app:app", host=settings.host, port=settings.port, workers=1, reload=False)
