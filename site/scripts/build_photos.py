"""Crop the client's photos out of the presentation slides and give them one consistent grade.

Usage: python -I scripts/build_photos.py <research_dir> <site_dir>
"""
import os
import sys

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

RESEARCH, SITE = sys.argv[1], sys.argv[2]
SRC = os.path.join(RESEARCH, "pdf", "img")
OUT = os.path.join(SITE, "public", "photo")
os.makedirs(OUT, exist_ok=True)

CROPS = {
    # name: (file, box)
    "tower-winter": ("p05_1.jpeg", (290, 54, 779, 693)),
    "mast": ("p05_3.jpeg", (60, 56, 537, 524)),
    "foundations": ("p05_3.jpeg", (60, 756, 537, 1123)),
    "substation": ("p05_2.jpeg", (42, 42, 445, 506)),
    "steel-frame": ("p05_4.jpeg", (42, 44, 423, 444)),
    "arctic-line": ("p06_1.jpeg", (0, 0, 1108, 515)),
    "plasma": ("p06_1.jpeg", (166, 530, 553, 886)),
    "angle-line": ("p06_1.jpeg", (629, 529, 1016, 998)),
    "cnc-portal": ("p06_2.jpeg", None),
    "yard": ("p06_3.jpeg", None),
    "workshop": ("p06_4.jpeg", None),
    "hall": ("p06_5.jpeg", None),
}


def grade(im):
    """Cool, slightly desaturated, lifted blacks: makes mixed-source photos read as one set."""
    im = ImageEnhance.Color(im).enhance(0.72)
    im = ImageEnhance.Contrast(im).enhance(1.06)
    a = np.asarray(im).astype(np.float32) / 255
    a = 0.035 + a * 0.94  # lift blacks, soften whites
    tint = np.array([0.985, 1.0, 1.02])
    a = np.clip(a * tint, 0, 1)
    return Image.fromarray((a * 255).astype(np.uint8))


for name, (fn, box) in CROPS.items():
    im = Image.open(os.path.join(SRC, fn)).convert("RGB")
    if box:
        im = im.crop(box)
    im = grade(im)
    im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
    im.save(os.path.join(OUT, name + ".webp"), "WEBP", quality=84, method=6)
    im.save(os.path.join(OUT, name + ".jpg"), "JPEG", quality=84, optimize=True, progressive=True)
    print(name, im.size)
