from __future__ import annotations

import os
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Tuple


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    project_root: Path
    public_dir: Path
    region_store: Path
    map_store_dir: Path
    host: str
    port: int
    node_name: str
    globalpose_topic: str
    fix_topic: str
    odom_topic: str
    default_region_topic: str
    launch_package: str
    launch_file: str
    launch_args: Tuple[str, ...]
    simulation: bool
    allow_string_fallback: bool
    allow_remote_agent: bool

    @classmethod
    def from_env(cls) -> "Settings":
        project_root = Path(__file__).resolve().parents[1]
        return cls(
            project_root=project_root,
            public_dir=project_root / "public",
            region_store=project_root / "data" / "regions.json",
            map_store_dir=Path(
                os.getenv("SKYFORGE_MAP_STORE_DIR", str(project_root / "data" / "maps"))
            ).expanduser().resolve(),
            host=os.getenv("SKYFORGE_HOST", "127.0.0.1"),
            port=int(os.getenv("SKYFORGE_PORT", os.getenv("PORT", "3000"))),
            node_name=os.getenv("SKYFORGE_ROS_NODE", "skyforge_gateway"),
            globalpose_topic=os.getenv("SKYFORGE_GLOBALPOSE_TOPIC", "/self_state/globalpose"),
            fix_topic=os.getenv("SKYFORGE_FIX_TOPIC", "/fix"),
            odom_topic=os.getenv("SKYFORGE_ODOM_TOPIC", "/odom"),
            default_region_topic=os.getenv("SKYFORGE_REGION_TOPIC", "/selected_region"),
            launch_package=os.getenv("SKYFORGE_LAUNCH_PACKAGE", ""),
            launch_file=os.getenv("SKYFORGE_LAUNCH_FILE", ""),
            launch_args=tuple(shlex.split(os.getenv("SKYFORGE_LAUNCH_ARGS", ""))),
            simulation=_env_bool("SKYFORGE_SIMULATION", False),
            allow_string_fallback=_env_bool("SKYFORGE_ALLOW_STRING_FALLBACK", False),
            allow_remote_agent=_env_bool("SKYFORGE_ALLOW_REMOTE_AGENT", False),
        )

    @property
    def launch_configured(self) -> bool:
        return bool(self.launch_package and self.launch_file)

    def public_status(self) -> dict:
        return {
            "nodeName": self.node_name,
            "globalposeTopic": self.globalpose_topic,
            "fixTopic": self.fix_topic,
            "odomTopic": self.odom_topic,
            "regionTopic": self.default_region_topic,
            "mapStoreDir": str(self.map_store_dir),
            "simulation": self.simulation,
            "allowStringFallback": self.allow_string_fallback,
            "launch": {
                "configured": self.launch_configured,
                "package": self.launch_package or None,
                "file": self.launch_file or None,
                "args": list(self.launch_args),
            },
        }
