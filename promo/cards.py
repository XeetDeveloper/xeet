#!/usr/bin/env python3
"""Three launch cards: the art from OpenAI, the words and the mark from us.

The model draws the surface and the light only. Type and logo are composited
afterwards, because an image model writes letters that look like letters and a
logo that looks like the logo — close enough to pass at a glance and wrong
everywhere it matters.

    python3 promo/cards.py        # skips art already on disk
"""
import base64, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "cards")
# OpenAI first for images, but that key is out of credits — MiniMax draws
# these. Same prompts; the words and the mark are ours either way.
KEY = None
for line in open(os.path.expanduser("~/.config/minimax.env")):
    if line.strip().startswith("#") or "=" not in line:
        continue
    KEY = line.strip().split("=", 1)[1].strip().strip('"').strip("'")

STYLE = (" Monochrome: deep black, graphite and cold white only, no other colour. "
         "Extremely shallow depth of field, volumetric haze, glossy specular highlights, "
         "cinematic product-commercial lighting, patient and expensive. The centre of the frame "
         "is calm and almost empty so that type can sit there. "
         "No text, no letters, no numbers, no logos, no interface, no people.")

CARDS = {
    "solana": "A wide dark void. Three slender parallel bands of cold white light cut diagonally "
              "across the lower third like a slipstream, their edges soft and slightly out of focus, "
              "reflected in a black glass floor beneath them. A faint cool haze above." + STYLE,

    "burnt":  "A wide dark void. A single white-hot ember of molten material floats at the lower edge "
              "of the frame and dissolves upward into fine pale ash and smoke, lit from one side. "
              "The smoke thins out toward the top of the frame." + STYLE,

    "dex":    "A wide dark void. A polished black glass tile lies flat, lit by one cold source, with a "
              "clean rim of light along its top edge and a soft glow pooling under it, as if something "
              "has just been switched on beneath the surface." + STYLE,
}


def generate(name, prompt):
    dst = os.path.join(OUT, f"{name}.jpg")
    if os.path.exists(dst):
        print(f"{name}: already on disk")
        return dst
    body = {"model": "image-01", "prompt": prompt, "aspect_ratio": "3:2",
            "response_format": "base64", "n": 1}
    out = subprocess.run(
        ["curl", "-s", "-m", "300", "https://api.minimax.io/v1/image_generation",
         "-H", f"Authorization: Bearer {KEY}", "-H", "Content-Type: application/json",
         "--data-binary", "@-"],
        input=json.dumps(body).encode(), capture_output=True).stdout
    try:
        d = json.loads(out or b"{}")
    except json.JSONDecodeError:
        print(f"{name}: unreadable answer {out[:160]!r}")
        return None
    imgs = (d.get("data") or {}).get("image_base64") or []
    b64 = imgs[0] if imgs else None
    if not b64:
        print(f"{name}: {json.dumps(d)[:220]}")
        return None
    open(dst, "wb").write(base64.b64decode(b64))
    print(f"{name}: {os.path.getsize(dst)} bytes")
    return dst


os.makedirs(OUT, exist_ok=True)
for name, prompt in CARDS.items():
    generate(name, prompt)
