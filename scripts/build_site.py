"""Copy the static site in web/ to docs/ for GitHub Pages."""
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, DST = os.path.join(ROOT, "web"), os.path.join(ROOT, "docs")

if os.path.exists(DST):
    shutil.rmtree(DST)
shutil.copytree(SRC, DST)
open(os.path.join(DST, ".nojekyll"), "w").close()
n = sum(len(f) for _, _, f in os.walk(DST))
size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(DST) for f in fs)
print(f"docs/: {n} files, {size / 1e6:.1f} MB")
