import asyncio
import json
import math
import tempfile
import unittest
from pathlib import Path

import ros_backend.app as app_module
from ros_backend.app import EventHub, GatewayState
from ros_backend.ros_bridge import RosBridge
from ros_backend.settings import Settings, _topic_list


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
        globalpose_topics=("/self_state/globalpose",),
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
    def test_multiple_globalpose_topics_are_normalized_and_deduplicated(self) -> None:
        self.assertEqual(
            _topic_list("/self_state/globalpose", "/self_state/globalpose, vehicle_2/globalpose, /self_state/globalpose"),
            ("/self_state/globalpose", "/vehicle_2/globalpose"),
        )

    def test_simulation_circle_stays_inside_the_loaded_tiff_extent(self) -> None:
        bounds = {
            "north": 28.66941143282784,
            "south": 28.66277393464105,
            "west": 113.05464664180656,
            "east": 113.06207565322958,
        }
        samples = [
            app_module.simulation_circle_sample(bounds, angle)
            for angle in (0.0, math.pi / 2.0, math.pi, math.pi * 1.5)
        ]

        for sample in samples:
            self.assertGreater(sample["lat"], bounds["south"])
            self.assertLess(sample["lat"], bounds["north"])
            self.assertGreater(sample["lon"], bounds["west"])
            self.assertLess(sample["lon"], bounds["east"])
            self.assertGreater(sample["speed"], 0.0)
        self.assertAlmostEqual(samples[0]["heading"], 0.0, places=6)
        self.assertAlmostEqual(samples[1]["heading"], 270.0, places=6)

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

    def test_globalpose_telemetry_preserves_the_subscribed_topic(self) -> None:
        class ActualGlobalPose:
            latitude = 28.6664
            longitude = 113.0571

        emitted = []
        with tempfile.TemporaryDirectory() as temp_dir:
            settings = make_settings(Path(temp_dir))
            settings = Settings(
                **{
                    **settings.__dict__,
                    "globalpose_topics": ("/self_state/globalpose", "/vehicle_2/globalpose"),
                }
            )
            bridge = RosBridge(settings, lambda event, data: emitted.append((event, data)))
            bridge._on_globalpose(ActualGlobalPose(), "/vehicle_2/globalpose")

        self.assertEqual(emitted[-1][1]["topic"], "/vehicle_2/globalpose")


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

    async def test_multiple_region_topics_can_publish_concurrently(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            test_state = GatewayState(make_settings(Path(temp_dir)), EventHub())
            original_state, original_hub = app_module.state, app_module.hub
            app_module.state, app_module.hub = test_state, EventHub()
            region_one = {
                "id": "region-one",
                "name": "REGION-ONE",
                "shape": "rectangle",
                "bbox": {
                    "topLeft": {"latitude": 31.2, "longitude": 121.4},
                    "bottomRight": {"latitude": 31.1, "longitude": 121.5},
                },
            }
            region_two = {
                "id": "region-two",
                "name": "REGION-TWO",
                "shape": "rectangle",
                "bbox": {
                    "topLeft": {"latitude": 30.2, "longitude": 120.4},
                    "bottomRight": {"latitude": 30.1, "longitude": 120.5},
                },
            }
            try:
                first = await app_module.start_publishing(
                    {"topic": "/region/one", "flag": "GPS_FLAG", "rateHz": 2, "region": region_one}
                )
                second = await app_module.start_publishing(
                    {"topic": "/region/two", "flag": "MATCH_FLAG", "rateHz": 5, "region": region_two}
                )
                stopped = await app_module.stop_publishing(
                    {"publicationId": first["publishing"]["id"]}
                )
                stopped_all = await app_module.stop_publishing({})
            finally:
                app_module.state, app_module.hub = original_state, original_hub

            self.assertEqual(len(second["publications"]), 2)
            self.assertEqual(
                {publication["topic"] for publication in second["publications"]},
                {"/region/one", "/region/two"},
            )
            self.assertEqual(len(stopped["publications"]), 1)
            self.assertEqual(stopped["publications"][0]["topic"], "/region/two")
            self.assertEqual(stopped_all["publications"], [])

    async def test_region_publish_rate_defaults_and_clamps_to_50_hz(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            test_state = GatewayState(make_settings(Path(temp_dir)), EventHub())
            original_state, original_hub = app_module.state, app_module.hub
            app_module.state, app_module.hub = test_state, EventHub()
            region = {
                "id": "rate-region",
                "name": "RATE-REGION",
                "shape": "rectangle",
                "bbox": {
                    "topLeft": {"latitude": 31.2, "longitude": 121.4},
                    "bottomRight": {"latitude": 31.1, "longitude": 121.5},
                },
            }
            try:
                default_rate = await app_module.start_publishing(
                    {"topic": "/region/rate", "flag": "GPS_FLAG", "region": region}
                )
                clamped_rate = await app_module.start_publishing(
                    {"topic": "/region/rate", "flag": "GPS_FLAG", "rateHz": 500, "region": region}
                )
            finally:
                app_module.state, app_module.hub = original_state, original_hub

            self.assertEqual(default_rate["publishing"]["rateHz"], 50.0)
            self.assertEqual(clamped_rate["publishing"]["rateHz"], 50.0)

    async def test_region_scheduler_services_all_due_publications(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            test_state = GatewayState(make_settings(Path(temp_dir)), EventHub())
            original_state, original_hub = app_module.state, app_module.hub
            app_module.state, app_module.hub = test_state, EventHub()
            calls = []
            test_state.ros.publish_region = lambda topic, flag, region: (
                calls.append((topic, flag, region["id"]))
                or {"simulated": True, "connections": 1}
            )
            region = {
                "name": "SCHEDULER",
                "shape": "rectangle",
                "bbox": {
                    "topLeft": {"latitude": 31.2, "longitude": 121.4},
                    "bottomRight": {"latitude": 31.1, "longitude": 121.5},
                },
            }
            try:
                await app_module.start_publishing(
                    {"topic": "/region/one", "flag": "GPS_FLAG", "rateHz": 50, "region": {**region, "id": "one"}}
                )
                await app_module.start_publishing(
                    {"topic": "/region/two", "flag": "DR_FLAG", "rateHz": 50, "region": {**region, "id": "two"}}
                )
                scheduler = asyncio.create_task(app_module.region_publish_loop())
                await asyncio.sleep(0.08)
                scheduler.cancel()
                await asyncio.gather(scheduler, return_exceptions=True)
            finally:
                app_module.state, app_module.hub = original_state, original_hub

            self.assertIn(("/region/one", "GPS_FLAG", "one"), calls)
            self.assertIn(("/region/two", "DR_FLAG", "two"), calls)
            self.assertGreaterEqual(sum(call[0] == "/region/one" for call in calls), 2)
            self.assertGreaterEqual(sum(call[0] == "/region/two" for call in calls), 2)


if __name__ == "__main__":
    unittest.main()
