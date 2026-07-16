from __future__ import annotations

import json
import math
import re
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

from .settings import Settings

try:
    import rosgraph  # type: ignore
    import rospy  # type: ignore
    from geometry_msgs.msg import Point32  # type: ignore
    from nav_msgs.msg import Odometry  # type: ignore
    from sensor_msgs.msg import NavSatFix  # type: ignore
    from std_msgs.msg import String  # type: ignore

    ROS_AVAILABLE = True
    ROS_IMPORT_ERROR: Optional[str] = None
except Exception as exc:  # pragma: no cover - depends on ROS installation
    rosgraph = None  # type: ignore
    rospy = None  # type: ignore
    Point32 = None  # type: ignore
    Odometry = None  # type: ignore
    NavSatFix = None  # type: ignore
    String = None  # type: ignore
    ROS_AVAILABLE = False
    ROS_IMPORT_ERROR = str(exc)

FLAG_VALUES = {"GPS_FLAG": 0, "DR_FLAG": 1, "MATCH_FLAG": 2}
ROS_NAME_PATTERN = re.compile(r"^/[A-Za-z][A-Za-z0-9_/]*$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RosBridge:
    """Single-process rospy adapter used by the FastAPI gateway."""

    def __init__(self, settings: Settings, emit: Callable[[str, Dict[str, Any]], None]) -> None:
        self.settings = settings
        self.emit = emit
        self._lock = threading.RLock()
        self._started = False
        self._master_online = False
        self._start_error: Optional[str] = None
        self._publishers: Dict[str, Any] = {}
        self._subscribers = []
        self._message_class: Any = None
        self._message_type = "unavailable"
        self._latest: Dict[str, Any] = {
            "lat": None,
            "lon": None,
            "altitude": None,
            "heading": 0.0,
            "speed": 0.0,
        }

    @property
    def started(self) -> bool:
        with self._lock:
            return self._started

    def master_online(self) -> bool:
        if self.settings.simulation:
            with self._lock:
                self._master_online = False
            return False
        if not ROS_AVAILABLE:
            with self._lock:
                self._master_online = False
            return False
        try:
            online = bool(rosgraph.is_master_online())
        except Exception:
            online = False
        with self._lock:
            self._master_online = online
        return online

    def ensure_started(self) -> bool:
        # Hold the lock across the whole initialization transaction so status and
        # publication retries cannot create duplicate rospy subscribers.
        with self._lock:
            if self._started:
                return True
            if self.settings.simulation:
                self._started = True
                self._message_type = "simulation/json"
                self._start_error = None
                return True
            if not ROS_AVAILABLE:
                self._start_error = f"ROS1 Python 模块不可用: {ROS_IMPORT_ERROR}"
                return False
            if not self.master_online():
                self._start_error = "ROS Master 未连接"
                return False

            subscribers = []
            try:
                if not rospy.core.is_initialized():
                    rospy.init_node(self.settings.node_name, anonymous=False, disable_signals=True)
                try:
                    from skyforge_msgs.msg import RegionCommand  # type: ignore

                    self._message_class = RegionCommand
                    self._message_type = "skyforge_msgs/RegionCommand"
                except Exception as exc:
                    if not self.settings.allow_string_fallback:
                        raise RuntimeError(
                            "无法导入 skyforge_msgs/RegionCommand。请先 catkin_make 并 source ros1_ws/devel/setup.bash。"
                        ) from exc
                    self._message_class = String
                    self._message_type = "std_msgs/String (explicit fallback)"

                subscribers = [
                    rospy.Subscriber(self.settings.fix_topic, NavSatFix, self._on_fix, queue_size=20),
                    rospy.Subscriber(self.settings.odom_topic, Odometry, self._on_odom, queue_size=50),
                ]
                self._subscribers = subscribers
                self._started = True
                self._start_error = None
                return True
            except Exception as exc:
                for subscriber in subscribers:
                    try:
                        subscriber.unregister()
                    except Exception:
                        pass
                self._subscribers = []
                self._started = False
                self._start_error = str(exc)
                return False

    def normalize_topic(self, topic: str) -> str:
        normalized = (topic or self.settings.default_region_topic).strip()
        if not normalized.startswith("/"):
            normalized = f"/{normalized}"
        normalized = re.sub(r"/{2,}", "/", normalized)
        if not ROS_NAME_PATTERN.fullmatch(normalized) or normalized.endswith("/"):
            raise ValueError(f"无效的 ROS1 话题名称: {topic}")
        return normalized

    def validate_region(self, region: Dict[str, Any]) -> list:
        if not isinstance(region, dict):
            raise ValueError("Region must be an object")
        if not str(region.get("id", "")).strip():
            raise ValueError("Region id is required")
        shape = str(region.get("shape", "rectangle"))
        if shape not in {"rectangle", "polygon"}:
            raise ValueError(f"Unsupported region shape: {shape}")
        coordinates = self._region_coordinates(region)
        if len(coordinates) < 3:
            raise ValueError("Region must contain at least 3 geographic points")
        for latitude, longitude in coordinates:
            if not math.isfinite(latitude) or not math.isfinite(longitude):
                raise ValueError("Region coordinates must be finite")
            if not -90.0 <= latitude <= 90.0:
                raise ValueError(f"Latitude out of range: {latitude}")
            if not -180.0 <= longitude <= 180.0:
                raise ValueError(f"Longitude out of range: {longitude}")
        return coordinates

    def publish_region(self, topic: str, flag: str, region: Dict[str, Any]) -> Dict[str, Any]:
        topic = self.normalize_topic(topic)
        if flag not in FLAG_VALUES:
            raise ValueError(f"不支持的标识位: {flag}")
        coordinates = self.validate_region(region)
        if not self.ensure_started():
            raise RuntimeError(self._start_error or "ROS Gateway 尚未就绪")
        if self.settings.simulation:
            return {
                "topic": topic,
                "messageType": self._message_type,
                "simulated": True,
                "pointCount": len(coordinates),
                "connections": 1,
            }

        with self._lock:
            publisher = self._publishers.get(topic)
            if publisher is None:
                publisher = rospy.Publisher(topic, self._message_class, queue_size=10, latch=False)
                self._publishers[topic] = publisher

        if self._message_type == "skyforge_msgs/RegionCommand":
            message = self._build_region_command(flag, region, coordinates)
        else:
            message = String(
                data=json.dumps(
                    {"flag": flag, "region": region},
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
            )
        publisher.publish(message)
        connections = int(publisher.get_num_connections())
        return {
            "topic": topic,
            "messageType": self._message_type,
            "simulated": False,
            "pointCount": len(coordinates),
            "connections": connections,
        }

    def status(self) -> Dict[str, Any]:
        with self._lock:
            simulation = self.settings.simulation
            return {
                "available": ROS_AVAILABLE or simulation,
                "mode": "simulation" if simulation else "ros1",
                "masterOnline": self._master_online,
                "gatewayReady": self._started,
                "nodeStarted": self._started and not simulation,
                "nodeName": self.settings.node_name,
                "messageType": self._message_type,
                "lastError": self._start_error,
                "topics": {
                    "fix": self.settings.fix_topic,
                    "odom": self.settings.odom_topic,
                    "publishers": list(self._publishers.keys()),
                },
                "importError": ROS_IMPORT_ERROR,
            }

    def shutdown(self) -> None:
        with self._lock:
            self._publishers.clear()
            self._subscribers.clear()
            self._started = False
        if ROS_AVAILABLE and rospy.core.is_initialized():
            try:
                rospy.signal_shutdown("SkyForge gateway stopped")
            except Exception:
                pass

    def _build_region_command(self, flag: str, region: Dict[str, Any], coordinates: list) -> Any:
        message = self._message_class()
        message.header.stamp = rospy.Time.now()
        message.header.frame_id = "wgs84"
        message.flag = FLAG_VALUES[flag]
        message.region_id = str(region.get("id", ""))
        message.region_name = str(region.get("name", ""))
        message.shape = str(region.get("shape", "rectangle"))
        message.points = [Point32(x=lon, y=lat, z=0.0) for lat, lon in coordinates]
        return message

    @staticmethod
    def _region_coordinates(region: Dict[str, Any]) -> list:
        shape = str(region.get("shape", "rectangle"))
        if shape == "polygon":
            polygon = region.get("polygon")
            if not isinstance(polygon, list):
                raise ValueError("Polygon region requires a polygon array")
            coordinates = []
            for index, point in enumerate(polygon):
                if not isinstance(point, dict) or "lat" not in point or "lon" not in point:
                    raise ValueError(f"Polygon point {index} requires lat and lon")
                coordinates.append((float(point["lat"]), float(point["lon"])))
            return coordinates

        bbox = region.get("bbox")
        if not isinstance(bbox, dict):
            raise ValueError("Rectangle region requires bbox")
        top_left = bbox.get("topLeft")
        bottom_right = bbox.get("bottomRight")
        if not isinstance(top_left, dict) or not isinstance(bottom_right, dict):
            raise ValueError("Rectangle bbox requires topLeft and bottomRight")
        try:
            north = float(top_left["lat"])
            west = float(top_left["lon"])
            south = float(bottom_right["lat"])
            east = float(bottom_right["lon"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Rectangle bbox coordinates are invalid") from exc
        if north <= south or east <= west:
            raise ValueError("Rectangle bbox must satisfy north > south and east > west")
        return [(north, west), (north, east), (south, east), (south, west)]

    def _on_fix(self, message: Any) -> None:
        with self._lock:
            self._latest.update(
                {
                    "lat": self._finite_or_none(message.latitude),
                    "lon": self._finite_or_none(message.longitude),
                    "altitude": self._finite_or_none(message.altitude),
                }
            )
        self._emit_telemetry(self.settings.fix_topic)

    def _on_odom(self, message: Any) -> None:
        linear = message.twist.twist.linear
        orientation = message.pose.pose.orientation
        siny_cosp = 2.0 * (orientation.w * orientation.z + orientation.x * orientation.y)
        cosy_cosp = 1.0 - 2.0 * (orientation.y * orientation.y + orientation.z * orientation.z)
        heading = math.degrees(math.atan2(siny_cosp, cosy_cosp)) % 360.0
        speed = math.sqrt(linear.x * linear.x + linear.y * linear.y + linear.z * linear.z)
        with self._lock:
            self._latest.update({"heading": heading, "speed": speed})
            has_fix = self._latest["lat"] is not None and self._latest["lon"] is not None
        if has_fix:
            self._emit_telemetry(self.settings.odom_topic)

    def _emit_telemetry(self, source_topic: str) -> None:
        with self._lock:
            telemetry = dict(self._latest)
        if telemetry["lat"] is None or telemetry["lon"] is None:
            return
        telemetry.update(
            {
                "time": _now(),
                "source": "ros1-noetic",
                "topic": source_topic,
            }
        )
        self.emit("telemetry", telemetry)

    @staticmethod
    def _finite_or_none(value: Any) -> Optional[float]:
        number = float(value)
        return number if math.isfinite(number) else None
