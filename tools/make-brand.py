#!/usr/bin/env python3
"""Rebuild every piece of Xeet's mark from one source file.

The brand artwork is a render, not a drawing: a white 3D X with a cursor,
lit against black. That rules out carrying it as vector paths the way the
old mark was carried, so the source PNG is the master and everything else
here is derived from it — icons, favicon, the header lockup, the social
card. Editing any of the outputs by hand means the next run silently undoes
you; replace brand/xeet-source.png and run this instead.

    python3 tools/make-brand.py

Two facts about the source shape the code below. It has no alpha — the
artwork sits on a near-black ground — and the ground is what the glow fades
into, so the cutout has to come from luminance rather than a colour key: a
hard threshold would clip the glow into a halo. And the dark separations
INSIDE the X are part of the drawing, so they are cut out too and show
whatever is behind. Everywhere this mark is used is dark, which is the
condition under which that is the right answer.
"""
import base64
import pathlib

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
SITE = ROOT / "site"
ICONS = ROOT / "extension" / "icons"

SOURCE = BRAND / "xeet-source.png"
GROUND = (9, 9, 9)          # the tile colour the old icons used
RADIUS = 22 / 128           # and their corner radius, as a fraction of the side
SUPER = 4                   # supersampling for the rounded corners


def cutout():
    """The artwork on transparent, trimmed to its own edges.

    Alpha is the luminance and the colour is flat white: on a dark ground
    that composites back to the original pixel for pixel, and it keeps the
    soft glow as a real gradient instead of a cut edge.
    """
    src = Image.open(SOURCE).convert("RGB")
    lum = src.convert("L")
    art = Image.new("RGBA", src.size, (255, 255, 255, 0))
    art.putalpha(lum)

    # Trim on a threshold well above the glow's floor, so the box is the
    # artwork rather than the noise around it.
    box = lum.point(lambda v: 255 if v > 18 else 0).getbbox()
    return art.crop(box)


def tile(size, art, fill=0.76):
    """A rounded black tile with the mark centred on it."""
    big = size * SUPER
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=int(RADIUS * big), fill=255)
    ImageDraw.Draw(im).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=int(RADIUS * big), fill=GROUND + (255,))

    w, h = art.size
    scale = (big * fill) / max(w, h)
    g = art.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    im.alpha_composite(g, ((big - g.width) // 2, (big - g.height) // 2))
    im.putalpha(mask)
    return im.resize((size, size), Image.LANCZOS)


def main():
    art = cutout()
    print(f"artwork trimmed to {art.size[0]}x{art.size[1]}")

    BRAND.mkdir(exist_ok=True)
    mark = art.copy()
    mark.thumbnail((512, 512), Image.LANCZOS)
    mark.save(BRAND / "mark.png")
    print(f"brand/mark.png            {mark.size[0]}x{mark.size[1]}")

    # --- extension icons ---------------------------------------------------
    # 16px is the one that decides whether this reads at all — at that size the
    # cursor is four pixels across — so the small tiles give the glyph more
    # room and the large ones keep the breathing space the mark was drawn with.
    # Compared side by side at 16: 0.76 muddies into a blob, 0.98 crowds the
    # corners, 0.90 keeps the crossing legible.
    FILL = {16: 0.90, 32: 0.84, 48: 0.78, 128: 0.76}
    for size, fill in FILL.items():
        tile(size, art, fill=fill).save(ICONS / f"icon{size}.png")
    print("extension/icons/icon{16,32,48,128}.png")

    # --- the site's tab icon ----------------------------------------------
    # An <svg> wrapper rather than a .png so the five pages that already point
    # at favicon.svg keep working, and so one file serves every density.
    fav = tile(180, art, fill=0.80)
    fav.save(SITE / "favicon-180.png")
    data = base64.b64encode((SITE / "favicon-180.png").read_bytes()).decode()
    (SITE / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'viewBox="0 0 180 180" width="180" height="180">'
        f'<image width="180" height="180" xlink:href="data:image/png;base64,{data}"/>'
        "</svg>")
    (ICONS / "favicon.svg").write_text((SITE / "favicon.svg").read_text())
    print(f"site/favicon.svg          {(SITE / 'favicon.svg').stat().st_size} bytes")


if __name__ == "__main__":
    main()
