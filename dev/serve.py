"""Local development server for this frontend - NOT used in production
(Vercel serves the files itself). Like `python -m http.server`, but every
response carries `Cache-Control: no-cache`: browsers revalidate each file
(a 304 when it hasn't changed), so an update to index.html or a script is
picked up on a normal reload - nobody needs a hard refresh.

    python dev/serve.py --bind 0.0.0.0 --port 5500

Dotfiles (.git, .env*) and dev/ itself are never served - the repository
root is the site root, and it may be opened to the LAN.
"""
from __future__ import annotations

import argparse
import functools
import http.server
from pathlib import Path
from urllib.parse import unquote, urlsplit

FRONTEND = Path(__file__).resolve().parent.parent


def is_private(url_path: str) -> bool:
    """A path that must not be served: a dotfile/dot-directory anywhere, or dev/."""
    parts = [p for p in unquote(urlsplit(url_path).path).replace("\\", "/").split("/") if p]
    return any(p.startswith(".") for p in parts) or (bool(parts) and parts[0] == "dev")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        if is_private(self.path):
            self.send_error(404, "File not found")
            return None
        return super().send_head()

    def end_headers(self) -> None:
        # Stored, but always checked with the server first (If-Modified-Since -> 304).
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--bind", default="127.0.0.1", help="address to listen on (0.0.0.0 = the LAN too)")
    parser.add_argument("--port", type=int, default=5500)
    args = parser.parse_args()
    handler = functools.partial(NoCacheHandler, directory=str(FRONTEND))
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"Serving {FRONTEND} on http://{args.bind}:{args.port} (Cache-Control: no-cache)")
        server.serve_forever()


if __name__ == "__main__":
    main()
