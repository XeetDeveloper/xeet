#!/usr/bin/env python3
"""Drawing machinery for the project's rendered artwork.

The social card and the Chrome Web Store screenshots are drawn rather than
screenshotted: the page they depict is a sticky 3D stage that no headless
capture in this project has been able to composite, and the store wants exact
pixel sizes a scaled pane cannot give.

Everything here is the site's own material — its fonts, unpacked out of the
woff2 subsets the page already serves, its palette, and the real PONS figures
the scrolly fixture uses — so the artwork cannot drift from the product by
having been made somewhere else.

Consumers: tools/make-og.py, tools/make-store-assets.py
"""
import pathlib
import re
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
W, H = 1200, 630

# --- palette (the monochrome ladder, from site.css) -----------------------
VOID, PAPER, WHITE = (8, 9, 10), (242, 244, 243), (255, 255, 255)
DIM, MUTED, FAINT = (201, 207, 211), (138, 145, 153), (107, 118, 128)
CARD_HI, CARD_LO = (30, 34, 40), (14, 16, 20)
HAIRLINE = (44, 48, 54)

# --- the fonts the page itself loads --------------------------------------
_cache = {}


def font(family, weight, size):
    """A PIL font from the site's own woff2 subsets, instanced at one weight.

    The files are variable and brotli-compressed; fontTools decompresses and
    pins the axis, which is the only way to get the exact faces the page
    renders rather than a lookalike from the system."""
    key = (family, weight)
    if key not in _cache:
        css = (SITE / "fonts" / "fonts.css").read_text()
        src = None
        for block in re.findall(r"@font-face\s*\{([^}]*)\}", css):
            fam = re.search(r"font-family:\s*'([^']+)'", block).group(1)
            rng = re.search(r"unicode-range:\s*([^;]+)", block)
            if fam == family and rng and "U+0000-00FF" in rng.group(1):
                src = re.search(r"url\((m\d+)\.woff2\)", block).group(1)
                break
        if not src:
            raise SystemExit(f"no latin subset for {family}")
        f = TTFont(SITE / "fonts" / f"{src}.woff2")
        f.flavor = None
        out = pathlib.Path("/tmp") / f"xeet-{family.replace(' ', '')}-{weight}.ttf"
        instantiateVariableFont(f, {"wght": weight}).save(out)
        _cache[key] = out
    return ImageFont.truetype(str(_cache[key]), size)


def tracked(d, xy, text, f, fill, tracking=0.0, anchor="ls"):
    """Letter-spacing, which PIL has no concept of and this design needs."""
    x, y = xy
    if anchor.startswith("m"):
        w = sum(f.getlength(c) for c in text) + tracking * (len(text) - 1)
        x -= w / 2
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill, anchor="l" + anchor[1])
        x += f.getlength(ch) + tracking
    return x - tracking


def wrap(text, f, tracking, max_w):
    """Break a line to a width. Every caption in the store artwork sits beside
    the panel, and a headline that runs under it is the one mistake a store
    screenshot cannot survive."""
    words, lines, cur = text.split(), [], ""
    def width(t):
        return sum(f.getlength(c) for c in t) + tracking * max(0, len(t) - 1)
    for w in words:
        trial = (cur + " " + w).strip()
        if cur and width(trial) > max_w:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def vgrad(size, top, bottom):
    g = Image.new("RGB", (1, size[1]))
    px = g.load()
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return g.resize(size)


def card(im, box, radius, top, bottom, border=HAIRLINE):
    x0, y0, x1, y1 = (round(v) for v in box)
    box = (x0, y0, x1, y1)
    panel = vgrad((x1 - x0, y1 - y0), top, bottom)
    mask = Image.new("L", (x1 - x0, y1 - y0), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, x1 - x0 - 1, y1 - y0 - 1], radius, fill=255)
    im.paste(panel, (x0, y0), mask)
    ImageDraw.Draw(im).rounded_rectangle(box, radius, outline=border, width=1)


# --------------------------------------------------------------- the ground
def ground(w, h, glow_at=None, radius=520):
    """The void, with one soft field over it.

    The field is computed per pixel at a sixteenth scale and resized: drawing
    it as stacked ellipses lays down visible contour rings, which is exactly
    the artefact a gradient exists to avoid."""
    import math
    im = Image.new("RGB", (w, h), VOID)
    if glow_at is None:
        return im
    gw, gh = max(1, w // 16), max(1, h // 16)
    glow = Image.new("L", (gw, gh))
    gp = glow.load()
    cx, cy, rad = glow_at[0] / 16, glow_at[1] / 16, radius / 16
    for gy in range(gh):
        for gx in range(gw):
            t = math.hypot(gx - cx, gy - cy) / rad
            gp[gx, gy] = int(max(0.0, 1.0 - t) ** 2 * 26)
    im.paste(Image.new("RGB", (w, h), (255, 255, 255)), (0, 0), glow.resize((w, h), Image.BICUBIC))
    return im


_MARK = {}


def mark(d, x, y, s, fill):
    """The Xeet glyph, pasted into an s x s box at (x, y).

    It used to be two polygons. It is now a render, so it arrives as pixels
    from brand/mark.png — the same master the icons and the lockup come from,
    tinted to `fill` through its own alpha so it still takes a colour the way
    a drawn glyph did.

    The box stays square even though the artwork is not, and the artwork is
    centred in it, so every existing call site keeps its layout."""
    im = getattr(d, "_image", None)
    if im is None:                       # Pillow renamed it out from under us
        raise RuntimeError("cannot reach the image behind this ImageDraw")

    key = (s, fill)
    if key not in _MARK:
        src = Image.open(ROOT / "brand" / "mark.png").convert("RGBA")
        scale = s / max(src.width, src.height)
        g = src.resize((max(1, round(src.width * scale)),
                        max(1, round(src.height * scale))), Image.LANCZOS)
        tinted = Image.new("RGBA", g.size, fill if isinstance(fill, tuple) else fill)
        tinted.putalpha(g.getchannel("A"))
        _MARK[key] = tinted
    g = _MARK[key]
    # paste-with-mask rather than alpha_composite: the grounds these are drawn
    # on are RGB, which alpha_composite refuses.
    im.paste(g, (round(x + (s - g.width) / 2), round(y + (s - g.height) / 2)), g)


# Where the X is inside brand/mark.png, measured rather than guessed: the
# letter is rows 9..415 of 464 and columns 12..444 of 512, and the cursor is
# the rest — 67px further right, 47px lower.
MARK_BOX = (12, 9, 444, 415)
MARK_FULL = (512, 464)


def lockup(d, x, baseline, size=34, fill=PAPER):
    """The mark AS the letter X, followed by "eet".

    It used to be the mark beside a whole "xeet", which spelled the X twice.
    Setting it as a letter means fitting the X's own box to the cap height and
    the baseline — not the whole image, whose cursor hangs past both — and then
    starting the word clear of that cursor, since it reaches into exactly the
    space an "e" would occupy.
    """
    f = font("Manrope", 800, size)
    mx0, my0, mx1, my1 = MARK_BOX
    cap = f.getbbox("X")[3] - f.getbbox("X")[1]     # this face's cap height, in px
    s = cap / (my1 - my0)

    im = getattr(d, "_image", None)
    if im is None:
        raise RuntimeError("cannot reach the image behind this ImageDraw")
    src = Image.open(ROOT / "brand" / "mark.png").convert("RGBA")
    g = src.resize((max(1, round(MARK_FULL[0] * s)), max(1, round(MARK_FULL[1] * s))),
                   Image.LANCZOS)
    tinted = Image.new("RGBA", g.size, fill)
    tinted.putalpha(g.getchannel("A"))
    im.paste(tinted, (round(x - mx0 * s), round(baseline - my1 * s)), tinted)

    word_x = x - mx0 * s + MARK_FULL[0] * s + 0.20 * cap
    return tracked(d, (word_x, baseline), "eet", f, fill, -0.6)


def xmark(d, x, baseline, cap=54, width=50, stroke=13, fill=WHITE):
    """𝕏 is outside the latin subset the page ships, so the mark is drawn — at
    the headline's own cap height and stroke weight, or it reads as a
    different font."""
    d.line([(x, baseline - cap), (x + width, baseline)], fill=fill, width=stroke)
    d.line([(x + width, baseline - cap), (x, baseline)], fill=fill, width=stroke)
    return x + width


# ----------------------------------------------------------- the panel art
def panel(im, PX, PY, PW=374):
    """The product's card as the page draws it: the intel card, and the raised
    action deck overlapping its bottom edge.

    Returns a NEW image — the chart's fade is composited, which cannot be done
    in place — so callers must use the return value."""
    d = ImageDraw.Draw(im)
    card(im, (PX, PY, PX + PW, PY + 282), 20, CARD_HI, CARD_LO)

    # the token's own art, in colour: it is the one thing on the card a person
    # recognises without reading
    logo = Image.open(SITE / "img" / "tokens" / "pons.png").convert("RGBA").resize((46, 46), Image.LANCZOS)
    lm = Image.new("L", (46, 46), 0)
    ImageDraw.Draw(lm).rounded_rectangle([0, 0, 45, 45], 13, fill=255)
    im.paste(logo.convert("RGB"), (PX + 26, PY + 34),
             Image.composite(lm, Image.new("L", (46, 46), 0), logo.split()[3]))

    tracked(d, (PX + 86, PY + 60), "PONS", font("Manrope", 800, 25), WHITE, -0.5)
    tracked(d, (PX + 86, PY + 80), "PONS · ROBINHOOD CHAIN", font("JetBrains Mono", 500, 11), MUTED, 1.2)

    # the screening seal rides the avatar's top-left corner, where the panel
    # puts it — floating past the card's opposite corner reads as a sticker
    sx, sy = PX + 26, PY + 34
    d.rounded_rectangle([sx - 11, sy - 11, sx + 11, sy + 11], 8, fill=PAPER, outline=VOID, width=3)
    d.line([(sx - 5, sy + 1), (sx - 1, sy + 5), (sx + 5, sy - 5)], fill=VOID, width=3, joint="curve")

    pend = tracked(d, (PX + 22, PY + 122), "$0.8544", font("JetBrains Mono", 700, 34), WHITE, -0.5)
    tracked(d, (pend + 14, PY + 120), "+12.4%", font("Manrope", 800, 15), WHITE, 0.6)

    rx = PX + PW - 112
    for label, on in (("1H", False), ("24H", True), ("7D", False)):
        f = font("JetBrains Mono", 700, 11)
        w = sum(f.getlength(c) for c in label) + 2
        if on:
            d.rounded_rectangle([rx - 7, PY + 105, rx + w + 7, PY + 125], 7, outline=DIM, width=1)
        tracked(d, (rx, PY + 120), label, f, WHITE if on else MUTED, 1.0)
        rx += w + 24

    # the chart — the same accelerating walk, from the same seed, that the
    # panel's own fixture draws, so the картинка and the page agree
    import math
    state = [0x5EED1]

    def rnd():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7FFFFFFF
        return state[0] / 0x7FFFFFFF

    pts = []
    for i in range(90):
        t = i / 89
        v = (8 + 25 * (t ** 1.8)
             - 3.4 * math.exp(-((t - 0.3) / 0.09) ** 2)
             + (rnd() - 0.5) * 2.3 * (1 - 0.45 * t))
        v = max(5, min(35, v))
        pts.append((PX + 6 + t * (PW - 12), PY + 212 - v * 1.5))

    # The fill under the line fades to nothing, like the panel's gradient. A
    # flat alpha ends on a hard horizontal edge and reads as a grey block
    # sitting in the card rather than as depth under a line.
    top, bot = int(min(y for _, y in pts)), PY + 216
    shape = Image.new("L", im.size, 0)
    ImageDraw.Draw(shape).polygon(pts + [(pts[-1][0], bot), (pts[0][0], bot)], fill=255)
    ramp = Image.new("L", (1, bot - top))
    rp = ramp.load()
    for i in range(bot - top):
        rp[0, i] = int(46 * (1 - i / (bot - top)) ** 1.3)
    fade = Image.new("L", im.size, 0)
    fade.paste(ramp.resize((im.size[0], bot - top)), (0, top))
    im = Image.composite(Image.new("RGB", im.size, WHITE), im,
                         Image.composite(fade, Image.new("L", im.size, 0), shape))
    d = ImageDraw.Draw(im)
    d.line(pts, fill=WHITE, width=2, joint="curve")

    cw = (PW - 44) // 3
    for i, (k, v) in enumerate([("MCAP", "$600.4M"), ("LIQ", "$8.04M"), ("24H VOL", "$11.1M")]):
        cx = PX + 22 + i * cw
        tracked(d, (cx, PY + 238), k, font("JetBrains Mono", 500, 10), MUTED, 1.1)
        tracked(d, (cx, PY + 258), v, font("Manrope", 800, 16), WHITE, -0.2)

    # the deck, overlapping the intel card's bottom edge
    DY = PY + 272
    card(im, (PX, DY, PX + PW, DY + 210), 20, (28, 32, 38), (14, 16, 20), (52, 56, 62))
    for i, (k, v) in enumerate([("SELLING", "ETH"), ("BUYING", "PONS"),
                                ("SLIPPAGE", "1%"), ("WALLET", "MetaMask")]):
        ry = DY + 34 + i * 30
        tracked(d, (PX + 22, ry), k, font("JetBrains Mono", 500, 10), MUTED, 1.1)
        tracked(d, (PX + 118, ry), v, font("Manrope", 800, 14), WHITE, -0.1)
        if i < 3:
            d.line([(PX + 16, ry + 12), (PX + PW - 16, ry + 12)], fill=(34, 38, 44), width=1)

    # BUY is an outline, because in this palette a buy is an outline
    # and a sell is the inverted block
    by = DY + 150
    d.rounded_rectangle([PX + 16, by, PX + PW - 16, by + 46], 14, outline=PAPER, width=1)
    # The product stopped asking for a hover before it would show an amount,
    # and this said otherwise for several releases — artwork advertising a step
    # the extension no longer has.
    tracked(d, (PX + PW / 2, by + 30), "BUY", font("Manrope", 800, 16), PAPER, 2.4, anchor="ms")
    return im


PANEL_H = 482  # intel (282) + the deck hanging below it
