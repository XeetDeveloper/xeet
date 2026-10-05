#!/usr/bin/env python3
"""Draw site/og.png — the card that shows when the link is shared.

    python3 tools/make-og.py
"""
from PIL import ImageDraw
from artwork import (SITE, font, tracked, ground, lockup, xmark, panel,
                     WHITE, MUTED)

W, H = 1200, 630

im = ground(W, H, glow_at=(900, 120))
d = ImageDraw.Draw(im)

lockup(d, 84, 210)

h1 = font("Manrope", 800, 76)
tracked(d, (84, 316), "Swap at the", h1, WHITE, -2.4)
x = tracked(d, (84, 392), "speed of", h1, WHITE, -2.4)
x = xmark(d, x + 22, 392)
d.text((x + 12, 392), ".", font=h1, fill=WHITE, anchor="ls")

tracked(d, (84, 448), "NON-CUSTODIAL · 0.5% PER SWAP",
        font("JetBrains Mono", 700, 15), MUTED, 2.41)

im = panel(im, 700, 108)

out = SITE / "og.png"
im.save(out, optimize=True)
print(f"wrote site/og.png  {im.size[0]}x{im.size[1]}  {out.stat().st_size // 1024}KB")
