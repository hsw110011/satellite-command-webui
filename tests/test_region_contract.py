import json
import tempfile
import unittest
from pathlib import Path

import ros_backend.app as app_module
from ros_backend.app import EventHub, GatewayState
from ros_backend.ros_bridge import RosBridge
from ros_backend.settings import Settings


def make_settings(root: Path) -> Settings:
    return Settings(
        project_root=root,
        public_dir=root / "public",
        region_store=root / "data" / "regions.json",
        map_store_dir=root / "data" / "maps",
        host="127.0.0.1",
        port=3000,
        node_name="skyforge_test",
        globalpose_topic="/self_state/globalpose",
        fix_topic="/fix",
        odom_topic="/odom",
        default_region_topic="/selected_region",
        launch_package="",
        launch_file="",
        launch_args=(),
        simulation=True,
        allow_string_fallback=False,
        allow_remote_agent=False,
    )


class RegionContractTests(unittest.TestCase):
    def test_legacy_rectangle_is_normalized_to_named_coordinates(self) -> None:
        legacy = {
            "id": "region-1",
            "name": "AREA-001",
            "shape": "rectangle",
            "sourceType": "geotiff-dom",
            "bbox": {
                "topLeft": {"lat": 28.7, "lon": 113.0},
                "bottomRight": {"lat": 28.6, "lon": 113.1},
            },
        }

        normalized = RosBridge.normalize_region(legacy)

        self.assertEqual(normalized["sourceKind"], "dom")
        self.assertEqual(
            normalized["bbox"],
            {
                "topLeft": {"latitude": 28.7, "longitude": 113.0},
                "bottomRight": {"latitude": 28.6, "longitude": 113.1},
            },
        )
        self.assertEqual(
            RosBridge._region_coordinates(normalized),
            [(28.7, 113.0), (28.7, 113.1), (28.6, 113.1), (28.6, 113.0)],
        )

    def test_polygon_accepts_named_coordinates(self) -> None:
        region = {
            "id": "region-2",
            "shape": "polygon",
            "polygon": [
                {"latitude": 30.0, "longitude": 120.0},
                {"latitude": 30.0, "longitude": 120.1},
                {"latitude": 29.9, "longitude": 120.1},
            ],
        }

        coordinates = RosBridge._region_coordinates(region)

        self.assertEqual(coordinates[0], (30.0, 120.0))
        self.assertEqual(len(coordinates), 3)

    def test_ros_message_contract_uses_named_geo_points(self) -> None:
        message_dir = Path(__file__).resolve().parents[1] / "ros1_ws" / "src" / "skyforge_msgs" / "msg"
        region_message = (message_dir / "RegionCommand.msg").read_text(encoding="utf-8")
        geo_point = (message_dir / "GeoPoint.msg").read_text(encoding="utf-8")

        self.assertIn("skyforge_msgs/GeoPoint[] points", region_message)
        self.assertIn("string region_json", region_message)
        self.assertNotIn("Point32", region_message)
        self.assertIn("float64 latitude", geo_point)
        self.assertIn("float64 longitude", geo_point)

    def test_actual_globalpose_fields_feed_the_trajectory_telemetry(self) -> None:
        class ActualGlobalPose:
            latitude = 28.6664
            longitude = 113.0571
            height = 58.2
            azimuth = 91.5
            vNorth = 3.0
            vEast = 4.0
            vUp = 12.0

        emitted = []
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge = RosBridge(make_settings(Path(temp_dir)), lambda event, data: emitted.append((event, data)))
            bridge._on_globalpose(ActualGlobalPose())

        event, telemetry = emitted[-1]
        self.assertEqual(event, "telemetry")
        self.assertEqual(telemetry["topic"], "/self_state/globalpose")
        self.assertEqual(telemetry["lat"], 28.6664)
        self.assertEqual(telemetry["lon"], 113.0571)
        self.assertEqual(telemetry["altitude"], 58.2)
        self.assertEqual(telemetry["heading"], 91.5)
        self.assertEqual(telemetry["speed"], 13.0)
        self.assertTrue(telemetry["positionUpdate"])


class RegionPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_region_list_is_persisted_after_delete(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            settings = make_settings(root)
            gateway = GatewayState(settings, EventHub())
            gateway.regions = [{"id": "region-1"}]

            await gateway.save_regions([])

            self.assertEqual(json.loads(settings.region_store.read_text(encoding="utf-8")), [])

    async def test_create_publish_and_delete_routes_share_the_persisted_region(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            test_state = GatewayState(make_settings(root), EventHub())
            original_state, original_hub = app_module.state, app_module.hub
            app_module.state, app_module.hub = test_state, EventHub()
            region = {
                "id": "region-route",
                "name": "ROUTE-TEST",
                "shape": "rectangle",
                "sourceType": "geotiff-dsm",
                "bbox": {
                    "topLeft": {"lat": 31.2, "lon": 121.4},
                    "bottomRight": {"lat": 31.1, "lon": 121.5},
                },
            }
            try:
                created = await app_module.save_region(region)
                published = await app_module.start_publishing(
                    {"topic": "/selected_region", "flag": "MATCH_FLAG", "rateHz": 1, "region": created["regions"][0]}
                )
                deleted = await app_module.delete_region("region-route")
            finally:
                app_module.state, app_module.hub = original_state, original_hub

            stored = json.loads(test_state.settings.region_store.read_text(encoding="utf-8"))
            self.assertEqual(created["regions"][0]["sourceKind"], "dsm")
            self.assertEqual(published["publishing"]["flag"], "MATCH_FLAG")
            self.assertEqual(published["publishing"]["region"], created["regions"][0])
            self.assertEqual(deleted["regions"], [])
            self.assertEqual(stored, [])


if __name__ == "__main__":
    unittest.main()
