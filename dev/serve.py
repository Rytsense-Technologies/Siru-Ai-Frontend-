"""The server for this frontend (local only - there is no cloud deployment). Like `python -m http.server`, but every
response carries `Cache-Control: no-cache`: browsers revalidate each file
(a 304 when it hasn't changed), so an update to index.html or a script is
picked up on a normal reload - nobody needs a hard refresh.

    python dev/serve.py --bind 0.0.0.0 --port 5500

Dotfiles (.git, .env*) and dev/ itself are never served - the repository
root is the site root, and it may be opened to the LAN.

/config.js: the committed one names the production backend (what Vercel
serves). Locally this server answers it with the local backend instead -
apiBaseUrl '' = the "Server settings" address, else http://<this host>:8010
(app.js) - unless --api-base names another (a URL), or `--api-base committed`
serves the committed file as it is. The committed file is never changed.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import io
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit

FRONTEND = Path(__file__).resolve().parent.parent

# The page's Content-Security-Policy: only this site's own scripts (the
# LiveKit client is vendored under vendor/), no inline script, no plugins, no
# framing. connect-src: the local API (http://<host>:8010) and LiveKit
# (ws://127.0.0.1:8880) are plain http/ws on this machine or the LAN.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: blob:; "
       "media-src 'self' blob: mediastream:; connect-src 'self' http: https: ws: wss:; worker-src 'self' blob:; "
       "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
PERMISSIONS = "microphone=(self), geolocation=(self), camera=(), payment=(), usb=()"


# Development and test tooling - not part of the site .
_PRIVATE_DIRS = frozenset({"dev", "tests", "node_modules", "test-results", "playwright-report"})


def is_private(url_path: str) -> bool:
    """A path that must not be served: a dotfile/dot-directory anywhere, or a tooling directory."""
    parts = [p for p in unquote(urlsplit(url_path).path).replace("\\", "/").split("/") if p]
    return any(p.startswith(".") for p in parts) or (bool(parts) and parts[0] in _PRIVATE_DIRS)


def local_config(api_base: str) -> bytes:
    """The config.js this server answers with: the committed one's shape, the
    backend given here (no secret - every browser downloads it)."""
    return ("// Served by dev/serve.py for local development - not the committed config.js\n"
            "// (which names the production backend). apiBaseUrl '' = the \"Server settings\"\n"
            "// address, else http://<this host>:8010 - the local API (app.js).\n"
            f"window.SIRU_CONFIG = Object.freeze({{\n  apiBaseUrl: {json.dumps(api_base)},\n}});\n").encode("utf-8")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    # The local config.js body, or None to serve the committed file (main sets it).
    config_js: bytes | None = None

    def send_head(self):
        if is_private(self.path):
            self.send_error(404, "File not found")
            return None
        if self.config_js is not None and unquote(urlsplit(self.path).path) == "/config.js":
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(self.config_js)))
            self.end_headers()
            return io.BytesIO(self.config_js)
        return super().send_head()

    def end_headers(self) -> None:
        # Stored, but always checked with the server first (If-Modified-Since -> 304).
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Permissions-Policy", PERMISSIONS)
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    # The page loads ~17 files at once (more with parallel test workers). With
    # the default listen backlog (5), Windows refuses the overflow outright, so
    # random scripts fail to load; Linux queues them instead.
    request_queue_size = 128


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--bind", default="127.0.0.1", help="address to listen on (0.0.0.0 = the LAN too)")
    parser.add_argument("--port", type=int, default=5500)
    parser.add_argument("--api-base", default="",
                        help="the backend the page calls: '' (default) = the local API (http://<this host>:8010), "
                             "a URL, or 'committed' to serve config.js as committed (the production backend)")
    args = parser.parse_args()
    if args.api_base != "committed":
        if args.api_base and not args.api_base.startswith(("http://", "https://")):
            parser.error("--api-base must be '', an http(s):// URL or 'committed'")
        NoCacheHandler.config_js = local_config(args.api_base.rstrip("/"))
    handler = functools.partial(NoCacheHandler, directory=str(FRONTEND))
    with Server((args.bind, args.port), handler) as server:
        backend = ("config.js as committed" if args.api_base == "committed"
                   else args.api_base or "the local API (http://<this host>:8010)")
        print(f"Serving {FRONTEND} on http://{args.bind}:{args.port} (Cache-Control: no-cache) - backend: {backend}")
        server.serve_forever()


if __name__ == "__main__":
    main()
