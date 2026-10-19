"""1:1 vector redraw of the product schemes for the product catalogue (masts, lightning rods,
portals, contact-network supports, pile-foundation parts, 0.4–35 kV hardware).

Same method as scripts/trace.py, tuned to these source schemes: lines and figures are dark
blue, some elements are red, the watermark is neutral grey. The scheme is split into layers by
colour, the grey watermark and the paper are dropped, each layer is traced with potrace at 3x
into filled vector outlines (geometry and every dimension stay as drawn) and re-coloured in the
site palette. The source images stay in research/ and are never shipped.

Usage: python -I scripts/trace_items.py <src_dir> <out_dir> <name> [<name> ...]
  <name> is a source file name in <src_dir>; writes <out_dir>/<stem>.svg and prints
  "<name> <w> <h> <x0> <y0> <x1> <y1>" (the drawing size and the box of the ink inside it).
"""
import os
import sys

import numpy as np
import potrace
from PIL import Image, ImageFilter
from scipy import ndimage

K = 3
RUN = 18  # px: shortest straight grey run that counts as a drawing line
SPECK = 90  # px at 3x: smaller isolated blobs are watermark residue (a dot of a digit is larger)
INK = "#1C2226"
ACCENT = "#4F6E88"


def layers(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    # lines and figures: blue-tinted and dark; the watermark is neutral (r≈g≈b) and light
    blue = np.clip((b - r - 6) / 10, 0, 1) * np.clip((228 - lum) / 40, 0, 1)
    # plain dark ink (some schemes are drawn in black)
    dark = np.clip((120 - lum) / 40, 0, 1)
    red = np.clip((r - g - 50) / 30, 0, 1) * np.clip((r - b - 50) / 30, 0, 1)
    # some thin dimension lines are drawn neutral grey, like the watermark; they are told apart
    # by shape: only long straight vertical/horizontal runs are kept (watermark letters are short)
    grey = (lum < 175) & (a.max(-1) - a.min(-1) < 24)
    runs = ndimage.binary_opening(grey, structure=np.ones((RUN, 1))) | ndimage.binary_opening(grey, structure=np.ones((1, RUN)))
    lines = runs * np.clip((200 - lum) / 50, 0, 1)
    # thin (1–2 px) light lines and figures: a black top-hat keeps dark features narrower than
    # 3 px; the watermark strokes are wider and drop out
    thin = ndimage.grey_closing(lum, size=(3, 3)) - lum
    fine = np.clip((thin - 22) / 25, 0, 1) * np.clip((215 - lum) / 40, 0, 1)
    return im.size, np.maximum.reduce([blue, dark, lines, fine]), red


def upscale(cov, thr=118):
    img = Image.fromarray((cov * 255).astype(np.uint8))
    img = img.resize((img.width * K, img.height * K), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
    return np.asarray(img) > thr


def path_d(mask, scale=1.0 / K):
    if not mask.any():
        return ""
    bm = potrace.Bitmap(~mask)
    plist = bm.trace(turdsize=6, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY, alphamax=0.6, opticurve=True, opttolerance=0.35)
    out = []
    f = lambda p: f"{p.x * scale:.1f} {p.y * scale:.1f}".replace(".0 ", " ")
    for curve in plist:
        out.append(f"M{f(curve.start_point)}")
        for seg in curve.segments:
            if seg.is_corner:
                out.append(f"L{f(seg.c)}L{f(seg.end_point)}")
            else:
                out.append(f"C{f(seg.c1)} {f(seg.c2)} {f(seg.end_point)}")
        out.append("Z")
    return "".join(out)


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for name in sys.argv[3:]:
        (w, h), ink, red = layers(os.path.join(src, name))
        # thin 1 px dimension lines are faint after JPEG compression: a low threshold keeps them
        im, rm = upscale(ink, 70), upscale(red, 90)
        # watermark edges leave tiny isolated specks: drop components far smaller than a digit
        lab, n = ndimage.label(im, structure=np.ones((3, 3)))
        if n:
            sizes = ndimage.sum(im, lab, range(1, n + 1))
            im = np.isin(lab, 1 + np.where(sizes >= SPECK)[0])
        both = im | rm
        if not both.any():
            print(name, "EMPTY", flush=True)
            continue
        ys, xs = np.where(both)
        x0, y0, x1, y1 = xs.min() / K, ys.min() / K, (xs.max() + 1) / K, (ys.max() + 1) / K
        # crop to the ink with a small margin: the source pages pad the scheme generously
        pad = 12
        vx, vy = max(0, x0 - pad), max(0, y0 - pad)
        vw, vh = min(w, x1 + pad) - vx, min(h, y1 + pad) - vy
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vx:.0f} {vy:.0f} {vw:.0f} {vh:.0f}" width="{vw:.0f}" height="{vh:.0f}">'
            f'<path fill="{ACCENT}" d="{path_d(rm)}"/><path fill="{INK}" d="{path_d(im)}"/></svg>'
        )
        stem = os.path.splitext(name)[0]
        open(os.path.join(out, stem + ".svg"), "w", encoding="utf-8").write(svg)
        print(name, round(vw), round(vh), flush=True)


if __name__ == "__main__":
    main()
