#!/usr/bin/env python3
"""Draw everything the Chrome Web Store listing needs, at the exact sizes it
demands — a scaled screenshot of a browser pane cannot hit 1280x800 or
440x280, and the store rejects anything off by a pixel.

    python3 tools/make-store-assets.py     ->  dist/store/

Screens are captioned in the product's own voice and show its real figures.
Nothing here invents a feature: each one is a state the extension actually
renders.
"""
import pathlib
from PIL import Image, ImageDraw
from artwork import (ROOT, SITE, font, tracked, wrap, ground, lockup, xmark,
                     panel, card, VOID, WHITE, PAPER, DIM, MUTED, FAINT, PANEL_H)

OUT = ROOT / "dist" / "store"
OUT.mkdir(parents=True, exist_ok=True)

SHOT = (1280, 800)


def caption(d, x, y, title, sub, size=44, width=560):
    """A headline and its line, both wrapped to the column beside the panel."""
    hf, sf = font("Manrope", 800, size), font("Manrope", 500, 17)
    for line in wrap(title, hf, -size * 0.03, width):
        tracked(d, (x, y), line, hf, WHITE, -size * 0.03)
        y += size * 1.06
    y += 6
    for line in wrap(sub, sf, 0, width):
        tracked(d, (x, y), line, sf, MUTED, 0)
        y += 25
    return y


def post(im, x, y, w, who, handle, lines, avatar=None, acts=None):
    """A post drawn the way X draws one: a row in a column, not a card.

    No border and no radius — hairlines above and below, a 36px avatar, one
    line of name/handle/date with the handle in the platform's secondary grey,
    the body at 15/20, and the action bar underneath. The site's scene is
    built the same way, and the two have to agree or the screenshot is
    advertising something the page does not do."""
    x, y, w = round(x), round(y), round(w)
    d = ImageDraw.Draw(im)
    HAIR, TEXT, DIM2, LINK = (47, 51, 54), (231, 233, 234), (113, 118, 123), (29, 155, 240)

    body_h = 22 * len(lines)
    h = 30 + body_h + (46 if acts else 0)
    d.rectangle([x, y, x + w, y + h], fill=(0, 0, 0))
    d.line([(x, y), (x + w, y)], fill=HAIR, width=1)
    d.line([(x, y + h), (x + w, y + h)], fill=HAIR, width=1)

    if avatar:
        av = Image.open(SITE / "img" / avatar).convert("RGB").resize((36, 36), Image.LANCZOS)
        m = Image.new("L", (36, 36), 0)
        ImageDraw.Draw(m).ellipse([0, 0, 35, 35], fill=255)
        im.paste(av, (x + 14, y + 14), m)
    else:
        d.ellipse([x + 14, y + 14, x + 50, y + 50], fill=(22, 24, 28))

    tx = x + 62
    nf, hf = font("Manrope", 800, 14.5), font("Manrope", 500, 14.5)
    nx = tracked(d, (tx, y + 30), who, nf, TEXT, -0.1)
    tracked(d, (nx + 7, y + 30), handle, hf, DIM2, 0)
    d.text((x + w - 22, y + 26), "···", font=font("Manrope", 700, 13), fill=DIM2, anchor="rs")

    f = font("Manrope", 500, 14.5)
    for i, line in enumerate(lines):
        cx, by = tx, y + 52 + i * 22
        for chunk, hot in line:
            wch = sum(f.getlength(c) for c in chunk)
            if hot:
                # the tag as it really is: X's link blue, carrying the
                # extension's mark, lit because the pointer is on it
                d.rectangle([cx - 2, by - 13, cx + wch + 2, by + 4], fill=(30, 32, 34))
                d.line([(cx - 2, by + 4), (cx + wch + 2, by + 4)], fill=(242, 244, 243), width=1)
                tracked(d, (cx, by), chunk, f, (242, 244, 243), 0)
            else:
                tracked(d, (cx, by), chunk, f, TEXT, 0)
            cx += wch
    return y + h + 1


def acts_bar(im, x, y, w, counts):
    """X's action row: reply, repost, like, views, then bookmark and share.

    The icons are drawn, not lifted — same shapes, our strokes."""
    d = ImageDraw.Draw(im)
    DIM2 = (113, 118, 123)
    f = font("Manrope", 500, 12.5)
    slots = 6
    step = (w - 40) / (slots - 1)
    cx = x + 62
    for i, (kind, label) in enumerate(counts):
        ix, iy = cx, y
        if kind == "reply":
            d.rounded_rectangle([ix, iy - 8, ix + 15, iy + 2], 3, outline=DIM2, width=1)
            d.polygon([(ix + 3, iy + 2), (ix + 3, iy + 6), (ix + 8, iy + 2)], fill=DIM2)
        elif kind == "repost":
            d.line([(ix + 1, iy - 5), (ix + 13, iy - 5)], fill=DIM2, width=1)
            d.line([(ix + 13, iy - 5), (ix + 13, iy - 1)], fill=DIM2, width=1)
            d.polygon([(ix + 1, iy - 5), (ix + 5, iy - 8), (ix + 5, iy - 2)], fill=DIM2)
            d.line([(ix + 13, iy + 3), (ix + 1, iy + 3)], fill=DIM2, width=1)
            d.line([(ix + 1, iy + 3), (ix + 1, iy - 1)], fill=DIM2, width=1)
            d.polygon([(ix + 13, iy + 3), (ix + 9, iy), (ix + 9, iy + 6)], fill=DIM2)
        elif kind == "like":
            d.ellipse([ix, iy - 8, ix + 8, iy], outline=DIM2, width=1)
            d.ellipse([ix + 6, iy - 8, ix + 14, iy], outline=DIM2, width=1)
            d.polygon([(ix + 1, iy - 3), (ix + 13, iy - 3), (ix + 7, iy + 6)], fill=(0, 0, 0))
            d.line([(ix + 1, iy - 3), (ix + 7, iy + 6), (ix + 13, iy - 3)], fill=DIM2, width=1)
        elif kind == "views":
            for j, bh in enumerate((4, 7, 10, 13)):
                d.line([(ix + j * 4, iy + 4), (ix + j * 4, iy + 4 - bh)], fill=DIM2, width=1)
        elif kind == "bookmark":
            d.polygon([(ix + 2, iy - 8), (ix + 12, iy - 8), (ix + 12, iy + 5),
                       (ix + 7, iy + 1), (ix + 2, iy + 5)], outline=DIM2)
        elif kind == "share":
            d.line([(ix + 7, iy + 1), (ix + 7, iy - 8)], fill=DIM2, width=1)
            d.line([(ix + 3, iy - 4), (ix + 7, iy - 8), (ix + 11, iy - 4)], fill=DIM2, width=1)
            d.line([(ix + 1, iy - 2), (ix + 1, iy + 5), (ix + 13, iy + 5), (ix + 13, iy - 2)],
                   fill=DIM2, width=1)
        if label:
            tracked(d, (ix + 21, iy + 4), label, f, DIM2, 0)
        cx += step


# ------------------------------------------------------------- screenshot 1
im = ground(*SHOT, glow_at=(980, 120), radius=620)
d = ImageDraw.Draw(im)
lockup(d, 72, 92, 28)
y = caption(d, 72, 246, "The panel opens on the post.",
            "Point at a cashtag and price, depth, flow and a safety screening arrive "
            "without leaving the feed.")
# A real post, quoted verbatim, from the token's own account:
# https://x.com/ponsdotfamily/status/2093492560157167734
bottom = post(im, 72, y + 52, 500, "Pons", "@ponsdotfamily · Aug 29",
              [[("JUST IN: 29% of the total ", False), ("$PONS", True), (" supply", False)],
               [("has been burned!", False)],
               [("", False)],
               [("80% of Pons revenue goes towards", False)],
               [("accumulating ", False), ("$PONS", True)]],
              avatar="pons-avatar.jpg", acts=True)
# the post's real counts, read back the same day
acts_bar(im, 72, bottom - 24, 500,
         [("reply", "141"), ("repost", "190"), ("like", "1K"),
          ("views", "185K"), ("bookmark", ""), ("share", "")])
im = panel(im, 760, 186)
im.save(OUT / "screenshot-1-panel.png", optimize=True)

# ------------------------------------------------------------- screenshot 2
im = ground(*SHOT, glow_at=(300, 90), radius=620)
d = ImageDraw.Draw(im)
lockup(d, 72, 92, 28)
caption(d, 72, 176, "A ticker. Or a contract.",
        "Paste 44 characters of base58 and Xeet says what they turned out to mean before it opens anything.", width=600)

# the popup, drawn at its real 372px width
POPX, POPY, POPW, POPH = 72, 300, 372, 420
card(im, (POPX, POPY, POPX + POPW, POPY + POPH), 18, (16, 18, 21), (10, 11, 13), (40, 44, 49))
d = ImageDraw.Draw(im)
lockup(d, POPX + 18, POPY + 34, 20)
d.rounded_rectangle([POPX + POPW - 62, POPY + 16, POPX + POPW - 22, POPY + 39], 12,
                    fill=(48, 52, 56), outline=(70, 74, 78))
d.ellipse([POPX + POPW - 42, POPY + 18, POPX + POPW - 24, POPY + 37], fill=PAPER)

# the find field, holding a contract
d.rounded_rectangle([POPX + 16, POPY + 56, POPX + POPW - 62, POPY + 92], 11,
                    outline=PAPER, width=1)
tracked(d, (POPX + 28, POPY + 79), "0x39dBED3a2bd3…F813C4571", font("JetBrains Mono", 500, 12), WHITE, 0)
d.rounded_rectangle([POPX + POPW - 56, POPY + 56, POPX + POPW - 16, POPY + 92], 11, fill=PAPER)
d.ellipse([POPX + POPW - 44, POPY + 66, POPX + POPW - 28, POPY + 82], outline=VOID, width=2)
d.line([(POPX + POPW - 30, POPY + 80), (POPX + POPW - 25, POPY + 85)], fill=VOID, width=2)

# the row it resolved to
ry = POPY + 112
logo = Image.open(SITE / "img" / "tokens" / "pons.png").convert("RGBA").resize((34, 34), Image.LANCZOS)
lm = Image.new("L", (34, 34), 0)
ImageDraw.Draw(lm).rounded_rectangle([0, 0, 33, 33], 10, fill=255)
im.paste(logo.convert("RGB"), (POPX + 18, ry),
         Image.composite(lm, Image.new("L", (34, 34), 0), logo.split()[3]))
d = ImageDraw.Draw(im)
tracked(d, (POPX + 62, ry + 15), "PONS · Pons", font("Manrope", 800, 13), WHITE, -0.1)
cn = tracked(d, (POPX + 62, ry + 31), "ROBINHOOD CHAIN", font("JetBrains Mono", 700, 9), MUTED, 1.0)
tracked(d, (cn + 5, ry + 31), " · 0x39d…C4571", font("JetBrains Mono", 500, 9), MUTED, 0.4)
tracked(d, (POPX + POPW - 18, ry + 15), "$603M", font("Manrope", 800, 13), WHITE, -0.1, anchor="rs")
tracked(d, (POPX + POPW - 18, ry + 31), "$8.08M liq", font("JetBrains Mono", 700, 9), MUTED, 0.6, anchor="rs")
d.line([(POPX + 16, ry + 52), (POPX + POPW - 16, ry + 52)], fill=(35, 39, 43), width=1)

# the runner board under it
tracked(d, (POPX + 18, ry + 84), "Runners", font("Manrope", 800, 14), WHITE, -0.1)
for lane, on in (("5M", True), ("1H", False), ("6H", False), ("24H", False)):
    pass
board = [("bonk", "BONK", "SENDING", "$305M", "+125%", 3),
         ("wif", "WIF", "RUNNING", "$214M", "+41.2%", 2),
         ("pepe", "PEPE", "RUNNING", "$1.49B", "+18.4%", 2),
         ("pons", "PONS", "WARM", "$600M", "+12.4%", 1)]
by = ry + 100
STAGE = {3: WHITE, 2: DIM, 1: MUTED}
for name, sym, stage, cap, chg, bars in board:
    lg = Image.open(SITE / "img" / "tokens" / f"{name}.png").convert("RGBA").resize((30, 30), Image.LANCZOS)
    m2 = Image.new("L", (30, 30), 0)
    ImageDraw.Draw(m2).rounded_rectangle([0, 0, 29, 29], 9, fill=255)
    im.paste(lg.convert("RGB"), (POPX + 18, by + 10),
             Image.composite(m2, Image.new("L", (30, 30), 0), lg.split()[3]))
    d = ImageDraw.Draw(im)
    tracked(d, (POPX + 60, by + 24), sym, font("Manrope", 800, 12.5), WHITE, -0.1)
    # the three-bar meter, then the word
    bx = POPX + 60
    for i, (bh, byo) in enumerate([(4, 8), (7, 5), (10, 2)]):
        d.rounded_rectangle([bx + i * 4, by + 32 + byo, bx + i * 4 + 2.6, by + 40], 1,
                            fill=STAGE[bars] if i < bars else (60, 64, 68))
    tracked(d, (bx + 16, by + 40), stage, font("Manrope", 800, 8), STAGE[bars], 1.2)
    tracked(d, (POPX + POPW - 18, by + 24), cap, font("Manrope", 800, 12.5), WHITE, -0.1, anchor="rs")
    tracked(d, (POPX + POPW - 18, by + 40), chg, font("JetBrains Mono", 700, 9.5), WHITE, 0.6, anchor="rs")
    d.line([(POPX + 16, by + 52), (POPX + POPW - 16, by + 52)], fill=(28, 31, 35), width=1)
    by += 52

im = panel(im, 800, 170)
im.save(OUT / "screenshot-2-contract.png", optimize=True)

# ------------------------------------------------------------- screenshot 3
im = ground(*SHOT, glow_at=(640, 780), radius=700)
d = ImageDraw.Draw(im)
lockup(d, 72, 80, 26)
caption(d, 72, 150, "Your wallet signs. Xeet never sees a key.",
        "Routed by Jupiter on Solana and LI.FI on nine EVM chains. 0.5% per swap, "
        "and nothing on a trade that fails.", size=40, width=1130)

chips = ["NON-CUSTODIAL", "TEN CHAINS", "0.5% PER SWAP", "NO ACCOUNT", "NO TRACKING"]
cx = 72
for c in chips:
    f = font("JetBrains Mono", 700, 12)
    w = sum(f.getlength(ch) for ch in c) + 1.8 * (len(c) - 1)
    d.rounded_rectangle([cx, 236, cx + w + 36, 276], 20, outline=(60, 64, 68), width=1)
    tracked(d, (cx + 18, 261), c, f, DIM, 1.8)
    cx += w + 52

im = panel(im, 160, 306)
im = panel(im, 620, 306)
d = ImageDraw.Draw(im)
tracked(d, (160 + 187, 296), "BUY — AN OUTLINE", font("JetBrains Mono", 700, 11), MUTED, 1.6, anchor="ms")
tracked(d, (620 + 187, 296), "SELL — INVERTED", font("JetBrains Mono", 700, 11), MUTED, 1.6, anchor="ms")
# repaint the right card's action as the sell treatment
by = 306 + 272 + 150
d.rounded_rectangle([620 + 16, by, 620 + 374 - 16, by + 46], 14, fill=PAPER)
tracked(d, (620 + 374 / 2, by + 30), "HOVER TO SELL", font("Manrope", 800, 16), VOID, 2.4, anchor="ms")
im.save(OUT / "screenshot-3-noncustodial.png", optimize=True)

# ------------------------------------------------------- the small promo tile
im = ground(440, 280, glow_at=(360, 40), radius=260)
d = ImageDraw.Draw(im)
lockup(d, 32, 78, 30)
f = font("Manrope", 800, 30)
tracked(d, (32, 152), "Swap at the", f, WHITE, -1.0)
x = tracked(d, (32, 190), "speed of", f, WHITE, -1.0)
x = xmark(d, x + 10, 190, cap=22, width=20, stroke=6)
d.text((x + 6, 190), ".", font=f, fill=WHITE, anchor="ls")
tracked(d, (32, 228), "A CHROME EXTENSION FOR X", font("JetBrains Mono", 700, 10), MUTED, 1.8)
im.save(OUT / "promo-tile-440x280.png", optimize=True)

# ------------------------------------------------------------- the marquee
im = ground(1400, 560, glow_at=(1080, 120), radius=640)
d = ImageDraw.Draw(im)
lockup(d, 96, 150, 34)
h1 = font("Manrope", 800, 72)
tracked(d, (96, 268), "Swap at the", h1, WHITE, -2.2)
x = tracked(d, (96, 344), "speed of", h1, WHITE, -2.2)
x = xmark(d, x + 20, 344, cap=52, width=48, stroke=12)
d.text((x + 12, 344), ".", font=h1, fill=WHITE, anchor="ls")
tracked(d, (96, 398), "NON-CUSTODIAL · 0.5% PER SWAP", font("JetBrains Mono", 700, 15), MUTED, 2.41)
im = panel(im, 880, 40)
im.save(OUT / "marquee-1400x560.png", optimize=True)

for p in sorted(OUT.iterdir()):
    with Image.open(p) as i:
        print(f"  {p.name:34s} {i.size[0]}x{i.size[1]}  {p.stat().st_size // 1024}KB")
