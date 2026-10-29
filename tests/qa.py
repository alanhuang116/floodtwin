"""Load the app headlessly with a QA query and print the report (errors, timings, results).
python tests/qa.py "qa&preset=sandy&t=600" [budget_ms]"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import run_page  # noqa: E402

q = sys.argv[1]
budget = int(sys.argv[2]) if len(sys.argv) > 2 else 30000
r = run_page(f"web/index.html?{q}", budget_ms=budget,
             extra_flags=("--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"))
print(json.dumps(r, indent=1)[:6000])
