"""1:1 vector redraw of a tower scheme.

The scheme is split into layers by colour — black tower members, blue dimension graphics
(extension/dimension lines, arrows, figures, H/h/L letters); the light-grey watermark and the
paper background are dropped. Each layer is traced with potrace at 3x resolution into filled
vector outlines, so geometry, line weights and every dimension match the original exactly.
Colours are re-mapped to the site's palette.

Writes two files per tower:
  <slug>.svg      — the full drawing with all dimensions (product sheet)
  <slug>-t.svg    — the tower members only, cropped to the tower (lineup / compare)
Usage: python -I scripts/trace.py <catalog.json> <src_dir> <out_dir> [slug ...]
"""
import json
import os
import re
import sys

import numpy as np
import potrace
from PIL import Image, ImageFilter
from scipy import ndimage

K = 3  # upscale factor before tracing
INK = "#1C2226"
DIM = "#4F6E88"


def layers(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    sat = a.max(-1) - a.min(-1)
    # members are neutral grey/black (r≈g≈b); dimension graphics are tinted blue;
    # the watermark is neutral but very light and drops out by luminance
    tint = b - r
    member = np.clip((200 - lum) / 70, 0, 1) * np.clip((8 - tint) / 4, 0, 1) * (sat < 30)
    dim = np.clip((226 - lum) / 45, 0, 1) * np.clip((tint - 5) / 5, 0, 1)
    return im.size, member, dim


def upscale(cov, thr=118):
    img = Image.fromarray((cov * 255).astype(np.uint8))
    img = img.resize((img.width * K, img.height * K), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
    return np.asarray(img) > thr


def path_d(mask, scale=1.0 / K):
    bm = potrace.Bitmap(~mask)  # potracer traces the zero pixels
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


def bbox(mask):
    ys, xs = np.where(mask)
    return xs.min() / K, ys.min() / K, (xs.max() + 1) / K, (ys.max() + 1) / K


def main():
    cat, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
    only = set(sys.argv[4:])
    os.makedirs(out, exist_ok=True)
    items = json.load(open(cat, encoding="utf-8"))
    # source scheme per tower, from the research scrape (never shipped)
    raw = json.load(open(os.path.join(src, "..", "catalog.json"), encoding="utf-8"))
    srcmap = {re.sub(r"^\d+-", "", r["slug"]).replace("opora-", ""): r["images"][0] for r in raw}
    for it in items:
        if only and it["slug"] not in only:
            continue
        (w, h), member, dim = layers(os.path.join(src, srcmap[it["slug"]]))
        mm = upscale(member)
        dm = upscale(dim, 80)
        # the tower: largest connected structure of the member layer (drops stray specks)
        md = path_d(mm)
        dd = path_d(dm)
        # tower-only layer: the big connected structures, without stray figures and leaders
        # members are interrupted where blue dimension lines cross them: bridge those gaps
        # with the dimension pixels lying inside small member-to-member gaps
        # where a blue dimension line crosses a member the member pixels are tinted blue;
        # take back the blue pixels that sit right on a member line
        bridged = mm | (dm & ndimage.binary_dilation(mm, iterations=K))
        lab, n = ndimage.label(bridged, structure=np.ones((3, 3)))
        sizes = ndimage.sum(bridged, lab, range(1, n + 1))
        # the member layer holds only neutral (tower) pixels, so just drop tiny specks
        ok = 1 + np.where(sizes >= max(4 * K * K, sizes.sum() * 0.0005))[0]
        keep = np.isin(lab, ok)
        td = path_d(keep)
        x0, y0, x1, y1 = bbox(keep)
        full = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
            f'<path fill="{DIM}" d="{dd}"/><path fill="{INK}" d="{md}"/></svg>'
        )
        open(os.path.join(out, it["slug"] + ".svg"), "w", encoding="utf-8").write(full)
        pad = 1
        tw, th = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
        tower = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0 - pad:.1f} {y0 - pad:.1f} {tw:.1f} {th:.1f}" width="{tw:.0f}" height="{th:.0f}">'
            f'<path fill="{INK}" d="{td}"/></svg>'
        )
        open(os.path.join(out, it["slug"] + "-t.svg"), "w", encoding="utf-8").write(tower)
        it["svg"] = f"catalog/{it['slug']}.svg"
        it["svgTower"] = f"catalog/{it['slug']}-t.webp"  # rasterised from -t.svg (see README)
        it["draw"] = {"w": w, "h": h, "tower": [round(float(v), 1) for v in (x0, y0, x1, y1)]}
        json.dump({k: it[k] for k in ("svg", "svgTower", "draw")}, open(os.path.join(out, it["slug"] + ".json"), "w"))
        print(it["slug"], w, h, it["draw"]["tower"], flush=True)
    # merge per-tower metadata (written by this or parallel runs) into the catalogue
    metas = {it["slug"]: os.path.join(out, it["slug"] + ".json") for it in items}
    if all(os.path.exists(m) for m in metas.values()):
        for it in items:
            it.update(json.load(open(metas[it["slug"]])))
        json.dump(items, open(cat, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        for m in metas.values():
            os.remove(m)


if __name__ == "__main__":
    main()
