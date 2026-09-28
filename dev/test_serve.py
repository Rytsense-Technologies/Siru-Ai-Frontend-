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

    def test_dotfiles_and_dev_files_are_never_served(self):
        for path in ("/.git/config", "/.env", "/.env.example", "/dev/serve.py", "/%2Egit/config", "/images/../.gitignore"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path).status, 404)


if __name__ == "__main__":
    unittest.main()
