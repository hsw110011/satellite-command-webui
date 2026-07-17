import unittest
from pathlib import Path


class FrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1]
        cls.app_js = (cls.root / "public" / "app.js").read_text(encoding="utf-8")
        cls.index_html = (cls.root / "public" / "index.html").read_text(encoding="utf-8")
        cls.styles = (cls.root / "public" / "styles.css").read_text(encoding="utf-8")
        cls.backend = (cls.root / "ros_backend" / "app.py").read_text(encoding="utf-8")

    def test_side_navigation_does_not_scroll_the_page(self) -> None:
        self.assertNotIn("scrollIntoView", self.app_js)
        self.assertIn('sidePanel.scrollTo({ top:', self.app_js)
        self.assertIn("window.scrollTo(0, 0)", self.app_js)
        self.assertIn("position: fixed;", self.styles)
        self.assertIn("overscroll-behavior: none;", self.styles)

    def test_static_assets_are_versioned_and_not_cached(self) -> None:
        self.assertIn("styles.css?v=", self.index_html)
        self.assertIn("app.js?v=", self.index_html)
        self.assertIn('"Cache-Control"] = "no-store, no-cache', self.backend)

    def test_maps_and_operator_preferences_are_restored(self) -> None:
        self.assertIn('fetch("/api/maps/status"', self.app_js)
        self.assertIn("UI_PREFERENCES_KEY", self.app_js)
        self.assertIn("localStorage.setItem", self.app_js)
        self.assertIn("restorePersistedMaps", self.app_js)

    def test_large_map_tile_requests_are_bounded_and_stale_loads_are_cancelled(self) -> None:
        self.assertRegex(self.app_js, r"const MAX_VISIBLE_TILES = (?:9[6-9]|1[0-3][0-9]|14[0-4]);")
        self.assertIn("const DEFAULT_CACHED_TILE_NODES = 192;", self.app_js)
        self.assertIn("cancelStalePendingTiles(source, wantedKeys);", self.app_js)
        self.assertIn('node.removeAttribute("src")', self.app_js)
        self.assertIn("const wheelZoomState", self.app_js)
        self.assertIn("wheel.frame = requestAnimationFrame", self.app_js)

    def test_map_cannot_zoom_or_pan_outside_the_visible_full_extent(self) -> None:
        self.assertIn("constrainViewToViewport(kind);", self.app_js)
        self.assertIn("view.scale = clamp(nextScale, getFitScale(kind), MAX_MAP_SCALE);", self.app_js)
        self.assertIn("renderedWidth <= rect.width", self.app_js)
        self.assertIn("renderedHeight <= rect.height", self.app_js)

    def test_large_map_keeps_a_bounded_overview_behind_native_tiles(self) -> None:
        self.assertIn('overview.className = "map-image geotiff-overview";', self.app_js)
        self.assertIn("full.png?max_dim=2048", self.app_js)
        self.assertNotIn("will-change: transform;", self.styles)

    def test_trajectory_and_regions_use_solid_high_visibility_styles(self) -> None:
        self.assertIn("const REGION_PALETTE", self.app_js)
        self.assertIn("color: visual.stroke", self.app_js)
        self.assertIn('shape.setAttribute("class", selected ? "region-shape region-shape-selected"', self.app_js)
        self.assertIn("vector-effect: non-scaling-stroke;", self.styles)
        self.assertIn("--trajectory-color: #000;", self.styles)
        self.assertIn("--trajectory-width: 50px;", self.styles)
        self.assertIn('nodes.trail.style.strokeWidth = "var(--trajectory-width)";', self.app_js)
        trajectory_block = self.styles.split(".vector-layer .trajectory-trail", 1)[1].split("}", 1)[0]
        self.assertNotIn("stroke-dasharray", trajectory_block)

    def test_multiple_globalpose_topics_render_as_independent_tracks(self) -> None:
        self.assertIn("const trajectoryNodes = { dom: new Map(), dsm: new Map() };", self.app_js)
        self.assertIn("const topic = sample.topic || primaryTrajectoryTopic();", self.app_js)
        self.assertIn("if (!grouped.has(topic)) grouped.set(topic, []);", self.app_js)
        self.assertIn("ensureTrajectoryTopicNodes(kind, layer, topic)", self.app_js)
        self.assertIn('id="domTrajectoryLegend"', self.index_html)
        self.assertIn('id="dsmTrajectoryLegend"', self.index_html)
        self.assertIn(".trajectory-legend", self.styles)

    def test_region_publications_can_be_managed_concurrently(self) -> None:
        self.assertIn('id="publicationList"', self.index_html)
        self.assertIn("state.publications", self.app_js)
        self.assertIn("renderPublicationList()", self.app_js)
        self.assertIn('stopPublishing(publication.id)', self.app_js)
        self.assertIn(".publication-item", self.styles)
        self.assertIn("rateHz: 50", self.app_js)
        self.assertNotIn("elements.publishButton.disabled = active;", self.app_js)


if __name__ == "__main__":
    unittest.main()
