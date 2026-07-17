"""Bounded, multi-resolution GeoTIFF tile and coordinate provider."""
from __future__ import annotations

import hashlib
import io
import math
import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import numpy as np
    import rasterio
    from PIL import Image
    from rasterio.crs import CRS
    from rasterio.enums import Resampling
    from rasterio.warp import transform as warp_transform, transform_bounds

    GEOTIFF_AVAILABLE = True
    GEOTIFF_ERROR: Optional[str] = None
except ImportError as _exc:
    GEOTIFF_AVAILABLE = False
    GEOTIFF_ERROR = str(_exc)
    np = None  # type: ignore
    rasterio = None  # type: ignore
    Image = None  # type: ignore

TILE_SIZE = 256
TILE_CACHE_ITEMS = max(64, min(4096, int(os.getenv("SKYFORGE_TILE_CACHE_ITEMS", "768"))))
BUILD_OVERVIEWS = os.getenv("SKYFORGE_BUILD_OVERVIEWS", "1").strip().lower() not in {"0", "false", "no"}
OVERVIEW_MIN_PIXELS = max(1, int(os.getenv("SKYFORGE_OVERVIEW_MIN_PIXELS", str(16 * 1024 * 1024))))
_OVERVIEW_BUILD_LOCK = threading.Lock()
WGS84 = CRS.from_epsg(4326) if GEOTIFF_AVAILABLE else None
TERRAIN_CMAP: List[Tuple[float, Tuple[int, int, int]]] = [
    (0.00, (18, 50, 72)), (0.08, (22, 72, 85)), (0.18, (34, 108, 68)),
    (0.32, (82, 158, 58)), (0.48, (168, 186, 42)), (0.62, (210, 160, 38)),
    (0.76, (195, 100, 42)), (0.88, (160, 65, 45)), (0.95, (200, 190, 185)),
    (1.00, (245, 245, 245)),
]


def _build_lut() -> "np.ndarray":
    lut = np.zeros((256, 3), dtype=np.uint8)
    for index in range(256):
        value = index / 255.0
        for segment in range(len(TERRAIN_CMAP) - 1):
            start, start_rgb = TERRAIN_CMAP[segment]
            end, end_rgb = TERRAIN_CMAP[segment + 1]
            if start <= value <= end:
                ratio = (value - start) / (end - start) if end > start else 0.0
                lut[index] = [int(a + (b - a) * ratio) for a, b in zip(start_rgb, end_rgb)]
                break
    return lut


def _fingerprint(path: Path, dataset: Any) -> str:
    """Stable identity without hashing an arbitrarily large file end-to-end."""
    size = path.stat().st_size
    digest = hashlib.sha256()
    digest.update(str(size).encode("ascii"))
    digest.update(str(dataset.width).encode("ascii"))
    digest.update(str(dataset.height).encode("ascii"))
    digest.update(str(dataset.count).encode("ascii"))
    digest.update(str(dataset.crs).encode("utf-8"))
    digest.update(repr(tuple(dataset.transform)).encode("ascii"))
    sample_size = 1024 * 1024
    offsets = sorted({0, max(0, size // 2 - sample_size // 2), max(0, size - sample_size)})
    with path.open("rb") as handle:
        for offset in offsets:
            handle.seek(offset)
            digest.update(handle.read(sample_size))
    return digest.hexdigest()


def _overview_factors(width: int, height: int) -> List[int]:
    factors: List[int] = []
    factor = 2
    while math.ceil(width / factor) > TILE_SIZE or math.ceil(height / factor) > TILE_SIZE:
        factors.append(factor)
        factor *= 2
    factors.append(factor)
    return factors


def _has_overview_factor(existing: Sequence[int], desired: int) -> bool:
    tolerance = max(1, round(desired * 0.02))
    return any(abs(actual - desired) <= tolerance for actual in existing)


def _ensure_overviews(path: Path, source_kind: str) -> Optional[str]:
    if not BUILD_OVERVIEWS:
        return None
    try:
        with _OVERVIEW_BUILD_LOCK:
            with rasterio.open(str(path), "r+") as dataset:
                if dataset.width * dataset.height < OVERVIEW_MIN_PIXELS:
                    return None
                desired = _overview_factors(dataset.width, dataset.height)
                existing = dataset.overviews(1) if dataset.count else []
                if all(_has_overview_factor(existing, factor) for factor in desired):
                    return None
                auto_dsm = dataset.count == 1 and dataset.dtypes[0] != "uint8"
                is_dsm = source_kind == "dsm" or (source_kind == "auto" and auto_dsm)
                resampling = Resampling.average if is_dsm else Resampling.bilinear
                with rasterio.Env(COMPRESS_OVERVIEW="DEFLATE", GDAL_TIFF_OVR_BLOCKSIZE="256"):
                    dataset.build_overviews(desired, resampling)
                    dataset.update_tags(ns="rio_overview", resampling=resampling.name)
        return None
    except Exception as exc:
        return str(exc)


class GeoTiffProvider:
    """Owns one raster and serves exact transforms plus bounded overview tiles."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._dataset: Optional[Any] = None
        self._path: Optional[Path] = None
        self._bounds: Optional[Dict[str, float]] = None
        self._native_crs = "unknown"
        self._width = 0
        self._height = 0
        self._levels: List[Dict[str, int]] = []
        self._fingerprint: Optional[str] = None
        self._error: Optional[str] = None
        self._is_dsm = False
        self._elev_min = 0.0
        self._elev_max = 1.0
        self._nodata: Optional[float] = None
        self._terrain_lut: Optional["np.ndarray"] = None
        self._overview_factors: List[int] = []
        self._overview_error: Optional[str] = None

    @property
    def loaded(self) -> bool:
        with self._lock:
            return self._dataset is not None

    @property
    def is_dsm(self) -> bool:
        with self._lock:
            return self._is_dsm

    def load(self, file_path: str, source_kind: str = "auto") -> Dict[str, Any]:
        if not GEOTIFF_AVAILABLE:
            raise RuntimeError(f"GeoTIFF 依赖不可用: {GEOTIFF_ERROR}。请 pip install rasterio numpy Pillow")
        path = Path(file_path).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError("上传的 GeoTIFF 文件不存在")
        if path.suffix.lower() not in {".tif", ".tiff", ".geotiff"}:
            raise ValueError(f"不支持的文件格式: {path.suffix}")
        source_kind = source_kind.lower().strip()
        if source_kind not in {"auto", "dom", "dsm"}:
            raise ValueError(f"不支持的数据源角色: {source_kind}")

        overview_error = _ensure_overviews(path, source_kind)
        try:
            dataset = rasterio.open(str(path))
        except Exception as exc:
            raise RuntimeError(f"无法打开 GeoTIFF: {exc}") from exc
        try:
            if dataset.width <= 0 or dataset.height <= 0 or dataset.count <= 0:
                raise ValueError("GeoTIFF 没有有效栅格数据")
            bounds = self._get_wgs84_bounds(dataset)
            identity = _fingerprint(path, dataset)
            auto_dsm = dataset.count == 1 and dataset.dtypes[0] != "uint8"
            is_dsm = source_kind == "dsm" or (source_kind == "auto" and auto_dsm)
            nodata = float(dataset.nodata) if dataset.nodata is not None else None
            elev_min, elev_max = 0.0, 1.0
            if is_dsm:
                sample = dataset.read(
                    1,
                    out_shape=(min(1024, dataset.height), min(1024, dataset.width)),
                    resampling=Resampling.nearest,
                )
                valid = np.isfinite(sample) if np.issubdtype(sample.dtype, np.floating) else np.ones_like(sample, dtype=bool)
                if nodata is not None:
                    valid &= sample != nodata
                if valid.any():
                    elev_min = float(sample[valid].min())
                    elev_max = float(sample[valid].max())
                    if elev_max <= elev_min:
                        elev_max = elev_min + 1.0
            levels: List[Dict[str, int]] = []
            factor = 1
            while True:
                level_width = math.ceil(dataset.width / factor)
                level_height = math.ceil(dataset.height / factor)
                levels.append({
                    "level": len(levels), "factor": factor,
                    "width": level_width, "height": level_height,
                    "tileCols": math.ceil(level_width / TILE_SIZE),
                    "tileRows": math.ceil(level_height / TILE_SIZE),
                })
                if level_width <= TILE_SIZE and level_height <= TILE_SIZE:
                    break
                factor *= 2

            with self._lock:
                previous = self._dataset
                self._dataset = dataset
                self._path = path
                self._bounds = bounds
                self._native_crs = str(dataset.crs) if dataset.crs else "unknown"
                self._width, self._height = dataset.width, dataset.height
                self._levels = levels
                self._fingerprint = identity
                self._error = None
                self._is_dsm = is_dsm
                self._elev_min, self._elev_max = elev_min, elev_max
                self._nodata = nodata
                self._overview_factors = list(dataset.overviews(1)) if dataset.count else []
                self._overview_error = overview_error
                if is_dsm and self._terrain_lut is None:
                    self._terrain_lut = _build_lut()
                self._get_tile_png.cache_clear()
                self.get_full_image.cache_clear()
                if previous is not None:
                    try:
                        previous.close()
                    except Exception:
                        pass
            dataset = None
            return self.metadata()
        finally:
            if dataset is not None:
                dataset.close()

    def metadata(self) -> Dict[str, Any]:
        with self._lock:
            if self._dataset is None:
                return {"loaded": False, "error": self._error or "未加载 GeoTIFF"}
            base: Dict[str, Any] = {
                "loaded": True, "crs": self._native_crs, "bounds": dict(self._bounds or {}),
                "width": self._width, "height": self._height, "tileSize": TILE_SIZE,
                "tileCacheItems": TILE_CACHE_ITEMS,
                "tileCols": self._levels[0]["tileCols"], "tileRows": self._levels[0]["tileRows"],
                "levels": [dict(level) for level in self._levels],
                "fingerprint": self._fingerprint, "isDsm": self._is_dsm,
                "filename": self._path.name if self._path is not None else None,
                "overviewFactors": list(self._overview_factors),
                "overviewReady": not self._overview_error and bool(self._overview_factors),
                "overviewError": self._overview_error,
            }
            if self._is_dsm:
                base["elevation"] = {
                    "min": round(self._elev_min, 2), "max": round(self._elev_max, 2),
                    "unit": "m", "nodata": self._nodata,
                }
            return base

    def get_tile(self, level: int, col: int, row: int) -> Optional[bytes]:
        with self._lock:
            if self._dataset is None or level < 0 or level >= len(self._levels):
                return None
            info = self._levels[level]
            if col < 0 or row < 0 or col >= info["tileCols"] or row >= info["tileRows"]:
                return None
        return self._get_tile_png(level, col, row)

    def wgs84_to_pixel(self, lat: float, lon: float) -> Dict[str, float]:
        with self._lock:
            dataset = self._require_dataset()
            x, y = float(lon), float(lat)
            if dataset.crs is not None and dataset.crs != WGS84:
                xs, ys = warp_transform(WGS84, dataset.crs, [x], [y])
                x, y = xs[0], ys[0]
            col, row = ~dataset.transform * (x, y)
            return {"x": float(col), "y": float(row)}

    def pixel_to_wgs84(self, x: float, y: float) -> Dict[str, float]:
        with self._lock:
            dataset = self._require_dataset()
            native_x, native_y = dataset.transform * (float(x), float(y))
            if dataset.crs is not None and dataset.crs != WGS84:
                xs, ys = warp_transform(dataset.crs, WGS84, [native_x], [native_y])
                native_x, native_y = xs[0], ys[0]
            return {"lat": float(native_y), "lon": float(native_x)}

    def transform_points(self, direction: str, points: Sequence[Dict[str, Any]]) -> List[Dict[str, float]]:
        if direction == "wgs84_to_pixel":
            return [self.wgs84_to_pixel(float(point["lat"]), float(point["lon"])) for point in points]
        if direction == "pixel_to_wgs84":
            return [self.pixel_to_wgs84(float(point["x"]), float(point["y"])) for point in points]
        raise ValueError("direction 必须是 wgs84_to_pixel 或 pixel_to_wgs84")

    def query_elevation(self, lat: Optional[float] = None, lon: Optional[float] = None,
                        x: Optional[float] = None, y: Optional[float] = None) -> Optional[Dict[str, Any]]:
        with self._lock:
            dataset = self._dataset
            if dataset is None or not self._is_dsm:
                return None
            if x is None or y is None:
                if lat is None or lon is None:
                    raise ValueError("需要 lat/lon 或 x/y")
                pixel = self.wgs84_to_pixel(lat, lon)
                x, y = pixel["x"], pixel["y"]
            else:
                coordinate = self.pixel_to_wgs84(x, y)
                lat, lon = coordinate["lat"], coordinate["lon"]
            col, row = math.floor(x), math.floor(y)
            if col < 0 or row < 0 or col >= dataset.width or row >= dataset.height:
                return {"lat": lat, "lon": lon, "x": x, "y": y, "elevation": None, "error": "超出地图范围"}
            value = dataset.read(1, window=rasterio.windows.Window(col, row, 1, 1))[0, 0]
            if (self._nodata is not None and value == self._nodata) or not math.isfinite(float(value)):
                return {"lat": lat, "lon": lon, "x": x, "y": y, "elevation": None, "error": "nodata"}
            return {
                "lat": lat, "lon": lon, "x": x, "y": y,
                "elevation": round(float(value), 3), "unit": "m",
            }

    @lru_cache(maxsize=TILE_CACHE_ITEMS)
    def _get_tile_png(self, level: int, col: int, row: int) -> Optional[bytes]:
        with self._lock:
            dataset = self._dataset
            if dataset is None:
                return None
            factor = self._levels[level]["factor"]
            x_off, y_off = col * TILE_SIZE * factor, row * TILE_SIZE * factor
            x_size = min(TILE_SIZE * factor, dataset.width - x_off)
            y_size = min(TILE_SIZE * factor, dataset.height - y_off)
            if x_size <= 0 or y_size <= 0:
                return None
            out_width = min(TILE_SIZE, math.ceil(x_size / factor))
            out_height = min(TILE_SIZE, math.ceil(y_size / factor))
            band_count = min(dataset.count, 4)
            data = dataset.read(
                list(range(1, band_count + 1)),
                window=rasterio.windows.Window(x_off, y_off, x_size, y_size),
                out_shape=(band_count, out_height, out_width),
                resampling=Resampling.nearest if factor == 1 else Resampling.bilinear,
                boundless=False,
            )
            is_dsm, elev_min, elev_max = self._is_dsm, self._elev_min, self._elev_max
            nodata, lut = self._nodata, self._terrain_lut
        if is_dsm and band_count == 1:
            image = self._render_dsm_tile(data[0], elev_min, elev_max, nodata, lut)
        elif band_count == 1:
            image = Image.fromarray(self._normalize_band(data[0]), mode="L").convert("RGB")
        elif band_count == 3:
            image = Image.fromarray(np.stack([self._normalize_band(data[i]) for i in range(3)], axis=-1), mode="RGB")
        else:
            image = Image.fromarray(np.stack([self._normalize_band(data[i]) for i in range(4)], axis=-1), mode="RGBA")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=False)
        return buffer.getvalue()

    @lru_cache(maxsize=4)
    def get_full_image(self, max_dim: int = 0) -> Optional[bytes]:
        """Render the entire raster as a single PNG.

        If max_dim > 0 and width or height exceeds max_dim, the image is
        down-sampled while keeping aspect ratio; otherwise outputs at
        native resolution. DSM data is rendered with the terrain colormap.
        """
        with self._lock:
            dataset = self._dataset
            if dataset is None:
                return None
            width, height = dataset.width, dataset.height
            band_count = min(dataset.count, 4)
            is_dsm = self._is_dsm
            elev_min, elev_max = self._elev_min, self._elev_max
            nodata, lut = self._nodata, self._terrain_lut

        # Determine output size
        out_w, out_h = width, height
        if max_dim > 0 and (width > max_dim or height > max_dim):
            ratio = min(max_dim / width, max_dim / height)
            out_w = max(1, round(width * ratio))
            out_h = max(1, round(height * ratio))

        with self._lock:
            if self._dataset is None:
                return None
            data = self._dataset.read(
                list(range(1, band_count + 1)),
                out_shape=(band_count, out_h, out_w),
                resampling=Resampling.bilinear,
            )

        if is_dsm and band_count == 1:
            image = self._render_dsm_tile(data[0], elev_min, elev_max, nodata, lut)
        elif band_count == 1:
            image = Image.fromarray(self._normalize_band(data[0]), mode="L").convert("RGB")
        elif band_count == 3:
            image = Image.fromarray(np.stack([self._normalize_band(data[i]) for i in range(3)], axis=-1), mode="RGB")
        else:
            image = Image.fromarray(np.stack([self._normalize_band(data[i]) for i in range(4)], axis=-1), mode="RGBA")

        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=False)
        return buffer.getvalue()

    def close(self) -> None:
        with self._lock:
            if self._dataset is not None:
                try:
                    self._dataset.close()
                finally:
                    self._dataset = None
            self._get_tile_png.cache_clear()
            self.get_full_image.cache_clear()

    def _require_dataset(self) -> Any:
        if self._dataset is None:
            raise ValueError("未加载 GeoTIFF")
        return self._dataset

    @staticmethod
    def _render_dsm_tile(band: "np.ndarray", elev_min: float, elev_max: float,
                         nodata: Optional[float], lut: "np.ndarray") -> "Image.Image":
        array = band.astype(np.float32)
        valid = np.isfinite(array)
        if nodata is not None:
            valid &= array != nodata
        normalized = ((array - elev_min) / max(elev_max - elev_min, 1.0) * 255).clip(0, 255).astype(np.uint8)
        rgb = lut[normalized]
        rgb[~valid] = [12, 18, 24]
        return Image.fromarray(rgb, mode="RGB")

    @staticmethod
    def _normalize_band(band: "np.ndarray") -> "np.ndarray":
        if band.dtype == np.uint8:
            return band
        valid = np.isfinite(band) if np.issubdtype(band.dtype, np.floating) else np.ones_like(band, dtype=bool)
        if not valid.any():
            return np.zeros_like(band, dtype=np.uint8)
        minimum, maximum = float(band[valid].min()), float(band[valid].max())
        if maximum <= minimum:
            return np.zeros_like(band, dtype=np.uint8)
        return ((band.astype(np.float32) - minimum) / (maximum - minimum) * 255).clip(0, 255).astype(np.uint8)

    @staticmethod
    def _get_wgs84_bounds(dataset: Any) -> Dict[str, float]:
        bounds = dataset.bounds
        if dataset.crs is None or dataset.crs == WGS84:
            west, south, east, north = bounds.left, bounds.bottom, bounds.right, bounds.top
        else:
            west, south, east, north = transform_bounds(dataset.crs, WGS84, *bounds, densify_pts=21)
        return {"north": north, "south": south, "west": west, "east": east}
