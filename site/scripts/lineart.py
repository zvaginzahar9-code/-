"""Line drawing of a product from its photo or 3D render (when the source has no scheme).

The product is separated from the background and the light grey watermark (by tone and colour),
then its outline and the edges inside it (difference of Gaussians on the luminance) are kept as
black lines on white. The result is an ordinary black-and-white image that scripts/trace_items.py
redraws into vector like any scheme. Only what is in the picture is drawn; nothing is added.

Usage: python -I scripts/lineart.py <src_dir> <name> [<name> ...]
  writes <src_dir>/<stem>-lines.png next to each source image
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def flat(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        im = Image.alpha_composite(Image.new("RGBA", im.size, (255, 255, 255, 255)), im)
    return np.asarray(im.convert("RGB")).astype(np.float32)


def lines(a):
    lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    sat = a.max(-1) - a.min(-1)
    # the product: darker than the watermark or coloured; the watermark is light and neutral.
    # Without a watermark (a render on pure white) anything clearly off-white is the product.
    # the watermark is tiled over the whole picture, the product sits in the middle: look at the margins
    grey = (lum > 180) & (lum < 222) & (sat < 12)
    h, w = lum.shape
    m = max(4, int(min(h, w) * 0.08))
    frame = np.concatenate([grey[:m].ravel(), grey[-m:].ravel(), grey[:, :m].ravel(), grey[:, -m:].ravel()])
    watermark = frame.mean() > 0.02
    obj = ((lum < 168) | (sat > 28)) if watermark else ((ndimage.gaussian_filter(lum, 2.5) < 252.5) | (sat > 18))
    obj = ndimage.binary_opening(obj, iterations=1)
    obj = ndimage.binary_closing(obj, iterations=6)
    obj = ndimage.binary_fill_holes(obj)
    lab, n = ndimage.label(obj)
    if n:
        sizes = ndimage.sum(obj, lab, range(1, n + 1))
        obj = np.isin(lab, 1 + np.where(sizes >= max(400, sizes.max() * 0.02))[0])
    # edges inside the product: difference of Gaussians (tone changes = edges of faces)
    g1 = ndimage.gaussian_filter(lum, 1.0)
    g2 = ndimage.gaussian_filter(lum, 2.2)
    dog = g2 - g1  # positive on the dark side of an edge
    inner = (dog > 4.5) & ndimage.binary_dilation(obj, iterations=2)
    # the outline of the product
    outline = obj & ~ndimage.binary_erosion(obj, iterations=2)
    ink = inner | outline
    ink = ndimage.binary_opening(ink, structure=np.ones((2, 2))) | outline
    lab, n = ndimage.label(ink, structure=np.ones((3, 3)))
    if n:
        sizes = ndimage.sum(ink, lab, range(1, n + 1))
        ink = np.isin(lab, 1 + np.where(sizes >= 25)[0])
    out = np.full(lum.shape, 255, np.uint8)
    out[ink] = 20
    return out


def main():
    src = sys.argv[1]
    for name in sys.argv[2:]:
        img = lines(flat(os.path.join(src, name)))
        dst = os.path.join(src, os.path.splitext(name)[0] + "-lines.png")
        Image.fromarray(img).save(dst)
        print(name, "->", os.path.basename(dst), flush=True)


if __name__ == "__main__":
    main()
