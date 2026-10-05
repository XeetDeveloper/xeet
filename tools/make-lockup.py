#!/usr/bin/env python3
"""Draw site/lockup.svg — the mark plus the wordmark, as outlines.

The wordmark is set in Manrope 800, the site's own display face, and converted
to path data rather than left as <text>: an SVG that names a font renders in
whatever the viewer happens to have, and this file is used as an <img>, where
no stylesheet can reach it.

    python3 tools/make-lockup.py
"""
import base64
import io
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
# The mark IS the X. It used to sit beside a full "xeet", which spelled the
# letter twice; the word it starts is "eet".
WORD = "eet"
FILL = "#F2F4F3"

# The mark is a render, not a drawing, so it rides along as an embedded image
# rather than as paths. Embedded rather than linked because this file is used
# as an <img>: an external reference inside it would never be fetched.
MARK = ROOT / "brand" / "mark.png"

# Where the letter is inside the artwork, measured off brand/mark.png rather
# than guessed. The X's own body is rows 9..415 of 464 and columns 12..444 of
# 512; the cursor is the rest — 67px further right and 47px lower. Setting the
# mark as a letter means fitting THAT box to the cap height and baseline, not
# the whole image, or the cursor's overhang would push the X up off the line.
MARK_BOX = (12, 9, 444, 415)     # left, top, right, bottom of the X itself
MARK_FULL = (512, 464)

# --- the wordmark, as outlines -------------------------------------------
css = (SITE / "fonts" / "fonts.css").read_text()
src = None
for block in re.findall(r"@font-face\s*\{([^}]*)\}", css):
    fam = re.search(r"font-family:\s*'([^']+)'", block).group(1)
    rng = re.search(r"unicode-range:\s*([^;]+)", block)
    if fam == "Manrope" and rng and "U+0000-00FF" in rng.group(1):
        src = re.search(r"url\((m\d+)\.woff2\)", block).group(1)
        break
f = TTFont(SITE / "fonts" / f"{src}.woff2")
f.flavor = None
f = instantiateVariableFont(f, {"wght": 800})
upem = f["head"].unitsPerEm
gs = f.getGlyphSet()
cmap = f.getBestCmap()
hmtx = f["hmtx"]

SCALE = 78 / upem          # em -> lockup units
CAP = f["OS/2"].sCapHeight * SCALE   # the height an X in this face stands
TRACK = -0.022 * upem      # the site sets the lockup at -0.022em
paths, pen_x = [], 0
for ch in WORD:
    g = cmap[ord(ch)]
    pen = SVGPathPen(gs)
    gs[g].draw(pen)
    d = pen.getCommands()
    if d:
        paths.append((d, pen_x))
    pen_x += hmtx[g][0] + TRACK
word_w = (pen_x - TRACK) * SCALE

# --- compose --------------------------------------------------------------
BASE = 76                  # Manrope's baseline sits at 0; this is where we put it

mx0, my0, mx1, my1 = MARK_BOX
s_mark = CAP / (my1 - my0)                 # X body height -> cap height
MARK_W = MARK_FULL[0] * s_mark             # the whole image, cursor included
MARK_H = MARK_FULL[1] * s_mark
MARK_X = -mx0 * s_mark                     # the X's left edge lands on x = 0
MARK_Y = BASE - my1 * s_mark               # and its foot on the baseline

# The word starts clear of the CURSOR, not of the X. The cursor hangs into the
# lower right, which is exactly where an "e" would be, so measuring the gap
# from the letter alone puts the pointer through it. 0.20 of the cap was
# picked against 0.10/0.28/0.36 side by side: tighter and the pointer touches
# the e, looser and the mark stops reading as the word's first letter.
GAP = 0.20 * CAP
WORD_X = MARK_X + mx1 * s_mark + (MARK_FULL[0] - mx1) * s_mark + GAP
H = 100
W = WORD_X + word_w

# The master is 512px tall; the header draws this at 21-28px, so most of that
# is weight nobody sees on a file every page loads. 240px keeps three times
# the pixels a 3x display asks for, and the artwork is flat white under its
# alpha, so grayscale+alpha stores it without losing anything: 118KB -> 29KB.
src = Image.open(MARK)
embed = src.resize((round(src.width * 240 / src.height), 240), Image.LANCZOS).convert("LA")
buf = io.BytesIO()
embed.save(buf, "PNG", optimize=True)
data = base64.b64encode(buf.getvalue()).decode()

parts = [f'<image x="{MARK_X:.2f}" y="{MARK_Y:.2f}" width="{MARK_W:.2f}" '
         f'height="{MARK_H:.2f}" xlink:href="data:image/png;base64,{data}"/>']
for d, x in paths:
    tx = WORD_X + x * SCALE
    parts.append(f'<path d="{d}" transform="translate({tx:.2f} {BASE:.2f}) scale({SCALE:.5f} {-SCALE:.5f})"/>')

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" '
       f'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {W:.1f} {H}" '
       f'width="{W:.1f}" height="{H}" fill="{FILL}">'
       + "".join(parts) + "</svg>")

for out in (SITE / "lockup.svg", ROOT / "extension" / "icons" / "lockup.svg"):
    out.write_text(svg)
    print(f"wrote {out.relative_to(ROOT)}  {W:.0f}x{H}  {out.stat().st_size} bytes  word='{WORD}'")
