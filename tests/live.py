"""Run the app in headless Edge in real time for a fixed wall-clock time, then
read the QA report. A test endpoint (/__delay) holds the page's load event open
so the DOM dump happens after the app has been running for that long.
python tests/live.py "qa&preset=sandy&run&frames=900" 30000"""
import functools
import http.server
import json
import os
import re
import socketserver
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import ROOT, _edge, PROFILE  # noqa: E402

GIF = bytes.fromhex("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b")


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/__delay"):
            ms = int(re.search(r"ms=(\d+)", self.path).group(1))
            time.sleep(ms / 1000)
            self.send_response(200); self.send_header("Content-Type", "image/gif"); self.end_headers(); self.wfile.write(GIF)
            return
        return super().do_GET()


q = sys.argv[1]
ms = int(sys.argv[2]) if len(sys.argv) > 2 else 25000
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Handler, directory=ROOT))
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
port = httpd.server_address[1]
out = os.path.join(tempfile.gettempdir(), f"floodtwin_live_{port}.html")
try:
    _edge(["--headless=new", "--no-first-run", "--disable-extensions", f"--user-data-dir={PROFILE}", "--enable-gpu",
           "--use-angle=d3d11", "--ignore-gpu-blocklist", "--window-size=1600,1000", "--dump-dom",
           f"http://127.0.0.1:{port}/web/index.html?{q}&hold={ms}"], out, 900)
    html = open(out, encoding="utf-8", errors="replace").read()
    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', html, re.S)
    txt = m.group(1).replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">") if m else ""
    try:
        j = json.loads(txt)
        keys = ["t", "status", "snaps", "series", "maxSteps", "frames", "wetKm2", "loss", "wet", "errors"]
        print(json.dumps({k: j.get(k) for k in keys}))
    except ValueError:
        print("report:", txt[:300])
finally:
    httpd.shutdown()
    for f in (out, out + ".err"):
        if os.path.exists(f):
            os.remove(f)
