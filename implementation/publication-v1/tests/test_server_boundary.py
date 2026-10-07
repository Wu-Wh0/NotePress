"""Static source-boundary contract for the isolated publication-v1 server candidate."""
from __future__ import annotations

import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
ENTRY = SERVER / "publication-v1.php"
MODULES = ("support.php", "resources.php", "workflow.php")
FORBIDDEN_PRODUCT_MARKERS = (
    "wp_is_application_passwords_available",
    "WP_Application_Passwords",
    "b11fault",
    "after_commit_503",
    "loopback_only",
    "fixture_closed",
    "test-recovery",
    "producer-vault",
)


def product_php() -> dict[str, str]:
    files = sorted(SERVER.glob("*.php"))
    return {path.name: path.read_text(encoding="utf-8") for path in files}


class PublicationV1SourceBoundaryTests(unittest.TestCase):
    def test_one_entry_loads_only_explicit_product_modules(self) -> None:
        self.assertTrue(ENTRY.is_file(), "missing single WordPress plugin entry")
        sources = product_php()
        self.assertEqual(set(sources), {ENTRY.name, *MODULES})
        entry = sources[ENTRY.name]
        loaded = re.findall(r"require_once\s+__DIR__\s*\.\s*'([^']+)'", entry)
        self.assertEqual(loaded, ["/support.php", "/resources.php", "/workflow.php"])
        self.assertNotRegex(entry, r"glob\s*\(|scandir\s*\(|require\s+.+\*|include\s+.+\*")

    def test_product_code_excludes_fixture_credentials_and_fault_hooks(self) -> None:
        sources = product_php()
        self.assertTrue(sources, "product server directory is missing")
        combined = "\n".join(sources.values())
        for marker in FORBIDDEN_PRODUCT_MARKERS:
            with self.subTest(marker=marker):
                self.assertNotIn(marker, combined)
        self.assertFalse(any(name.lower().startswith("test-") for name in sources))

    def test_private_store_and_renderer_pin_fail_closed(self) -> None:
        combined = "\n".join(product_php().values())
        for marker in (
            "BLOG_V1_STORE",
            "BLOG_V1_COMPILER_SHA256",
            "publication-v1",
            "is_link(",
            "realpath(",
            "DOCUMENT_ROOT",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, combined)
        self.assertRegex(combined, r"BLOG_V1_COMPILER_SHA256.{0,500}hash_equals|hash_equals.{0,500}BLOG_V1_COMPILER_SHA256")

    def test_reviewer_approval_uses_native_cookie_nonce_and_separation(self) -> None:
        combined = "\n".join(product_php().values())
        for marker in (
            "wp_validate_auth_cookie",
            "wp_verify_nonce",
            "wp_create_nonce",
            "approve_publication_v1",
            "publisher_id",
            "reviewer_id",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, combined)
        self.assertRegex(combined, r"reviewer_id.{0,240}(?:!==|!=).{0,80}publisher_id|publisher_id.{0,240}(?:!==|!=).{0,80}reviewer_id|if\s*\(\s*\$reviewer_id\s*===\s*\$publisher_id\s*\)")
        self.assertRegex(combined, r"decision.{0,300}approve|approve.{0,300}decision")

    def test_owner_scoped_state_uses_compare_and_swap_and_only_inserts_new_posts(self) -> None:
        combined = "\n".join(product_php().values())
        for marker in ("publisher_id", "post_author", "wp_insert_post", "baseline_sha256", "target_id", "START TRANSACTION"):
            with self.subTest(marker=marker):
                self.assertIn(marker, combined)
        self.assertRegex(combined, r"option_value.{0,400}option_name.{0,400}option_value")
        self.assertNotIn("wp_update_post(", combined)
        self.assertNotIn("post_status' => 'draft'", combined)

    def test_pending_resources_are_private_and_public_bytes_are_hash_checked(self) -> None:
        combined = "\n".join(product_php().values())
        for marker in (
            "pending",
            "committed",
            "approve_publication_v1",
            "hash_file(",
            "sha256",
            "text/css",
            "font/woff2",
            "image/png",
            "X-Content-Type-Options",
            "Cache-Control",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, combined)
        self.assertRegex(combined, r"state.{0,500}committed|committed.{0,500}state")

    def test_manifest_contract_bounds_content_and_resource_inventory(self) -> None:
        combined = "\n".join(product_php().values())
        for marker in ("schema", "publication-v1", "inventory", "source_sha256", "labels_sha256", "selected", "compiler", "preview.html", "2000000", "65536"):
            with self.subTest(marker=marker):
                self.assertIn(marker, combined)
        self.assertRegex(combined, r"woff2.*woff.*ttf.*png|png.*woff2.*woff.*ttf")

    def test_stylesheet_dependencies_are_relative_and_inventory_bound(self) -> None:
        combined = "\n".join(product_php().values())
        for marker in ("pubv1_resolve_css_reference", "array_pop($resolved)", "stripos($css, '@import')", "isset($inventory[$resolved])"):
            with self.subTest(marker=marker):
                self.assertIn(marker, combined)

    def test_store_inventory_rejects_unmanifested_files(self) -> None:
        combined = "\n".join(product_php().values())
        for marker in ("RecursiveDirectoryIterator", "pubv1_inventory_directory_matches", "count($seen) === count($expected)"):
            with self.subTest(marker=marker):
                self.assertIn(marker, combined)

    def test_current_snapshot_must_match_its_stored_digest_before_refreezing(self) -> None:
        combined = "\n".join(product_php().values())
        self.assertIn("pubv1_snapshot_digest($record['snapshot'])", combined)
        self.assertRegex(combined, r"hash_equals\(\$record\['digest'\],\s*\(string\)\s*pubv1_snapshot_digest\(\$record\['snapshot'\]\)\)")

    def test_php_files_lint_when_php_is_available(self) -> None:
        php = shutil.which("php")
        if php is None:
            self.skipTest("PHP CLI is not installed; parent integration must lint in its PHP environment")
        files = sorted(SERVER.glob("*.php"))
        self.assertTrue(files, "no product PHP files to lint")
        for path in files:
            with self.subTest(file=path.name):
                result = subprocess.run([php, "-l", str(path)], capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
