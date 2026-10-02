"""The local development server (dev/serve.py). Standard library only:

    python -m unittest discover -s dev -p "test_*.py"
"""
from __future__ import annotations

import functools
import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer

import serve


class ServeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(serve.NoCacheHandler, directory=str(serve.FRONTEND))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        conn.request("GET", path)
        response = conn.getresponse()
        response.read()
        conn.close()
        return response

    def test_the_site_is_served_with_no_cache(self):
        response = self.get("/index.html")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Cache-Control"), "no-cache")
        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")

    def test_the_public_config_is_served(self):
        self.assertEqual(self.get("/config.js").status, 200)

    def test_the_committed_config_names_the_production_backend_and_is_never_rewritten(self):
        committed = (serve.FRONTEND / "config.js").read_text(encoding="utf-8")
        self.assertIn("apiBaseUrl: 'https://", committed)

    def test_locally_config_js_is_the_local_backend_unless_told_otherwise(self):
        local = serve.local_config("").decode("utf-8")
        self.assertIn('apiBaseUrl: "",', local)
        self.assertIn('apiBaseUrl: "http://192.168.1.10:8010",', serve.local_config("http://192.168.1.10:8010").decode())
        serve.NoCacheHandler.config_js = serve.local_config("")
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
            conn.request("GET", "/config.js?v=57")
            response = conn.getresponse()
            body = response.read().decode("utf-8")
            conn.close()
        finally:
            serve.NoCacheHandler.config_js = None
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Cache-Control"), "no-cache")
        self.assertIn('apiBaseUrl: "",', body)
        self.assertNotIn("https://", body)

    def test_dotfiles_and_dev_files_are_never_served(self):
        for path in ("/.git/config", "/.env", "/.env.example", "/dev/serve.py", "/%2Egit/config", "/images/../.gitignore"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path).status, 404)


if __name__ == "__main__":
    unittest.main()
