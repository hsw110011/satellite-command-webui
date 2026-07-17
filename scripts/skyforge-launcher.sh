#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/skyforge"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/skyforge"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/skyforge-${UID}"
CONFIG_FILE="${SKYFORGE_CONFIG_FILE:-$CONFIG_DIR/skyforge.env}"
BACKEND_LOG="$STATE_DIR/backend.log"
BROWSER_LOG="$STATE_DIR/window.log"
MODE="${SKYFORGE_MODE:-auto}"
WINDOW_MODE="app"
DRY_RUN=0
BACKEND_PID=""
STARTED_BACKEND=0

show_help() {
  cat <<'EOF'
SkyForge Ubuntu independent-window launcher

Usage:
  skyforge-launcher.sh [--auto|--ros|--demo] [--app|--kiosk] [--dry-run]

Modes:
  --auto   Use ROS mode when Noetic and Python dependencies are available;
           otherwise use the Python simulation backend. This is the default.
  --ros    Require the FastAPI + rospy Noetic backend.
  --demo   Use the Node simulation backend without ROS.
  --app    Open a normal standalone Chromium application window.
  --kiosk  Open a fullscreen kiosk window.
  --dry-run
           Print resolved configuration and dependency diagnostics only.
EOF
}

notify_error() {
  local message="$1"
  printf 'SkyForge: %s\n' "$message" >&2
  if [[ -n "${DISPLAY:-}" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --error --title="SkyForge" --text="$message" >/dev/null 2>&1 || true
  fi
}

load_configuration() {
  mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_DIR"
  if [[ -f "$CONFIG_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
    set +a
  fi
  MODE="${SKYFORGE_MODE:-$MODE}"
}

parse_arguments() {
  while (($#)); do
    case "$1" in
      --auto) MODE="auto" ;;
      --ros) MODE="ros" ;;
      --demo) MODE="demo" ;;
      --app) WINDOW_MODE="app" ;;
      --kiosk) WINDOW_MODE="kiosk" ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) show_help; exit 0 ;;
      *) notify_error "未知参数: $1"; show_help; exit 2 ;;
    esac
    shift
  done
}

prepare_ros_environment() {
  if [[ ! -f /opt/ros/noetic/setup.bash ]]; then
    return 1
  fi
  set +u
  # shellcheck disable=SC1091
  source /opt/ros/noetic/setup.bash
  if [[ -f "$ROOT_DIR/ros1_ws/devel/setup.bash" ]]; then
    # shellcheck disable=SC1091
    source "$ROOT_DIR/ros1_ws/devel/setup.bash"
  fi
  if [[ -n "${SKYFORGE_EXTRA_SETUP:-}" ]]; then
    if [[ ! -f "$SKYFORGE_EXTRA_SETUP" ]]; then
      set -u
      return 1
    fi
    # shellcheck disable=SC1090
    source "$SKYFORGE_EXTRA_SETUP"
  fi
  set -u
  return 0
}

resolve_python() {
  if [[ -n "${SKYFORGE_PYTHON:-}" ]]; then
    printf '%s\n' "$SKYFORGE_PYTHON"
  elif [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
    printf '%s\n' "$ROOT_DIR/.venv/bin/python"
  else
    command -v python3 || true
  fi
}

python_ros_ready() {
  local python_bin="$1"
  [[ -n "$python_bin" ]] || return 1
  python_gateway_ready "$python_bin" || return 1
  "$python_bin" -c 'import rospy' >/dev/null 2>&1
}

python_gateway_ready() {
  local python_bin="$1"
  [[ -n "$python_bin" ]] || return 1
  "$python_bin" -c 'import fastapi, uvicorn, rasterio, numpy, PIL' >/dev/null 2>&1
}

resolve_mode() {
  local python_bin="$1"
  case "$MODE" in
    auto)
      if prepare_ros_environment && python_ros_ready "$python_bin"; then
        MODE="ros"
      elif python_gateway_ready "$python_bin"; then
        MODE="demo"
      else
        notify_error "Python Gateway 依赖不可用。请安装 ros_backend/requirements.txt。"
        exit 1
      fi
      ;;
    ros)
      if ! prepare_ros_environment; then
        notify_error "未找到 ROS Noetic。请确认 /opt/ros/noetic/setup.bash 存在。"
        exit 1
      fi
      if ! python_ros_ready "$python_bin"; then
        notify_error "ROS Python Gateway 依赖不可用。请使用 --system-site-packages 虚拟环境安装 ros_backend/requirements.txt。"
        exit 1
      fi
      ;;
    demo)
      if ! python_gateway_ready "$python_bin"; then
        notify_error "演示模式依赖不可用。请创建虚拟环境并安装 ros_backend/requirements.txt。"
        exit 1
      fi
      ;;
    *) notify_error "SKYFORGE_MODE 必须是 auto、ros 或 demo"; exit 2 ;;
  esac
}

find_browser() {
  if [[ -n "${SKYFORGE_BROWSER:-}" ]] && command -v "$SKYFORGE_BROWSER" >/dev/null 2>&1; then
    command -v "$SKYFORGE_BROWSER"
    return
  fi
  local candidate
  for candidate in chromium-browser chromium google-chrome-stable google-chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done
  return 1
}

skyforge_is_ready() {
  local url="$1"
  local page=""
  command -v curl >/dev/null 2>&1 || return 1
  curl --noproxy '*' --silent --fail --max-time 1 "$url/api/regions" >/dev/null 2>&1 || return 1
  curl --noproxy '*' --silent --fail --max-time 1 "$url/api/system/status" >/dev/null 2>&1 || return 1
  page="$(curl --noproxy '*' --silent --fail --max-time 1 "$url/" 2>/dev/null)" || return 1
  [[ -n "$page" && "$page" == *"<html"* ]]
}

port_is_occupied() {
  local host="$1"
  local port="$2"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$host" "$port" <<'PY'
import socket
import sys
sock = socket.socket()
sock.settimeout(0.3)
try:
    occupied = sock.connect_ex((sys.argv[1], int(sys.argv[2]))) == 0
finally:
    sock.close()
raise SystemExit(0 if occupied else 1)
PY
  else
    return 1
  fi
}

start_backend() {
  local python_bin="$1"
  local host="${SKYFORGE_HOST:-127.0.0.1}"
  local port="${SKYFORGE_PORT:-${PORT:-3000}}"
  local url_host="$host"
  [[ "$url_host" == "0.0.0.0" ]] && url_host="127.0.0.1"
  [[ "$url_host" == "::" ]] && url_host="127.0.0.1"
  SKYFORGE_URL="http://${url_host}:${port}"
  export SKYFORGE_HOST="$host" SKYFORGE_PORT="$port" PORT="$port"

  if skyforge_is_ready "$SKYFORGE_URL"; then
    printf 'Reusing existing SkyForge backend at %s\n' "$SKYFORGE_URL"
    return
  fi
  if port_is_occupied "$url_host" "$port"; then
    notify_error "端口 ${port} 已被其他程序占用。请修改 $CONFIG_FILE 中的 SKYFORGE_PORT。"
    exit 1
  fi

  : >"$BACKEND_LOG"
  if [[ "$MODE" == "ros" ]]; then
    (
      cd "$ROOT_DIR"
      export SKYFORGE_SIMULATION=0
      exec "$python_bin" -m ros_backend.app
    ) >>"$BACKEND_LOG" 2>&1 &
  else
    (
      cd "$ROOT_DIR"
      export SKYFORGE_SIMULATION=1
      exec "$python_bin" -m ros_backend.app
    ) >>"$BACKEND_LOG" 2>&1 &
  fi
  BACKEND_PID=$!
  STARTED_BACKEND=1

  local attempt
  for attempt in $(seq 1 80); do
    if skyforge_is_ready "$SKYFORGE_URL"; then
      printf 'SkyForge %s backend ready at %s\n' "$MODE" "$SKYFORGE_URL"
      return
    fi
    if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
      notify_error "后端启动失败，请查看 $BACKEND_LOG"
      exit 1
    fi
    sleep 0.1
  done
  notify_error "等待后端超时，请查看 $BACKEND_LOG"
  exit 1
}

cleanup() {
  if [[ "$STARTED_BACKEND" -eq 1 && -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill -TERM "$BACKEND_PID" >/dev/null 2>&1 || true
    local attempt
    for attempt in $(seq 1 50); do
      kill -0 "$BACKEND_PID" >/dev/null 2>&1 || break
      sleep 0.1
    done
    if kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
      kill -KILL "$BACKEND_PID" >/dev/null 2>&1 || true
    fi
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}

run_diagnostics() {
  local python_bin="$1"
  local browser=""
  browser="$(find_browser 2>/dev/null || true)"
  printf 'project=%s\n' "$ROOT_DIR"
  printf 'config=%s\n' "$CONFIG_FILE"
  printf 'mode=%s\n' "$MODE"
  printf 'window=%s\n' "$WINDOW_MODE"
  printf 'python=%s\n' "${python_bin:-missing}"
  printf 'python_gateway=%s\n' "$(python_gateway_ready "$python_bin" && printf ready || printf missing)"
  printf 'browser=%s\n' "${browser:-missing}"
  printf 'ros_noetic=%s\n' "$([[ -f /opt/ros/noetic/setup.bash ]] && printf available || printf missing)"
  printf 'message_workspace=%s\n' "$([[ -f "$ROOT_DIR/ros1_ws/devel/setup.bash" ]] && printf built || printf not-built)"
  printf 'backend_log=%s\n' "$BACKEND_LOG"
}

main() {
  load_configuration
  parse_arguments "$@"

  local python_bin
  python_bin="$(resolve_python)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    run_diagnostics "$python_bin"
    exit 0
  fi

  if command -v flock >/dev/null 2>&1; then
    exec 9>"$RUNTIME_DIR/launcher.lock"
    if ! flock -n 9; then
      notify_error "SkyForge 窗口已经运行。"
      exit 0
    fi
  fi

  resolve_mode "$python_bin"
  local browser
  browser="$(find_browser 2>/dev/null || true)"
  if [[ -z "$browser" ]]; then
    notify_error "未找到 Chromium 或 Google Chrome。请安装 chromium-browser/chromium。"
    exit 1
  fi

  trap cleanup EXIT INT TERM
  start_backend "$python_bin"

  local browser_profile_dir="$CONFIG_DIR/chromium-profile"
  if [[ "$browser" == */chromium-browser && -x /snap/bin/chromium ]]; then
    browser_profile_dir="$HOME/snap/chromium/common/skyforge-profile"
  fi
  mkdir -p "$browser_profile_dir"
  local browser_args=(
    "--user-data-dir=$browser_profile_dir"
    "--class=SkyForge"
    "--name=SkyForge"
    "--no-first-run"
    "--no-default-browser-check"
    "--disable-session-crashed-bubble"
    "--disk-cache-size=1"
    "--media-cache-size=1"
  )
  if [[ "$WINDOW_MODE" == "kiosk" ]]; then
    browser_args+=("--kiosk" "$SKYFORGE_URL")
  else
    browser_args+=("--app=$SKYFORGE_URL" "--start-maximized")
  fi

  printf 'Opening SkyForge independent window (%s)...\n' "$MODE"
  "$browser" "${browser_args[@]}" >>"$BROWSER_LOG" 2>&1 || true
}

main "$@"
