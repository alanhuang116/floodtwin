"""Load a page headlessly and print the browser console (syntax and import errors included)."""
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import serve, _edge, PROFILE  # noqa: E402

path = sys.argv[1]
budget = int(sys.argv[2]) if len(sys.argv) > 2 else 20000
httpd, port = serve()
out = os.path.join(tempfile.gettempdir(), f"floodtwin_console_{port}.html")
try:
    _edge(["--headless=new", "--no-first-run", "--disable-extensions", f"--user-data-dir={PROFILE}",
           "--enable-logging=stderr", "--v=0", "--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist",
           f"--virtual-time-budget={budget}", "--dump-dom", f"http://127.0.0.1:{port}/{path}"], out, 900)
    err = open(out + ".err", encoding="utf-8", errors="replace").read()
    for line in err.splitlines():
        if ("CONSOLE" in line or "Uncaught" in line or "ERROR" in line or "FATAL" in line or "lost" in line.lower() or "WARNING" in line) and "task_manager" not in line and "get_updates" not in line and "sync" not in line:
            print(line[:1500])
    html = open(out, encoding="utf-8", errors="replace").read()
    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', html, re.S)
    print("OUT:", (m.group(1)[:3000] if m else None))
finally:
    httpd.shutdown()
    for f in (out, out + ".err"):
        if os.path.exists(f):
            os.remove(f)
