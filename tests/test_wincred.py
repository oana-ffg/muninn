import importlib.util
import io
import json
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "muninn_wincred", Path(__file__).resolve().parents[1] / "scripts/muninn_wincred.py"
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class FakeBackend:
    def __init__(self):
        self.entries = {}

    def read(self, target):
        if target not in self.entries:
            raise mod.ProviderError(
                mod._win32_error_message("read", target, mod.ERROR_NOT_FOUND)
            )
        return self.entries[target]["payload"]

    def write(self, target, username, payload_utf8):
        # Exercise the real UTF-16LE size/encoding round trip on every platform.
        blob = mod.encode_utf16le(payload_utf8)
        self.entries[target] = {
            "username": username,
            "payload": mod.decode_utf16le(blob),
        }


class WinCredProviderTests(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.sample = {
            "origin": "https://muninn.example.test",
            "gateway_token": "gw-secret-value",
            "app_token": "app-secret-value",
        }

    def _run(self, argv, stdin_bytes=b""):
        args = mod.build_parser().parse_args(argv)
        out = io.BytesIO()
        mod.run(args, backend=self.backend, stdin_stream=io.BytesIO(stdin_bytes), stdout_stream=out)
        return out.getvalue()

    def test_set_check_get_round_trip(self):
        stored = json.loads(
            self._run(["set"], json.dumps({**self.sample, "extra": "ignored"}).encode("utf-8"))
        )
        self.assertEqual(
            stored,
            {
                "status": "stored",
                "target": mod.DEFAULT_TARGET,
                "origin": self.sample["origin"],
            },
        )
        self.assertNotIn("gw-secret-value", json.dumps(stored))

        checked = json.loads(self._run(["check"]))
        self.assertEqual(
            checked,
            {
                "configured": True,
                "target": mod.DEFAULT_TARGET,
                "origin": self.sample["origin"],
            },
        )
        self.assertNotIn("app-secret-value", json.dumps(checked))

        raw = self._run(["get"])
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(json.loads(raw), self.sample)

    def test_custom_target_and_username(self):
        self._run(
            ["--target", "Custom.Muninn", "set", "--username", "Custom User"],
            json.dumps(self.sample).encode("utf-8"),
        )
        self.assertEqual(self.backend.entries["Custom.Muninn"]["username"], "Custom User")
        self.assertEqual(json.loads(self._run(["--target", "Custom.Muninn", "get"])), self.sample)

    def test_rejects_bad_origin(self):
        bad = {**self.sample, "origin": "https://muninn.example.test/extra"}
        with self.assertRaises(mod.ProviderError):
            self._run(["set"], json.dumps(bad).encode("utf-8"))

        http_only = {**self.sample, "origin": "http://muninn.example.test"}
        with self.assertRaises(mod.ProviderError):
            self._run(["set"], json.dumps(http_only).encode("utf-8"))

    def test_rejects_missing_fields_without_echoing_secrets(self):
        raw = json.dumps({"origin": self.sample["origin"], "gateway_token": "leak-me"}).encode("utf-8")
        with self.assertRaises(mod.ProviderError) as ctx:
            self._run(["set"], raw)
        self.assertNotIn("leak-me", str(ctx.exception))

    def test_rejects_malformed_json_without_echoing_input(self):
        with self.assertRaises(mod.ProviderError) as ctx:
            self._run(["set"], b'{"app_token": "super-secret-broken')
        self.assertNotIn("super-secret-broken", str(ctx.exception))

    def test_rejects_oversized_utf16le_blob(self):
        oversized = {**self.sample, "app_token": "a" * 1300}
        with self.assertRaises(mod.ProviderError):
            self._run(["set"], json.dumps(oversized).encode("utf-8"))

    def test_accepts_utf8_bom_on_set_and_strips_on_get(self):
        bom_input = b"\xef\xbb\xbf" + json.dumps(self.sample).encode("utf-8")
        stored = json.loads(self._run(["set"], bom_input))
        self.assertEqual(stored["status"], "stored")
        raw = self._run(["get"])
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(json.loads(raw), self.sample)

    def test_error_messages_distinguish_not_found_and_logon_session(self):
        self.assertIn(
            "was not found",
            mod._win32_error_message("read", "Muninn.PhotoRelay", mod.ERROR_NOT_FOUND),
        )
        self.assertIn(
            "1312",
            mod._win32_error_message(
                "read", "Muninn.PhotoRelay", mod.ERROR_NO_SUCH_LOGON_SESSION
            ),
        )


if __name__ == "__main__":
    unittest.main()
