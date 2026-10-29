"""Screenshot the app in headless Edge: python tests/shot.py out.png "qa&preset=sandy&t=15840" [w h budget_ms]"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import screenshot  # noqa: E402

out, query = sys.argv[1], sys.argv[2]
w = int(sys.argv[3]) if len(sys.argv) > 3 else 1600
h = int(sys.argv[4]) if len(sys.argv) > 4 else 1000
budget = int(sys.argv[5]) if len(sys.argv) > 5 else 20000
rc = screenshot(f"web/index.html?{query}", os.path.abspath(out), w, h, budget_ms=budget,
                extra_flags=("--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"))
print("exit", rc, os.path.exists(out) and os.path.getsize(out))
