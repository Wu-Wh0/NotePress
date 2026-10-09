import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import runtime_paths


class PortableRuntimeResolverTests(unittest.TestCase):
    def test_explicit_node_and_runtime_paths_override_discovery(self):
        with tempfile.TemporaryDirectory(prefix="portable-paths-") as tmp:
            root = Path(tmp)
            node = root / "node"
            node.write_text("synthetic executable", encoding="utf-8")
            parser = root / "parser"
            modules = root / "modules"
            core = root / "core"
            for directory in (parser, modules, core):
                directory.mkdir()
            (core / "wp-includes").mkdir()
            (core / "wp-includes" / "version.php").write_text("$wp_version = '7.1.2';\\n", encoding="utf-8")
            with patch("subprocess.run", return_value=type("Completed", (), {"stdout": "v24.21.0"})()):
                with patch.dict(os.environ, {
                    "PUBLICATION_NODE": str(node),
                    "PUBLICATION_PARSER_ROOT": str(parser),
                    "PUBLICATION_PHP_WASM_MODULES": str(modules),
                    "PUBLICATION_WP_CORE": str(core),
                    "PATH": "",
                }, clear=False):
                    self.assertEqual(runtime_paths.node_binary(), node)
                    self.assertEqual(runtime_paths.parser_root(), parser)
                    self.assertEqual(runtime_paths.php_wasm_modules(), modules)
                    self.assertEqual(runtime_paths.wordpress_core(), core)

    def test_node_override_rejects_an_unpinned_runtime_version(self):
        with tempfile.TemporaryDirectory(prefix="portable-node-version-") as tmp:
            node = Path(tmp) / "node"
            node.write_text("synthetic executable", encoding="utf-8")
            with patch.dict(os.environ, {"PUBLICATION_NODE": str(node)}, clear=False):
                with patch("subprocess.run", return_value=type("Completed", (), {"stdout": "v22.22.1\\n"})()):
                    with self.assertRaisesRegex(RuntimeError, "v24.21.0"):
                        runtime_paths.node_binary()

    def test_missing_node_is_reported_without_private_cache_fallback(self):
        with patch.dict(os.environ, {"PATH": ""}, clear=False):
            os.environ.pop("PUBLICATION_NODE", None)
            with self.assertRaisesRegex(RuntimeError, "PUBLICATION_NODE"):
                runtime_paths.node_binary()

    def test_wordpress_core_override_requires_the_locked_release(self):
        with tempfile.TemporaryDirectory(prefix="portable-wp-version-") as tmp:
            core = Path(tmp) / "core"
            (core / "wp-includes").mkdir(parents=True)
            (core / "wp-includes" / "version.php").write_text("$wp_version = '7.1.1';\\n", encoding="utf-8")
            with patch.dict(os.environ, {"PUBLICATION_WP_CORE": str(core)}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "7.1.2"):
                    runtime_paths.wordpress_core()

    def test_symlinked_runtime_roots_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="portable-links-") as tmp:
            root = Path(tmp)
            actual = root / "actual"
            actual.mkdir()
            link = root / "link"
            link.symlink_to(actual, target_is_directory=True)
            with patch.dict(os.environ, {"PUBLICATION_PARSER_ROOT": str(link)}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "PUBLICATION_PARSER_ROOT"):
                    runtime_paths.parser_root()


if __name__ == "__main__":
    unittest.main()
