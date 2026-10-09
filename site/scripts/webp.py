"""Convert the rendered tower-only PNGs to WebP and drop the intermediates.
Usage: python -I scripts/webp.py public/catalog"""
import glob, os, sys
from PIL import Image
d = sys.argv[1]
for f in glob.glob(os.path.join(d, "*-t.png")):
    Image.open(f).save(f[:-4] + ".webp", "WEBP", quality=82, method=6)
    os.remove(f)
for f in glob.glob(os.path.join(d, "*-t.svg")):
    os.remove(f)
