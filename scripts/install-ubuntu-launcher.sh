#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="$ROOT_DIR/scripts/skyforge-launcher.sh"
ICON="$ROOT_DIR/public/skyforge.svg"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/skyforge"
CONFIG_FILE="$CONFIG_DIR/skyforge.env"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$APPLICATIONS_DIR/skyforge.desktop"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$DESKTOP_FILE"
  if command -v xdg-user-dir >/dev/null 2>&1; then
    desktop_dir="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
    [[ -n "$desktop_dir" ]] && rm -f "$desktop_dir/SkyForge.desktop"
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
  printf 'SkyForge desktop shortcut removed. User configuration was kept at %s\n' "$CONFIG_FILE"
  exit 0
fi

mkdir -p "$CONFIG_DIR" "$APPLICATIONS_DIR"
chmod +x "$LAUNCHER" "$ROOT_DIR/scripts/install-ubuntu-launcher.sh"

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat >"$CONFIG_FILE" <<'EOF'
# SkyForge launcher configuration.
# auto: use ROS Noetic when available, otherwise Python simulation mode.
SKYFORGE_MODE=auto
SKYFORGE_HOST=127.0.0.1
SKYFORGE_PORT=3000
SKYFORGE_BUILD_OVERVIEWS=1
SKYFORGE_OVERVIEW_MIN_PIXELS=16777216
SKYFORGE_SIMULATION_RATE_HZ=5
SKYFORGE_SIMULATION_PERIOD_SECONDS=24
SKYFORGE_SIMULATION_RADIUS_RATIO=0.32

# Uncomment and edit these values on the ROS Noetic workstation.
# SKYFORGE_LAUNCH_PACKAGE=your_localization_pkg
# SKYFORGE_LAUNCH_FILE=localization.launch
# SKYFORGE_LAUNCH_ARGS="map:=/absolute/path/to/map.yaml"
# SKYFORGE_GLOBALPOSE_TOPIC=/self_state/globalpose
# SKYFORGE_GLOBALPOSE_TOPICS=/self_state/globalpose,/vehicle_2/globalpose
# SKYFORGE_FIX_TOPIC=/fix
# SKYFORGE_ODOM_TOPIC=/odom
# SKYFORGE_REGION_TOPIC=/selected_region
# SKYFORGE_MAP_STORE_DIR=/home/your-user/skyforge-maps
# SKYFORGE_EXTRA_SETUP=/home/your-user/catkin_ws/devel/setup.bash

# Optional explicit executable paths.
# SKYFORGE_PYTHON=/absolute/path/to/project/.venv/bin/python
# SKYFORGE_BROWSER=chromium-browser
EOF
  chmod 600 "$CONFIG_FILE"
fi

cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=SkyForge
GenericName=ROS1 Localization Console
Comment=Open the SkyForge ROS Noetic localization control window
Exec="$LAUNCHER" --auto --app
Icon=$ICON
Terminal=false
Categories=Science;Engineering;Robotics;
Keywords=ROS;Noetic;Localization;Satellite;Robot;
StartupNotify=true
StartupWMClass=SkyForge
Actions=Demo;Kiosk;

[Desktop Action Demo]
Name=Open in Demo Mode
Exec="$LAUNCHER" --demo --app

[Desktop Action Kiosk]
Name=Open Fullscreen
Exec="$LAUNCHER" --auto --kiosk
EOF
chmod +x "$DESKTOP_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  if [[ -n "$DESKTOP_DIR" && -d "$DESKTOP_DIR" ]]; then
    cp "$DESKTOP_FILE" "$DESKTOP_DIR/SkyForge.desktop"
    chmod +x "$DESKTOP_DIR/SkyForge.desktop"
    if command -v gio >/dev/null 2>&1; then
      gio set "$DESKTOP_DIR/SkyForge.desktop" metadata::trusted true >/dev/null 2>&1 || true
    fi
  fi
fi

printf '\nSkyForge independent-window shortcut installed.\n'
printf 'Application entry: %s\n' "$DESKTOP_FILE"
printf 'Configuration:     %s\n' "$CONFIG_FILE"
printf 'Launcher:          %s\n\n' "$LAUNCHER"

if ! command -v chromium-browser >/dev/null 2>&1 &&
   ! command -v chromium >/dev/null 2>&1 &&
   ! command -v google-chrome >/dev/null 2>&1 &&
   ! command -v google-chrome-stable >/dev/null 2>&1; then
  printf 'Warning: Chromium/Google Chrome was not found. Install one before opening SkyForge.\n'
fi

printf 'Run diagnostics with:\n  "%s" --dry-run\n' "$LAUNCHER"
