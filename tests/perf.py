"""Real-time throughput of the GPU solver: wall time of headless runs with and
without a block of steps (the difference is the stepping cost). Virtual time
freezes the page clock, so the clock here is the wall clock of the process."""
import json
import os
import re
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import serve, _edge, PROFILE  # noqa: E402


def run(dx, n):
    httpd, port = serve()
    out = os.path.join(tempfile.gettempdir(), f"floodtwin_perf_{port}.html")
    try:
        t0 = time.time()
        _edge(["--headless=new", "--no-first-run", "--disable-extensions", f"--user-data-dir={PROFILE}", "--enable-gpu",
               "--use-angle=d3d11", "--ignore-gpu-blocklist", "--virtual-time-budget=600000", "--dump-dom",
               f"http://127.0.0.1:{port}/tests/perf.html?dx={dx}&n={n}"], out, 1200)
        wall = time.time() - t0
        html = open(out, encoding="utf-8", errors="replace").read()
        m = re.search(r'<pre id="out">(.*?)</pre>', html, re.S)
        return wall, json.loads(m.group(1))
    finally:
        httpd.shutdown()
        for f in (out, out + ".err"):
            if os.path.exists(f):
                os.remove(f)


for dx, n in [(4, 60000), (8, 60000), (2, 20000)]:
    w0, r0 = run(dx, 10)
    w1, r1 = run(dx, n)
    sec = max(1e-3, w1 - w0)
    print(f"   wall {w0:.1f} s (10 steps) vs {w1:.1f} s ({n} steps)")
    run_ = r1["runs"][0]
    print(f"{dx} m: {run_['cells']:,} cells, {n} steps in {sec:.1f} s -> {n / sec:,.0f} steps/s, mean dt {run_['meanDt']} s, "
          f"about {n * run_['meanDt'] / sec:,.0f}x real time  ({r1['gpu']})")
