#!/usr/bin/env python3
"""Render each collected post as X draws it, and trim the result to the card.

The still comes out of Remotion's TweetEmbed composition, which loads X's own
widget — so what lands on disk is the platform's card, not an imitation of one.
The crop is measured, not guessed: the card is the only thing on a flat ground,
so its bounding box is whatever differs from the corner pixel.

    python3 promo/shots.py          # skips shots already on disk
"""
import json, os, subprocess, sys

from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO = os.path.expanduser("~/Projects/promo-videos")
OUT = os.path.join(VIDEO, "public", "xeet", "shots")
posts = json.load(open(os.path.join(HERE, "posts.json")))
os.makedirs(OUT, exist_ok=True)

kept = []
for i, p in enumerate(posts):
    dst = os.path.join(OUT, f"{i:02d}.png")
    if not os.path.exists(dst):
        props = os.path.join("/tmp", f"xeet-props-{i}.json")
        json.dump({"id": p["url"].rsplit("/", 1)[-1], "handle": p["handle"]}, open(props, "w"))
        r = subprocess.run(
            ["npx", "remotion", "still", "TweetEmbed", dst, f"--props={props}", "--log=error"],
            cwd=VIDEO, capture_output=True)
        if r.returncode != 0 or not os.path.exists(dst):
            print(f"{i:02d} {p['handle']}: render failed", flush=True)
            continue

    im = Image.open(dst).convert("RGB")
    ground = Image.new("RGB", im.size, im.getpixel((2, 2)))
    box = ImageChops.difference(im, ground).convert("L").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not box or box[3] - box[1] < 160:
        print(f"{i:02d} {p['handle']}: the widget did not load — dropped", flush=True)
        os.remove(dst)
        continue
    im.crop(box).save(dst)
    kept.append({**p, "shot": f"xeet/shots/{i:02d}.png",
                 "w": box[2] - box[0], "h": box[3] - box[1]})
    print(f"{i:02d} {p['handle']:<18} {box[2]-box[0]}x{box[3]-box[1]}", flush=True)

json.dump(kept, open(os.path.join(VIDEO, "public", "xeet", "shots.json"), "w"), indent=1, ensure_ascii=False)
print(f"\n{len(kept)} shots -> public/xeet/shots/")
