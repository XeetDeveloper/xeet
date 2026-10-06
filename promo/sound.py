#!/usr/bin/env python3
"""The teaser's audio bed, synthesised rather than licensed.

Nine seconds, three parts that line up with the three shots:

  0.0–6.0  a slow sub-bass pulse on every beat, so the clip has a heartbeat
  3.0–7.3  a rising tone under it, quiet at first, that pulls toward the cut
  7.3      one impact — the hit SOON lands on — and a long tail into silence

No samples, no library, no rights to clear: every sound here is arithmetic.
Written as 48 kHz stereo PCM, which is what the renderer wants.

    python3 promo/sound.py    ->  promo/bed.wav
"""
import math, os, struct, wave

SR = 48000
DUR = 22.0
HIT = 18.4          # the frame SOON appears on
BPM = 80


def env(t, attack, decay):
    """A percussive envelope: fast in, exponential out."""
    if t < 0:
        return 0.0
    if t < attack:
        return t / attack
    return math.exp(-(t - attack) / decay)


n = int(SR * DUR)
left = [0.0] * n
right = [0.0] * n
beat = 60.0 / BPM

for i in range(n):
    t = i / SR
    s = 0.0

    # -- the pulse: a sub drop on each beat, fading out before the impact
    k = int(t / beat)
    tb = t - k * beat
    if t < HIT - 0.2:
        fade = min(1.0, t / 1.2) * max(0.0, 1.0 - max(0.0, t - 17.0) / 1.2)
        f = 54.0 * math.exp(-tb * 7.0) + 32.0           # a pitch drop reads as weight
        s += 0.55 * fade * env(tb, 0.004, 0.16) * math.sin(2 * math.pi * f * tb)

    # -- the riser: two detuned tones climbing a fifth, kept under the pulse
    if 12.0 < t < HIT:
        u = (t - 12.0) / (HIT - 12.0)
        amp = 0.11 * u * u
        f = 180.0 * (1.0 + 0.5 * u * u)
        s += amp * (math.sin(2 * math.pi * f * t) + math.sin(2 * math.pi * f * 1.004 * t + 0.7)) * 0.5
        # air: a hiss that opens with the riser
        s += amp * 0.5 * (math.sin(2 * math.pi * 7000 * t) * math.sin(2 * math.pi * 311 * t))

    # -- the impact, and its long tail
    if t >= HIT:
        td = t - HIT
        f = 48.0 * math.exp(-td * 2.2) + 30.0
        s += 0.85 * env(td, 0.002, 0.55) * math.sin(2 * math.pi * f * td)
        s += 0.18 * env(td, 0.001, 0.09) * math.sin(2 * math.pi * 2400 * td)   # the click of it
        s += 0.10 * env(td, 0.06, 1.5) * math.sin(2 * math.pi * 110 * td)      # the room after

    # the last third of a second belongs to silence
    if t > DUR - 0.35:
        s *= max(0.0, (DUR - t) / 0.35)

    # a few milliseconds of width, so it is not a mono dot between the ears
    left[i] = s
    right[i] = s
d = int(SR * 0.012)
for i in range(n - 1, d - 1, -1):
    right[i] = 0.82 * right[i] + 0.18 * right[i - d]

peak = max(max(abs(v) for v in left), max(abs(v) for v in right)) or 1.0
scale = 0.89 / peak

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.environ.get("BED", "bed.wav"))
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    frames = bytearray()
    for i in range(n):
        for v in (left[i], right[i]):
            x = max(-1.0, min(1.0, v * scale))
            frames += struct.pack("<h", int(x * 32767))
    w.writeframes(bytes(frames))
print(out, os.path.getsize(out), "bytes,", DUR, "s")
