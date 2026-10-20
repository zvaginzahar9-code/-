"""Build the product catalogue (everything except the LEP towers) from the zavsk.ru scrape.

Input:  research/zavsk/crawl.json + research/zavsk/pages/ (raw HTML) + research/zavsk/img/
Output: src/data/products.json and the list of source images to redraw (scripts/trace_items.py).

What is taken from the source: names, specification tables and factual sentences (drawing
numbers, series, mass, sizes, purpose). What is dropped: prices, "how to buy" text, the source
company's name, phone, city and delivery promises, photos and 3D renders (only line drawings
are redrawn). A scheme shown for several marks is one drawing of the series; the site says so.

Usage: python -I scripts/build_products.py <research_dir> <site_dir>
"""
import hashlib
import html
import json
import os
import re
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

RESEARCH, SITE = sys.argv[1], sys.argv[2]
Z = os.path.join(RESEARCH, "zavsk")
crawl = json.load(open(os.path.join(Z, "crawl.json"), encoding="utf-8"))
P = crawl["products"]
# the second pass over the rest of the source catalogue (LEP towers, antenna supports, concrete)
MORE = os.path.join(Z, "more")
if os.path.exists(os.path.join(MORE, "crawl.json")):
    for path, v in json.load(open(os.path.join(MORE, "crawl.json"), encoding="utf-8"))["products"].items():
        P.setdefault(path, v)

# towers already in the tower lineup (src/data/catalog.json) are not repeated here
TOWERS = {re.sub(r"[\s\-–]", "", t["mark"].lower()) for t in json.load(open(os.path.join(SITE, "src", "data", "catalog.json"), encoding="utf-8"))}


def in_lineup(pr):
    """True when every mark on the page (table rows "Опора …", else the title's last word) is a lineup tower."""
    marks = [re.sub(r"^Опора\s+", "", r[0]) for t in pr["tables"] for r in t[1:] if r and re.match(r"^Опора\s", r[0])]
    marks = marks or [pr["title"].split()[-1]]
    return all(re.sub(r"[\s\-–]", "", m.lower()) in TOWERS for m in marks)

# category -> groups (source section path, title on the site). Order is the order on the site.
C = "/catalog/"
CATEGORIES = [
    ("masts", "Прожекторные мачты", [
        (C + "prozhektornye-machty/prozhektornye-machty-metallicheskie/", "Мачты прожекторные ПМС", lambda p: "/pms-" in p),
        (C + "prozhektornye-machty/prozhektornye-machty-metallicheskie/", "Мачты прожекторные Н", lambda p: "/n-" in p),
        (C + "prozhektornye-machty/mnogogrannye-vysokomachtovye-opory/vmo/", "Многогранные мачты ВМО", None),
        (C + "prozhektornye-machty/mnogogrannye-vysokomachtovye-opory/vmon-vmont/", "Многогранные мачты ВМОН, ВМОНТ", None),
    ]),
    ("lightning", "Молниеотводы", [
        (C + "molnieotvody/metallicheskie/ms/", "Молниеотводы стальные МС", None),
        (C + "molnieotvody/metallicheskie/sm/", "Молниеотводы стержневые СМ", None),
        (C + "molnieotvody/metallicheskie/am/", "Молниеотводы антенные АМ", None),
        (C + "molnieotvody/metallicheskie/mogk/", "Молниеотводы граненые МОГК", None),
        (C + "molnieotvody/metallicheskie/vgm/", "Молниеотводы ВГМ", None),
        (C + "molnieotvody/metallicheskie/vgn/", "Молниеотводы ВГН", None),
    ]),
    ("portals", "Порталы ОРУ", [
        (C + "portaly-otkrytyh-raspredelitelnyh-ustroystv-oru/ps/", "Порталы ПС", None),
        (C + "portaly-otkrytyh-raspredelitelnyh-ustroystv-oru/psl/", "Порталы ПСЛ", None),
        (C + "portaly-otkrytyh-raspredelitelnyh-ustroystv-oru/pst/", "Порталы ПСТ", None),
    ]),
    ("contact", "Опоры контактной сети", [
        (C + "opory-kontaktnoy-seti/konsolnaya-opora-m1/", "Консольные опоры М1", None),
        (C + "opory-kontaktnoy-seti/konsolnaya-opora-m2/", "Консольные опоры М2", None),
        (C + "opory-kontaktnoy-seti/konsolnaya-opora-msh/", "Консольные опоры МШ", None),
        (C + "opory-kontaktnoy-seti/konsolnaya-opora-msh2/", "Консольные опоры МШ2", None),
        (C + "opory-kontaktnoy-seti/stoyki-zhestkoy-poperechiny/", "Стойки жёстких поперечин", None),
        (C + "opory-kontaktnoy-seti/stoyka-povyshennoy-dliny/", "Стойки повышенной длины", None),
    ]),
    ("piles", "Свайные фундаменты", [
        (C + "metallicheskie-konstruktsii-dlya-svaynyh-fundamentov/rostverki/", "Ростверки", None),
        (C + "metallicheskie-konstruktsii-dlya-svaynyh-fundamentov/balki-metallicheskie/", "Балки металлические", None),
        ("text:nagolovniki", "Наголовники", None),
    ]),
    ("hardware", "Металлоконструкции 0,4–35 кВ", [
        (C + "metallokonstruktsii/traversy/tm/", "Траверсы ТМ", None),
        (C + "metallokonstruktsii/traversy/tn/", "Траверсы ТН", None),
        (C + "metallokonstruktsii/traversy/tv-v/", "Траверсы ТВ, В", None),
        (C + "metallokonstruktsii/traversy/tz/", "Траверсы ТЗ", None),
        (C + "metallokonstruktsii/traversy/t/", "Траверсы Т", None),
        (C + "metallokonstruktsii/traversy/sh/", "Траверсы SH", None),
        (C + "metallokonstruktsii/nadstavki/", "Надставки", None),
        (C + "metallokonstruktsii/kryuki/", "Крюки", None),
        (C + "metallokonstruktsii/krepleniya-ukosa/", "Крепления укоса", None),
        (C + "metallokonstruktsii/ogolovki/", "Оголовки", None),
        (C + "metallokonstruktsii/styazhki/", "Стяжки", None),
        (C + "metallokonstruktsii/homuty/", "Хомуты", None),
        (C + "metallokonstruktsii/ottyazhki/", "Оттяжки", None),
        (C + "metallokonstruktsii/kronshteyny/", "Кронштейны", None),
        (C + "metallokonstruktsii/nakladki/", "Накладки", None),
    ]),
    ("lep", "Опоры ЛЭП других серий", [
        (C + "metallicheskie-opory-lep/promezhutochnye-opory-lep/", "Промежуточные опоры", None),
        (C + "metallicheskie-opory-lep/ankerno-uglovye-opory-lep/", "Анкерно-угловые опоры", None),
        (C + "metallicheskie-opory-lep/unifitsirovannye-promezhutochnye-opory-lep/", "Унифицированные промежуточные", None),
        (C + "metallicheskie-opory-lep/unifitsirovannye-ankerno-uglovye-opory-lep/", "Унифицированные анкерно-угловые", None),
        (C + "metallicheskie-opory-lep/mnogogrannye/", "Многогранные опоры", None),
    ]),
    ("antenna", "Антенные опоры и мачты связи", [
        (C + "antennye-opory/antennaya-opora-ao/", "Антенные опоры АО", None),
        (C + "antennye-opory/machta-antennaya/", "Антенные мачты", None),
        (C + "antennye-opory/vyshki-svyazi/rmg/", "Мачты связи РМГ", None),
        (C + "antennye-opory/radioreleynoy-svyazi-rrl/", "Опоры радиорелейной связи РРЛ", None),
        (C + "antennye-opory/dvoynogo-naznacheniya-odn/", "Опоры двойного назначения ОДН", None),
    ]),
    ("concrete", "Железобетонные изделия", [
        (C + "zhelezobetonnye-opory-lep/", "Железобетонные опоры ЛЭП", None),
        (C + "prozhektornye-machty/prozhektornye-machty-zhelezobetonnye/", "Прожекторные мачты ПМЖ", None),
        (C + "molnieotvody/zhelezobitonnye-mzh/", "Молниеотводы МЖ", None),
        (C + "metallicheskie-konstruktsii-dlya-svaynyh-fundamentov/opornye-plity/", "Фундаментные опорные плиты", None),
    ]),
]
# whole-category groups whose towers may already be in the lineup
SKIP_LINEUP = "lep"

# Text-only sections of the source (no product pages): the items are written out from the
# section text, word for word where it gives facts.
TEXT_GROUPS = {
    "text:nagolovniki": [
        {
            "slug": "m42", "name": "Наголовник М42",
            "note": "Выпускается по типовой серии 3.407-9-146. Защищает сваю при строительстве фундаментов из одиночных свай для металлических свободностоящих опор. Монтируется сваркой: приваривается к верхнему листу закладной детали сваи.",
        },
        {
            "slug": "m43", "name": "Наголовник М43",
            "note": "Выпускается по типовой серии 3.407-9-146. Защищает сваю при строительстве фундаментов из одиночных свай для металлических свободностоящих опор. Монтируется сваркой: приваривается к верхнему листу закладной детали сваи.",
        },
    ]
}

# photos and 3D renders, not line drawings (checked by eye on contact sheets): the product is
# redrawn as a line picture from the image itself (scripts/lineart.py) and the site says so
PICTURES = {
    "balki_metall_kon-626_900_0.jpg", "oporno-ankernye_plity_p-3.jpg", "opornye_plity_op-1.jpg",
    "opornye_plity_op-2.jpg", "plita_opornaya_op-1d.png",
    "rostverki-ts-303_900_0.jpg", "screenshot_1-913_900_0.jpg", "screenshot_2_900_0.jpg",
    "usilennye_opornye_plity_uop-6.png",
    "machta-teleskopicheskaya-mtc.jpg", "machta-teleskopicheskaya-mtl.jpg", "machta-teleskopicheskaya-mtp.jpg",
    "machty-fermnye-st-3.png", "machty-fermnye-st-4.png", "machty-fermnye-tm.jpg", "opory-odn.jpg",
    "opory-radioreleynoy-svyazi-rrl.png",
}
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lineart import flat as _flat_rgb, lines as _lines  # noqa: E402


# Sheets of the original typical series (files.stroyinf.ru scans) for marks the source shows no
# scheme for: research/series/found_*.json maps slug -> sheet; each mapping was checked by reading
# the sheet's title block. The scan is downscaled and redrawn like any scheme.
SERIES = os.path.join(RESEARCH, "series")
SHEETS = {}
for fn in ("found_towers.json", "found_hardware.json", "found_multi.json"):
    p = os.path.join(SERIES, fn)
    if os.path.exists(p):
        for e in json.load(open(p, encoding="utf-8")):
            if not e.get("verified") or not e.get("file"):
                continue
            # the main sheet of a slug wins over extra sheets of the same family
            if e["slug"] not in SHEETS or e.get("primary"):
                SHEETS[e["slug"]] = e


OUT_PRODUCTS = os.path.join(SITE, "public", "products")
INK = (28, 34, 38)


def sheet_image(e):
    """The series scan, cleaned: uneven paper evened out to white, the lines in the site's ink,
    on a transparent background. A whole scanned sheet does not vectorise well (the grey paper
    becomes fills), so it is published as a clean raster: <stem>.webp, plus the card preview
    <stem>-s.webp. Returns the stem name (with .png, for the bookkeeping of the other images)."""
    src = os.path.join(SERIES, e["file"])
    # some scans hold two sheets; the mapping says which half is this mark's ("левая половина"…)
    t = e.get("sheet_title", "").lower()
    half = next((h for w, h in (("левая половина", "l"), ("правая половина", "r"), ("верхняя половина", "t"), ("нижняя половина", "b")) if w in t), "")
    stem = "sheet-" + re.sub(r"[^\w.-]", "_", os.path.splitext(os.path.basename(src))[0]) + (f"-{half}" if half else "")
    big, small = os.path.join(OUT_PRODUCTS, stem + ".webp"), os.path.join(OUT_PRODUCTS, stem + "-s.webp")
    if not (os.path.exists(big) and os.path.exists(small)):
        im = Image.open(src).convert("L")
        if half:
            w, h = im.size
            box = {"l": (0, 0, w // 2 + w // 50, h), "r": (w // 2 - w // 50, 0, w, h), "t": (0, 0, w, h // 2 + h // 50), "b": (0, h // 2 - h // 50, w, h)}[half]
            im = im.crop(box)
        im.thumbnail((2000, 2000), Image.LANCZOS)
        lum = np.asarray(im, dtype=np.float32)
        paper = ndimage.maximum_filter(ndimage.gaussian_filter(lum, 3), size=41)  # local paper tone
        ratio = lum / np.maximum(paper, 1)
        alpha = np.clip((0.88 - ratio) / 0.3, 0, 1)
        rgba = np.zeros(lum.shape + (4,), np.uint8)
        rgba[..., :3] = INK
        rgba[..., 3] = (alpha * 255).astype(np.uint8)
        os.makedirs(OUT_PRODUCTS, exist_ok=True)
        Image.fromarray(rgba).save(big, "WEBP", quality=80, method=6)
        # card preview on white (the cards blend it with `multiply`)
        prev = Image.alpha_composite(Image.new("RGBA", im.size, (255, 255, 255, 255)), Image.fromarray(rgba))
        prev.thumbnail((480, 480), Image.LANCZOS)
        prev.convert("RGB").save(small, "WEBP", quality=82, method=6)
    return stem + ".png"


def picture(img):
    """A photo/render becomes a black-and-white line picture next to it (made once)."""
    name = os.path.splitext(img)[0] + "-lines.png"
    dst = os.path.join(Z, "img", name)
    if not os.path.exists(dst):
        Image.fromarray(_lines(_flat_rgb(os.path.join(Z, "img", img)))).save(dst)
    return name
# collages "photo + drawing": only the drawing half is redrawn (box in source pixels)
CROPS = {
    "vgm_900_0.jpg": (470, 0, 900, 1167),
    "vgn_900_0.jpg": (0, 0, 392, 997),
    "prozhektornye-machty-vmon-vmont-95_900_0.jpg": (432, 0, 900, 855),
}


def cropped(img):
    if img not in CROPS:
        return img
    name = os.path.splitext(img)[0] + "-drawing.png"
    dst = os.path.join(Z, "img", name)
    if not os.path.exists(dst):
        Image.open(os.path.join(Z, "img", img)).convert("RGB").crop(CROPS[img]).save(dst)
    return name

# sentences carrying the source's sales talk or identity are dropped whole
DROP = re.compile(
    r"купить|купит|Завод Стальных|ЗСК|\+7|телефон|Екатеринбург|менеджер|по РФ|по России|цен[аеуы]|стоимост|"
    r"доставк|наличи|склад|оформить|заказ|звоните|обращайтесь|производитель|гарантир|оперативн|"
    r"на нашем|наш[аеи]? |мы |компани|РФ|Росси|опыт|отличаются|предлагаем|выгодн|лучш",
    re.I,
)
# only sentences that state something checkable are kept: numbers, standards, drawings, purpose
FACT = re.compile(r"\d|ГОСТ|СНиП|чертеж|чертёж|проект|сери|предназнач|применя|служ|конструкци|изготавлива|выполн|сталь|стали|ENSTO", re.I)
HEADINGS = re.compile(r"^(Технические характеристики|Характеристики|Спецификация[^.]*|Применение|Описание)\s*", re.I)


def page(path):
    name = hashlib.md5(path.encode()).hexdigest() + ".html"
    fn = os.path.join(Z, "pages", name)
    if not os.path.exists(fn):
        fn = os.path.join(MORE, "pages", name)
    return open(fn, encoding="utf-8").read()


def flat(fn):
    """The image on white: transparent PNGs would otherwise turn black."""
    im = Image.open(fn)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    return im.convert("RGB")


def text(fragment):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def tables(fragment):
    """Tables with row/col spans kept (a spanned mass cell is the total, not per row)."""
    out = []
    for t in re.findall(r"<table.*?</table>", fragment, re.S):
        rows = []
        for row in re.findall(r"<tr.*?</tr>", t, re.S):
            cells = []
            for attrs, body in re.findall(r"<t[dh]([^>]*)>(.*?)</t[dh]>", row, re.S):
                rs = re.search(r'rowspan="?(\d+)', attrs)
                cs = re.search(r'colspan="?(\d+)', attrs)
                c = {"t": text(body)}
                if rs and int(rs.group(1)) > 1:
                    c["rs"] = int(rs.group(1))
                if cs and int(cs.group(1)) > 1:
                    c["cs"] = int(cs.group(1))
                cells.append(c)
            if cells:
                rows.append(cells)
        if rows:
            out.append(rows)
    return out


def clean_table(rows):
    """Drops price columns and sketch columns; a 0 or a dash in a value cell means 'not given'."""
    head = rows[0]
    drop = set()
    col = 0
    for c in head:
        span = c.get("cs", 1)
        if re.search(r"цена|эскиз", c["t"], re.I):
            drop.update(range(col, col + span))
        col += span
    if not drop and len(rows) < 2:
        return rows

    def keep(row, is_head):
        out, col = [], 0
        for c in row:
            span = c.get("cs", 1)
            if col not in drop:
                out.append(c)
            col += span
        return out

    rows = [keep(r, i == 0) for i, r in enumerate(rows)] if drop else rows
    for r in rows[1:]:
        for c in r:
            if c["t"] in ("0", "-", "0,00", "0 руб."):
                c["t"] = "—"
    return [r for r in rows if any(c["t"] for c in r)]


def sentences(s):
    s = HEADINGS.sub("", s)
    parts = re.split(r"(?<=[.!?])\s+(?=[А-ЯЁA-Z«])", s)
    out = []
    for p in parts:
        p = HEADINGS.sub("", p.strip())
        p = re.sub(r"\s+\.", ".", p).strip(" .")
        if len(p.split()) < 3 or DROP.search(p) or not FACT.search(p):
            continue
        out.append(p + ".")
    return " ".join(out)


def dhash(fn, n=16):
    """Hash of the dark ink only, cropped to its box: the watermark is the same on every
    image and would make different small drawings look alike."""
    a = np.asarray(flat(fn).convert("L"), dtype=np.float32)
    ink = a < 120
    if not ink.any():
        return np.zeros(n * n, bool)
    ys, xs = np.where(ink)
    crop = Image.fromarray((ink[ys.min():ys.max() + 1, xs.min():xs.max() + 1] * 255).astype(np.uint8))
    small = np.asarray(crop.resize((n, n), Image.BOX), dtype=np.float32)
    return np.concatenate([(small > 24).flatten(), [crop.width > crop.height * 1.2, crop.height > crop.width * 1.2]])


MARKS = {  # titles without a mark of the usual shape; the marks are taken from their own tables
    "Ячейковые порталы ПС 35 кВ": "ПС-35",
    "Ростверки для четырехсвайных фундаментов": "Ростверки Р4",
    "Ростверки для двухсвайных фундаментов": "Ростверки Р2",
    "Оттяжка ОТ-2 (26.0004-29)": "ОТ-2",
}


def mark_of(title):
    if title in MARKS:
        return MARKS[title]
    title = re.sub(r"\s*\([^)]*\)\s*$", "", title)  # "Оголовок ОГs - 54 (ENSTO 4-1)" -> "Оголовок ОГs - 54"
    title = re.sub(r"\s+-\s+", "-", title)  # "ОГs - 54" -> "ОГs-54"
    title = re.sub(r"\s+железобетонная$", "", title)  # "…опора УА10-1 железобетонная"
    # "Траверса ТМ-1" -> "ТМ-1"; "Консольные опоры М1-12-80С" -> "М1-12-80С"
    # an optional leading digit belongs to the mark: "1П110-1", "2П330-5"
    m = re.search(r"(\d?[A-ZА-ЯЁ][A-Za-zА-ЯЁа-яё]{0,4}s?[-\s]?\d[\w.,/()+-]*(?:\s*[,/]\s*[A-ZА-ЯЁ][\w.,/()+-]*\d[\w.,/()+-]*)*)\s*$", title)
    if m:
        s = re.sub(r"(?<=[A-Za-zА-ЯЁа-яё])\s+(?=\d)", "-", m.group(1))  # "ПМС 24,0" -> "ПМС-24,0"
        s = s.replace(" ", "")
        return re.sub(r",(?=[A-Za-zА-ЯЁ])", ", ", s)  # "ТМ-85а,ТМ-85аМ" -> "ТМ-85а, ТМ-85аМ"
    m = re.search(r"\b([А-ЯЁA-Z]{2,6}\d?)$", title)  # "Стойка повышенной длины МШТШ"
    return m.group(1) if m else title


def num(s):
    m = re.search(r"\d+(?:[.,]\d+)?", s or "")
    return float(m.group(0).replace(",", ".")) if m else None


def keys_of(tabs, note):
    """Mass and height when the source states them unambiguously (one-row tables or the text)."""
    keys = {}
    for rows in tabs:
        if len(rows) != 2:
            continue
        for h, v in zip(rows[0], rows[1]):
            ht = h["t"].lower()
            if ("вес" in ht or "масса" in ht) and "mass" not in keys and num(v["t"]):
                keys["mass"] = num(v["t"])
            if "высота" in ht and "H" not in keys and num(v["t"]):
                keys["H"] = num(v["t"])
            if re.search(r"чертеж|чертёж|альбом|проект", ht) and "doc" not in keys and v["t"] not in ("", "—") and re.search(r"\d", v["t"]):
                keys["doc"] = v["t"]
    if "doc" not in keys:
        m = re.search(r"(?:по (?:типовому |типовым )?(?:чертежу|чертежам|проекту|проектам)|по (?:типовой )?серии|Чертеж:)\s*([0-9A-ZА-ЯЁ][\w.\-]*\d[\w.\-]*)", note)
        if m:
            keys["doc"] = m.group(1).rstrip(".")
    if "mass" not in keys:
        m = re.search(r"(?:Вес|Масса)[:\s]*(\d+(?:[.,]\d+)?)\s*кг", note)
        if m:
            keys["mass"] = num(m.group(1))
    return keys


used_images = {}
hashes = []  # (hash, canonical file)


def canonical(img):
    """The same scheme is uploaded under several names: map near-identical files to one."""
    fn = os.path.join(Z, "img", img)
    h = dhash(fn)
    for hh, f in hashes:
        if np.count_nonzero(hh != h) <= 3:
            return f
    hashes.append((h, img))
    return img


out_cats = []
seen_slugs = set()
for cid, ctitle, groups in CATEGORIES:
    out_groups = []
    for src, gtitle, flt in groups:
        items = []
        if src.startswith("text:"):
            for it in TEXT_GROUPS[src]:
                slug = f"{cid}-{it['slug']}"
                entry = {"slug": slug, "name": it["name"], "mark": mark_of(it["name"]), "draw": None, "drawKind": None, "note": it["note"], "tables": [], "keys": {}}
                if slug in SHEETS:
                    entry.update(draw=os.path.splitext(sheet_image(SHEETS[slug]))[0], drawKind="sheet", sheet={"series": SHEETS[slug]["series"], "title": SHEETS[slug].get("sheet_title", ""), "url": SHEETS[slug].get("page_url", "")})
                items.append(entry)
        else:
            paths = sorted(p for p in P if p.startswith(src) and p.count("/") == src.count("/") + 1 and (flt is None or flt(p)))
            if cid == SKIP_LINEUP:
                paths = [p for p in paths if not in_lineup(P[p])]
            for path in paths:
                pr = P[path]
                s = page(path)
                desc = re.search(r'<div class="prod_desc">(.*?)(?:<h2>Как купить|<div class="shop2-product-params|<smart-captcha)', s, re.S)
                frag = desc.group(1) if desc else ""
                tabs = [clean_table(t) for t in tables(frag)]
                # a table whose every value is "not given" says nothing
                tabs = [t for t in tabs if len(t) > 1 and any(c["t"] != "—" for r in t[1:] for c in r[1:])]
                note = sentences(text(re.sub(r"<table.*?</table>", " ", frag, flags=re.S)))
                img = next((os.path.basename(i) for i in pr["images"] if "coming-soon" not in i), None)
                draw = None
                kind = None
                if img and os.path.exists(os.path.join(Z, "img", img)):
                    kind = "picture" if img in PICTURES else "scheme"
                    img = canonical(picture(img) if kind == "picture" else cropped(img))
                    used_images[img] = True
                    draw = os.path.splitext(img)[0]
                slug = re.sub(r"[^a-z0-9-]", "", path.rstrip("/").rsplit("/", 1)[1].lower())
                slug = f"{cid}-{slug}"
                while slug in seen_slugs:
                    slug += "-2"
                seen_slugs.add(slug)
                sheet = None
                if draw is None and slug in SHEETS:
                    sheet = SHEETS[slug]
                    draw, kind = os.path.splitext(sheet_image(sheet))[0], "sheet"  # published as is, not traced
                items.append({
                    "slug": slug,
                    "name": pr["title"],
                    "mark": mark_of(pr["title"]),
                    "draw": draw,
                    # "scheme": a redrawn drawing; "picture": redrawn from a photo/3D model of the product
                    "drawKind": kind,
                    **({"sheet": {"series": sheet["series"], "title": sheet.get("sheet_title", ""), "url": sheet.get("page_url", "")}} if sheet else {}),
                    "note": note,
                    "tables": tabs,
                    "keys": keys_of(tabs, note),
                })
        # "<mark>+N" is the same pole on an N-metre stand: it is shown with the base pole's sheet
        # (and the site says so); any other difference in the mark is a different pole — not borrowed
        drawn = {re.sub(r"^Многогранные опоры\s*", "", it["mark"]): it for it in items if it["draw"]}
        for it in items:
            m = re.match(r"^(.+?)\s*\+\s*\d+(?:[.,]\d+)?$", re.sub(r"^Многогранные опоры\s*", "", it["mark"]))
            if not it["draw"] and m and m.group(1) in drawn:
                base = drawn[m.group(1)]
                it.update(draw=base["draw"], drawKind=base.get("drawKind"), base=m.group(1), **({"sheet": base["sheet"]} if base.get("sheet") else {}))
        # a drawing shared by several marks of the group is a series scheme
        counts = {}
        for it in items:
            if it["draw"]:
                counts[it["draw"]] = counts.get(it["draw"], 0) + 1
        for it in items:
            it["series"] = bool(it["draw"] and counts[it["draw"]] > 1)
        gid = f"{cid}-{len(out_groups) + 1}"
        out_groups.append({"id": gid, "title": gtitle, "items": items})
        print(f"{gtitle}: {len(items)} items, {sum(1 for i in items if i['draw'])} with drawings", flush=True)
    out_cats.append({"id": cid, "title": ctitle, "groups": out_groups})

json.dump({"source": "zavsk.ru", "categories": out_cats}, open(os.path.join(SITE, "src", "data", "products.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
open(os.path.join(Z, "to_trace.txt"), "w", encoding="utf-8").write("\n".join(sorted(used_images)))
total = sum(len(g["items"]) for c in out_cats for g in c["groups"])
print("items", total, "drawings to redraw", len(used_images))
