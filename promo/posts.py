#!/usr/bin/env python3
"""Collect real posts that carry a contract address, for the teaser's backdrop.

They are shown as they were published — same name, same handle, same words,
same counts, same avatar. Nothing is rewritten and nothing is invented: a post
in a film is a quotation, and a quotation that has been edited is a forgery.

    python3 promo/posts.py          -> promo/posts.json + promo/av/*.jpg

curl, not urllib: no CA bundle this Python will accept.
"""
import json, os, re, subprocess, sys, time

KEY = None
for line in open(os.path.expanduser("~/.config/twitterapi.env")):
    if line.strip().startswith("#") or "=" not in line:
        continue
    # the file writes it as `export NAME="value"` — quotes and all
    KEY = line.strip().split("=", 1)[1].strip().strip('"').strip("'")
API = "https://api.twitterapi.io/twitter/tweet/advanced_search"
HERE = os.path.dirname(os.path.abspath(__file__))
AV = os.path.join(HERE, "av")
WANT = 26

# Memecoins specifically: a ticker and an address in the same post, which is
# what the timeline actually looks like when one of these launches.
QUERIES = [
    '"CA:" 0x lang:en',
    '"CA:" pump lang:en',
    '"CA" $ 0x lang:en',
    '"just launched" "CA" lang:en',
    '"stealth launch" lang:en',
    '"liquidity locked" $ lang:en',
    '"lp burned" lang:en',
    '"dev bought" lang:en',
    '"new pair" 0x lang:en',
    '"pump.fun" "CA" lang:en',
    '$PONS lang:en',
    '"memecoin" "CA:" lang:en',
]

# Nothing with slurs, porn spam or giveaway-scam shapes goes on screen.
BAD = re.compile(
    r"\b(nigg|fag|rape|porn|nude|onlyfans|sex|cunt|whore|retard)|"
    r"(giveaway|airdrop claim|connect your wallet|dm me|send \d+ (sol|eth))",
    re.I,
)
# What has to be ON the post for it to belong in this film: an address, or a
# cashtag with the word CA next to it. "CA:" alone matched press releases.
ADDRESS = re.compile(r"(0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}pump\b|\b[1-9A-HJ-NP-Za-km-z]{43,44}\b)")
CASHTAG = re.compile(r"\$[A-Za-z][A-Za-z0-9]{1,9}\b")
# Shapes that read as a brochure rather than as somebody posting a coin.
JUNK = re.compile(r"(={4,}|-{6,}|_{6,}|\*{4,}|project overview|whitepaper|roadmap|"
                  r"follow me|follow us|like & retweet|tag \d+ friends)", re.I)


def curl(url):
    out = subprocess.run(
        ["curl", "-s", "-m", "40", "-H", f"X-API-Key: {KEY}", url],
        capture_output=True).stdout
    try:
        return json.loads(out or b"{}")
    except json.JSONDecodeError:
        return {}


def ago(created):
    """'Fri Oct 02 00:12:31 +0000 2026' -> '2h', the way a timeline writes it."""
    try:
        t = time.mktime(time.strptime(created, "%a %b %d %H:%M:%S +0000 %Y")) - time.timezone
    except ValueError:
        return ""
    d = max(1, int(time.time() - t))
    if d < 3600:
        return f"{d // 60}m"
    if d < 86400:
        return f"{d // 3600}h"
    return f"{d // 86400}d"


def short(n):
    n = int(n or 0)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M".replace(".0M", "M")
    if n >= 1000:
        return f"{n / 1000:.1f}K".replace(".0K", "K")
    return str(n)


def clean(text):
    """The post's own words, minus the trailing t.co link the API appends."""
    t = re.sub(r"https://t\.co/\w+", "", text or "").strip()
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t


seen, picked = set(), []
for q in QUERIES:
    if len(picked) >= WANT:
        break
    import urllib.parse
    d = curl(f"{API}?query={urllib.parse.quote(q)}&queryType=Latest")
    for t in (d.get("tweets") or []):
        a = t.get("author") or {}
        handle = a.get("userName")
        text = clean(t.get("text"))
        if not handle or handle.lower() in seen:
            continue
        # Long posts are kept whole in the file and clipped by the card, the
        # same way the timeline clips them. Nothing is reworded.
        if not text or len(text) < 12:
            continue
        if BAD.search(text) or JUNK.search(text):
            continue
        # Both, not either: a ticker on its own is a mention, an address on its
        # own is a bot. Together they are the post this film is about.
        if not (CASHTAG.search(text) and (ADDRESS.search(text) or re.search(r"\bCA\s*:", text))):
            continue
        # Long enough to be a post, short enough to be read in a third of a
        # second — which is all each one gets.
        if len(text) > 230 or len(text) < 20:
            continue
        if not a.get("profilePicture"):
            continue
        seen.add(handle.lower())
        picked.append({
            "name": a.get("name") or handle,
            "handle": handle,
            "verified": bool(a.get("isBlueVerified") or a.get("isVerified")),
            "time": ago(t.get("createdAt", "")),
            "text": text,
            "replies": short(t.get("replyCount")),
            "reposts": short(t.get("retweetCount")),
            "likes": short(t.get("likeCount")),
            "avatar": a.get("profilePicture").replace("_normal", "_400x400"),
            "url": t.get("url") or f"https://x.com/{handle}/status/{t.get('id')}",
        })
        if len(picked) >= WANT:
            break
    print(f"{q[:38]:<40} -> {len(picked)} kept", flush=True)

os.makedirs(AV, exist_ok=True)
for i, p in enumerate(picked):
    dst = os.path.join(AV, f"{i:02d}.jpg")
    subprocess.run(["curl", "-s", "-m", "30", "-o", dst, p["avatar"]], check=False)
    p["avatarFile"] = f"xeet/av/{i:02d}.jpg" if os.path.getsize(dst) > 500 else None

json.dump(picked, open(os.path.join(HERE, "posts.json"), "w"), indent=1, ensure_ascii=False)
print(f"\n{len(picked)} posts -> promo/posts.json")
for p in picked[:6]:
    print(" ", p["handle"], "|", p["text"][:70].replace("\n", " "))
