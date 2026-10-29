"""Helpers to run a page of this repository in headless Edge over a local
HTTP server and read back a JSON result from an element.

Edge is started through PowerShell's Start-Process: launched directly from a
Python subprocess it exits without writing the DOM on this machine."""
from __future__ import annotations

import functools
import http.server
import json
import os
import re
import socketserver
import subprocess
import tempfile
import threading

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
# A private profile, so headless runs never hand off to an open Edge window.
PROFILE = os.path.join(os.environ.get("TEMP", ROOT), "floodtwin-edge-profile")


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def serve(root=ROOT):
    handler = functools.partial(_Quiet, directory=root)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def _edge(args, stdout_file, timeout):
    quoted = ",".join("'" + a.replace("'", "''") + "'" for a in args)
    ps = (f"$p = Start-Process -FilePath '{EDGE}' -ArgumentList @({quoted}) "
          f"-RedirectStandardOutput '{stdout_file}' -RedirectStandardError '{stdout_file}.err' "
          f"-Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode")
    return subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, timeout=timeout)


def run_page(path, element="out", budget_ms=60000, extra_flags=(), timeout=900):
    httpd, port = serve()
    out = os.path.join(tempfile.gettempdir(), f"floodtwin_dom_{port}.html")
    try:
        url = f"http://127.0.0.1:{port}/{path}"
        _edge(["--headless=new", "--no-first-run", "--disable-extensions", f"--user-data-dir={PROFILE}",
               f"--virtual-time-budget={budget_ms}", *extra_flags, "--dump-dom", url], out, timeout)
        html = open(out, encoding="utf-8", errors="replace").read()
        m = re.search(rf'<pre id="{element}">(.*?)</pre>', html, re.S)
        if not m:
            raise RuntimeError("no result element in DOM dump (" + str(len(html)) + " bytes)")
        txt = m.group(1).replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&amp;", "&")
        return json.loads(txt)
    finally:
        httpd.shutdown()
        for f in (out, out + ".err"):
            if os.path.exists(f):
                os.remove(f)


def screenshot(path, out_png, width=1600, height=1000, budget_ms=20000, timeout=600, extra_flags=()):
    httpd, port = serve()
    out = os.path.join(tempfile.gettempdir(), f"floodtwin_shot_{port}.txt")
    try:
        url = f"http://127.0.0.1:{port}/{path}"
        p = _edge(["--headless=new", "--no-first-run", "--disable-extensions", "--hide-scrollbars",
                   f"--user-data-dir={PROFILE}", f"--window-size={width},{height}",
                   f"--virtual-time-budget={budget_ms}", *extra_flags, f"--screenshot={out_png}", url], out, timeout)
        return p.returncode
    finally:
        httpd.shutdown()
        for f in (out, out + ".err"):
            if os.path.exists(f):
                os.remove(f)
