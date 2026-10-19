"""Convert rendered PNGs to WebP and drop the intermediates.
Usage: python -I scripts/webp.py public/catalog          (tower-only *-t.png; also drops *-t.svg)
       python -I scripts/webp.py public/products -s      (card previews *-s.png; the drawings stay)"""
import glob, os, sys
from PIL import Image
d = sys.argv[1]
suffix = sys.argv[2] if len(sys.argv) > 2 else "-t"
for f in glob.glob(os.path.join(d, f"*{suffix}.png")):
    Image.open(f).save(f[:-4] + ".webp", "WEBP", quality=82, method=6)
    os.remove(f)
if suffix == "-t":
    for f in glob.glob(os.path.join(d, "*-t.svg")):
        os.remove(f)
