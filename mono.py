#!/usr/bin/env python3
"""Repaint Xeet in black and white.

Every colour in the product carried a job, not a hue. This maps each job onto
a step of one grey ladder, so nothing is left approximated by eye:

    #FFFFFF  the brightest step   — a primary fill, a confirmed thing
    #F2F4F3  paper                — the accent, and all primary text
    #C9CFD3  dim                  — body text, active hairlines
    #9AA3AA  quiet                — connection, links, the equity class
    #8A9199  muted                — secondary text
    #23272B  line                 — hairlines at rest
    #08090A  void                 — the ground, and ink on a white fill

The three signals colour used to carry alone — buy vs sell, danger, and the
run stage — cannot survive a hue-to-grey swap on their own, because mint and
danger both land on white. They are re-established structurally in the
MONOCHROME block appended to loupe.css and site.css: fill versus outline for
direction, a hazard hatch for danger, and brightness for stage.

Run once. Idempotent — the greys it writes are not in its own input map.
"""
import re
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent

# job -> step. Left column is what the product shipped.
HEX = {
    # mint: the primary action, and anything confirmed
    "#C6F24E": "#F2F4F3", "#E8FBB4": "#FFFFFF", "#DDF98F": "#FFFFFF",
    "#D8FA7C": "#FFFFFF", "#E4FB9A": "#FFFFFF", "#A7DA2C": "#B9C0C6",
    "#9BD11F": "#C9CFD3", "#CCFF00": "#F2F4F3",
    # danger: the sell side, loss, destructive controls
    "#FF6B4A": "#F2F4F3", "#FFA98F": "#FFFFFF", "#FFC9BA": "#FFFFFF",
    "#FFD9DD": "#FFFFFF", "#FFD9D0": "#FFFFFF", "#FF8A93": "#F2F4F3",
    "#2A0E06": "#08090A",
    # flux: connection, live states, chain marks, tokenised equities
    "#5AD1E6": "#9AA3AA", "#9BE4F2": "#C9CFD3", "#7BDCEC": "#C9CFD3",
    "#EAF7FA": "#F2F4F3", "#0A1519": "#0C0E10", "#8FC7FF": "#C9CFD3",
    # amber: awaiting an allowance, bridging, "new" tags
    "#FFC773": "#C9CFD3", "#FFD79A": "#E6EAEC", "#FFE2B0": "#F2F4F3",
    "#FFB067": "#C9CFD3", "#2A1C06": "#08090A", "#2A1C05": "#08090A",
}

RGB = {
    (198, 242, 78): (242, 244, 243),   # mint
    (155, 209, 31): (201, 207, 211),   # mint-deep
    (255, 107, 74): (242, 244, 243),   # danger
    (255, 150, 120): (242, 244, 243),
    (255, 199, 115): (201, 207, 211),  # amber
    (255, 140, 60): (201, 207, 211),
    (90, 209, 230): (154, 163, 170),   # flux
    (110, 170, 255): (154, 163, 170),
    (74, 222, 128): (242, 244, 243),   # the one green left in the flow bar
}

TARGETS = [
    "site/site.css", "site/loupe.css", "site/site.js", "site/panel.html",
    "site/favicon.svg", "site/lockup.svg",
    "extension/assets/loupe.css", "extension/assets/xeet.css",
    "extension/popup/popup.css", "extension/src/panel.js",
    "extension/src/panel-html.js", "extension/icons/favicon.svg",
    "extension/icons/lockup.svg",
]


def repaint(text):
    def hex_sub(m):
        return HEX.get(m.group(0).upper(), m.group(0))
    text = re.sub(r"#[0-9a-fA-F]{6}\b", hex_sub, text)

    def rgb_sub(m):
        r, g, b = int(m.group(2)), int(m.group(3)), int(m.group(4))
        if (r, g, b) in RGB:
            r, g, b = RGB[(r, g, b)]
        return f"{m.group(1)}({r}, {g}, {b}"
    return re.sub(r"(rgba?)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", rgb_sub, text)


changed = 0
for rel in TARGETS:
    p = ROOT / rel
    if not p.exists():
        sys.exit(f"missing {rel}")
    before = p.read_text(encoding="utf-8")
    after = repaint(before)
    if after != before:
        p.write_text(after, encoding="utf-8")
        changed += 1
    print(f"  {'repainted' if after != before else 'unchanged'}  {rel}")
print(f"{changed} file(s) repainted")
