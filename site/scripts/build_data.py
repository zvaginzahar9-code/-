"""Build catalog data (names + specifications) from the scraped catalogue.

No images are shipped: drawings are redrawn by scripts/redraw.py.
Run:  python -I scripts/build_data.py <research_dir> <site_dir>
"""
import json
import os
import re
import shutil
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

RESEARCH, SITE = sys.argv[1], sys.argv[2]
COMP = os.path.join(RESEARCH, "competitor")
OUT_IMG = os.path.join(SITE, "public", "catalog")
OUT_SIL = os.path.join(OUT_IMG, "sil")
OUT_DATA = os.path.join(SITE, "src", "data")
for d in (OUT_IMG, OUT_SIL, OUT_DATA):
    os.makedirs(d, exist_ok=True)

raw = json.load(open(os.path.join(COMP, "catalog.json"), encoding="utf-8"))


def num(s):
    m = re.search(r"\d+(?:[.,]\d+)?", s or "")
    return float(m.group(0).replace(",", ".")) if m else None


def fix_range(v):
    # The source lost the range sign: "АС-70 ? АС-95" means "АС-70 ÷ АС-95".
    return re.sub(r"\s*\?\s*", " ÷ ", v).strip()


def silhouette(src, dst):
    im = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    lum = 0.299 * im[..., 0] + 0.587 * im[..., 1] + 0.114 * im[..., 2]
    sat = im.max(-1) - im.min(-1)
    mask = (lum < 150) & (sat < 40)
    alpha = np.clip((175 - lum) / 120, 0, 1) * (sat < 50)
    lab, n = ndimage.label(ndimage.binary_dilation(mask, iterations=2))
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    region = lab == (1 + int(np.argmax(sizes)))
    alpha *= region
    ys, xs = np.where(region & mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    out = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
    out[..., :3] = (28, 34, 38)
    out[..., 3] = (alpha[y0:y1, x0:x1] * 255).astype(np.uint8)
    Image.fromarray(out).save(dst, "WEBP", quality=88, method=6)
    return int(x1 - x0), int(y1 - y0), [int(x0), int(y0), int(x1), int(y1)]


KEYS = {
    "Наименование изделия": "name",
    "Район по гололеду": "ice",
    "Ветровой район": "wind",
    "Марка провода": "wire",
    "Марка грозотроса": "groundWire",
    "Размер в осях фундамента L, м": "L",
    "Высота опоры Н, м": "H",
    "Высота до нижней траверсы h, м": "h",
    "Высота до низа нижн. траверсы с учетом подставки. h, м": "hBase",
    "Подставка h1, м": "h1",
    "Масса опоры с цинком, кг": "mass",
    "Номер типового проекта": "project",
    "Примечание": "note",
}

items = []
for p in raw:
    specs = []
    fields = {}
    for k, v in p["specs"]:
        key = re.sub(r"\s+", " ", k).strip()
        val = fix_range(v) if "провод" in key.lower() or "трос" in key.lower() else v.strip()
        specs.append({"label": key, "value": val})
        fields[KEYS.get(key, key)] = val
    src = os.path.join(COMP, "images", p["images"][0])
    ext = os.path.splitext(src)[1].lower()
    slug = re.sub(r"^\d+-", "", p["slug"]).replace("opora-", "")
    w, h = Image.open(src).size
    mark = re.sub(r"^Опора\s+", "", p["name"]).replace(" - ", "-").replace(" ", "")
    items.append({
        "slug": slug,
        "mark": mark,
        "kv": int(p["kv"]),
        # source scheme, used only by scripts/redraw.py to measure the outline (not shipped)
        "image": os.path.basename(src),
        "H": num(fields.get("H")),
        "h": num(fields.get("h") or fields.get("hBase")),
        "L": num(fields.get("L")),
        "mass": num(fields.get("mass")),
        "wire": fields.get("wire"),
        "project": fields.get("project"),
        "specs": specs,
    })
    print(slug, mark, items[-1]["H"], items[-1]["mass"])


def natkey(it):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", it["mark"])]


items.sort(key=lambda it: (it["kv"], natkey(it)))
json.dump(items, open(os.path.join(OUT_DATA, "catalog.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("items", len(items), "missing H:", [i["mark"] for i in items if not i["H"]])
