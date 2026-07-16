from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, Optional

from .settings import Settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class LocalizationManager:
    """Runs roslaunch as an isolated process group and tracks its lifecycle safely."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.RLock()
        self._process: Optional[subprocess.Popen] = None
        self._generation = 0
        self._state = "STOPPED"
        self._started_at: Optional[str] = None
        self._stopped_at: Optional[str] = None
        self._last_error: Optional[str] = None
        self._mock = False
        self._logs: Deque[str] = deque(maxlen=120)

    def start(self) -> Dict[str, Any]:
        with self._lock:
            if self._state in {"STARTING", "RUNNING"}:
                return self.status()
            self._generation += 1
            generation = self._generation
            self._state = "STARTING"
            self._last_error = None
            self._stopped_at = None
            self._logs.clear()

        try:
            if self.settings.simulation:
                with self._lock:
                    self._mock = True
                    self._state = "RUNNING"
                    self._started_at = _now()
                    self._logs.append("Simulation localization process started")
                return self.status()

            if not self.settings.launch_configured:
                raise RuntimeError(
                    "未配置定位 launch。请设置 SKYFORGE_LAUNCH_PACKAGE 和 SKYFORGE_LAUNCH_FILE。"
                )
            executable = shutil.which("roslaunch")
            if not executable:
                raise RuntimeError("找不到 roslaunch，请先 source /opt/ros/noetic/setup.bash")

            command = [
                executable,
                self.settings.launch_package,
                self.settings.launch_file,
                *self.settings.launch_args,
            ]
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                start_new_session=True,
            )
            time.sleep(0.15)
            exit_code = process.poll()
            if exit_code is not None:
                output = process.stdout.read().strip() if process.stdout else ""
                raise RuntimeError(output or f"roslaunch 启动失败，退出码 {exit_code}")

            with self._lock:
                if generation != self._generation:
                    self._terminate_process(process)
                    return self.status()
                self._process = process
                self._mock = False
                self._state = "RUNNING"
                self._started_at = _now()
                self._logs.append("$ " + " ".join(command))

            threading.Thread(
                target=self._read_output,
                args=(process, generation),
                name=f"skyforge-roslaunch-log-{generation}",
                daemon=True,
            ).start()
            threading.Thread(
                target=self._wait_for_exit,
                args=(process, generation),
                name=f"skyforge-roslaunch-wait-{generation}",
                daemon=True,
            ).start()
            return self.status()
        except Exception as exc:
            with self._lock:
                if generation == self._generation:
                    self._process = None
                    self._state = "ERROR"
                    self._last_error = str(exc)
                    self._logs.append(str(exc))
            raise RuntimeError(str(exc)) from exc

    def stop(self) -> Dict[str, Any]:
        with self._lock:
            if self._state == "STOPPED":
                return self.status()
            self._generation += 1
            self._state = "STOPPING"
            process = self._process
            self._process = None
            was_mock = self._mock
            self._mock = False

        error: Optional[str] = None
        if process is not None:
            try:
                self._terminate_process(process)
            except Exception as exc:
                error = str(exc)
        elif was_mock:
            self._logs.append("Simulation localization process stopped")

        with self._lock:
            self._state = "ERROR" if error else "STOPPED"
            self._stopped_at = _now()
            self._last_error = error
            if error:
                self._logs.append(error)
        return self.status()

    def close(self) -> None:
        try:
            self.stop()
        except Exception:
            pass

    def status(self) -> Dict[str, Any]:
        with self._lock:
            process = self._process
            pid = process.pid if process is not None and process.poll() is None else None
            return {
                "active": self._state == "RUNNING",
                "state": self._state,
                "mock": self._mock,
                "startedAt": self._started_at,
                "stoppedAt": self._stopped_at,
                "lastError": self._last_error,
                "launch": {
                    "configured": self.settings.launch_configured,
                    "package": self.settings.launch_package or None,
                    "file": self.settings.launch_file or None,
                    "args": list(self.settings.launch_args),
                },
                "processes": ([{"name": "roslaunch", "pid": pid, "alive": True}] if pid else []),
                "logs": list(self._logs)[-30:],
            }

    def _read_output(self, process: subprocess.Popen, generation: int) -> None:
        if process.stdout is None:
            return
        try:
            for line in process.stdout:
                text = line.rstrip()
                if not text:
                    continue
                with self._lock:
                    if generation != self._generation:
                        return
                    self._logs.append(text)
        except Exception as exc:
            with self._lock:
                if generation == self._generation:
                    self._logs.append(f"log reader: {exc}")

    def _wait_for_exit(self, process: subprocess.Popen, generation: int) -> None:
        exit_code = process.wait()
        with self._lock:
            if generation != self._generation:
                return
            self._process = None
            self._stopped_at = _now()
            if self._state in {"STOPPING", "STOPPED"}:
                self._state = "STOPPED"
                return
            self._state = "ERROR"
            self._last_error = f"定位 roslaunch 已退出，退出码 {exit_code}"
            self._logs.append(self._last_error)

    @staticmethod
    def _terminate_process(process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGINT)
            process.wait(timeout=8)
            return
        except subprocess.TimeoutExpired:
            pass
        except ProcessLookupError:
            return

        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=3)
            return
        except subprocess.TimeoutExpired:
            pass
        except ProcessLookupError:
            return

        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=2)
