import io
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_bounds

import ros_backend.app as app_module
import ros_backend.geotiff_provider as geotiff_module
from ros_backend.geotiff_provider import GeoTiffProvider


class GeoTiffTileTests(unittest.TestCase):
    @staticmethod
    def write_dom(path: Path, width: int = 1031, height: int = 769) -> None:
        rows = np.arange(height, dtype=np.uint16)[:, None]
        cols = np.arange(width, dtype=np.uint16)[None, :]
        data = np.stack(
            [
                (cols + rows) % 256,
                np.broadcast_to((cols * 3) % 256, (height, width)),
                np.broadcast_to((rows * 5) % 256, (height, width)),
            ]
        ).astype(np.uint8)
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=width,
            height=height,
            count=3,
            dtype="uint8",
            crs="EPSG:4326",
            transform=from_bounds(112.0, 28.0, 114.0, 30.0, width, height),
            tiled=True,
            blockxsize=256,
            blockysize=256,
        ) as dataset:
            dataset.write(data)

    def test_every_overview_and_edge_tile_renders(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "dom.tif"
            self.write_dom(path)
            provider = GeoTiffProvider()
            try:
                metadata = provider.load(str(path), "dom")
                for level in metadata["levels"]:
                    for row in range(level["tileRows"]):
                        for col in range(level["tileCols"]):
                            tile = provider.get_tile(level["level"], col, row)
                            self.assertIsNotNone(tile)
                            with Image.open(io.BytesIO(tile)) as image:
                                self.assertGreater(image.width, 0)
                                self.assertGreater(image.height, 0)
                first = provider.get_tile(0, 0, 0)
                second = provider.get_tile(0, 0, 0)
                self.assertEqual(first, second)
            finally:
                provider.close()

    def test_full_preview_respects_the_requested_texture_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "dom.tif"
            self.write_dom(path, 2051, 769)
            provider = GeoTiffProvider()
            try:
                provider.load(str(path), "dom")
                preview = provider.get_full_image(max_dim=512)
                self.assertIsNotNone(preview)
                self.assertEqual(preview, provider.get_full_image(max_dim=512))
                with Image.open(io.BytesIO(preview)) as image:
                    self.assertLessEqual(max(image.size), 512)
                    self.assertGreater(min(image.size), 0)
            finally:
                provider.close()

    def test_large_raster_builds_and_reuses_internal_overviews(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "dom.tif"
            self.write_dom(path, 1031, 769)
            original_threshold = geotiff_module.OVERVIEW_MIN_PIXELS
            geotiff_module.OVERVIEW_MIN_PIXELS = 1
            provider = GeoTiffProvider()
            try:
                metadata = provider.load(str(path), "dom")
                self.assertTrue(metadata["overviewReady"])
                self.assertTrue(metadata["overviewFactors"])
                first_factors = list(metadata["overviewFactors"])
            finally:
                provider.close()
                geotiff_module.OVERVIEW_MIN_PIXELS = original_threshold
            with rasterio.open(path) as dataset:
                self.assertEqual(dataset.overviews(1), first_factors)

    def test_overview_factor_matching_allows_gdal_rounding(self) -> None:
        self.assertTrue(geotiff_module._has_overview_factor([127], 128))
        self.assertFalse(geotiff_module._has_overview_factor([64], 128))

    def test_persisted_map_is_restored_on_startup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            map_dir = Path(temp_dir) / "maps"
            map_dir.mkdir()
            dom_path = map_dir / "dom.tif"
            self.write_dom(dom_path, 513, 385)
            original_dir = app_module.map_upload_dir
            original_paths = app_module.persistent_map_paths
            original_providers = app_module.map_providers
            test_providers = {"dom": GeoTiffProvider(), "dsm": GeoTiffProvider()}
            app_module.map_upload_dir = map_dir
            app_module.persistent_map_paths = {"dom": dom_path, "dsm": map_dir / "dsm.tif"}
            app_module.map_providers = test_providers
            try:
                app_module.restore_persisted_maps()
                metadata = app_module.map_providers["dom"].metadata()
                self.assertTrue(metadata["loaded"])
                self.assertEqual(metadata["width"], 513)
                self.assertEqual(metadata["height"], 385)
                self.assertEqual(metadata["filename"], "dom.tif")
            finally:
                for provider in test_providers.values():
                    provider.close()
                app_module.map_upload_dir = original_dir
                app_module.persistent_map_paths = original_paths
                app_module.map_providers = original_providers


if __name__ == "__main__":
    unittest.main()
