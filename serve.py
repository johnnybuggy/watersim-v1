#!/usr/bin/env python3
"""WaterSim dev server with cross-origin isolation headers.

SharedArrayBuffer (required by the multithreaded solver) is only exposed to
pages that are cross-origin isolated. This static file server sends the two
headers Chrome/Firefox need:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

Run:  python3 serve.py [port]     (default 8080, serves the repo root)
Then open http://127.0.0.1:8080/ — the stats badge should read
"Physics: CPU · N threads".

`python3 -m http.server` alone will NOT work: without the headers the browser
denies SharedArrayBuffer and the app silently falls back to the serial path.
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class IsolatedRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # js assets are dev-cache-busted by URL; keep responses revalidatable
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), IsolatedRequestHandler)
    print(f"Serving {ROOT} at http://127.0.0.1:{PORT} (cross-origin isolated)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
