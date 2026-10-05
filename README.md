<p align="center">
  <a href="https://xeet.click"><img src=".github/banner.png" alt="Xeet — swap at the speed of 𝕏" width="100%"></a>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/nmfjmkkgealdnpgnfgkgflkpimgdklfc"><b>Add to Chrome</b></a>
  ·
  <a href="https://xeet.click"><b>xeet.click</b></a>
  ·
  <a href="https://xeet.click/privacy">Privacy</a>
  ·
  <a href="https://xeet.click/terms">Terms</a>
  ·
  <a href="https://x.com/Xeet_click">@Xeet_click</a>
</p>

# Xeet

Swap at the speed of 𝕏. A Chrome extension that turns every cashtag and
contract address in the X timeline into a live trading panel, plus the
marketing site that ships it.

```
site/         the landing page (static, deployed to Vercel)
extension/    the Chrome extension — the actual product
tools/        the rendered artwork: the social card and the store assets
build.sh      packages extension/ twice — unpacked install, and store upload
deploy.py     uploads site/ to Vercel via the REST API
STORE.md      every field the Chrome Web Store listing asks for
```

## The extension

Point at `$BONK`, or at a contract address someone pasted, and a panel opens
over the post: price, market cap, depth, 24h volume, an OHLC chart at three
ranges, the token's own links, a live flow reading, and a safety screening.
Point at **HOVER TO BUY** and the amounts appear. Tap one and the card flips to
a review while your wallet asks you to sign.

**Non-custodial, and structurally so.** The extension never asks for a key,
never receives one, and has no code path that could hold one. Transactions are
built by Jupiter (Solana) or LI.FI (EVM) and signed in the wallet's own
window — Xeet cannot initiate, move, or spend anything.

### How it is put together

| File | Job |
| --- | --- |
| `src/config.js` | The chain registry. A chain is listed only if all four questions have an answer: what Dexscreener calls it, what GeckoTerminal calls it, how to read a balance, and who builds the trade. A chain with no router is **view only**. |
| `src/background.js` | The whole data layer. Resolution, charts, screening, balances, quotes, unsigned transactions, confirmation, the trending board. The content script never talks to a third party itself. |
| `src/bridge.js` | Runs in the **page's** world, because that is the only place a wallet exists. Discovers wallets (EIP-6963 and the Solana providers), connects on an explicit request, hands a prepared transaction to the chosen provider. Nothing else. |
| `src/wallet.js` | The extension-side half of that bridge. Remembers one public address and a wallet name; nothing else is persisted. |
| `src/panel.js` | The panel: mounting, geometry, the chart, the deck, the flip, the review, the finish. |
| `src/content.js` | The scanner. Marks cashtags and addresses in post text, paints the run stage on them, opens the panel on hover. |
| `src/panel-html.js`, `assets/loupe.css` | The product's own markup and stylesheet, shared byte-for-byte with the panel on the marketing site. |

### Three decisions worth knowing about

**Depth is only depth if it turns over.** Ranking a token's pairs by liquidity
alone quotes `$BONK` against a Uniswap pool holding $358M and doing one cent of
volume a day. A pair scores as the smaller of what it holds and what it
actually trades, so a pool with no flow cannot outrank a pool with flow no
matter how much is parked in it.

**Two indexes, because neither alone answers `$WIF`.** Dexscreener's top 30
results for "WIF" do not contain dogwifhat; Jupiter's token search puts it
first. Both are merged and then ranked by tradable depth. (Its ticker is
literally `$WIF` in one index and `WIF` in the other, which is why symbols are
compared with the dollar sign stripped.)

**Every chain slug is verified against the live index, never guessed.** The
registry called Robinhood Chain `robinhoodchain`; Dexscreener calls it
`robinhood`. Nothing errored — the chain filter simply dropped every token on
it, so `$PONS` resolved to a pump.fun copy on Solana instead of the $600M
original. A wrong slug fails silently and looks like a data problem, which is
why `src/config.js` carries both slugs per chain and both were checked by
calling the indexes.

### Install

Unpacked, from the site: <https://xeet-two.vercel.app/install> — or
locally, `chrome://extensions` → Developer mode → **Load unpacked** →
`extension/`.

### The bench

`extension/dev/` runs the extension's real code in an ordinary tab. `shim.js`
supplies just enough `chrome` — importScripts, message passing, storage, tabs —
that `background.js` itself loads and answers real questions against the real
APIs. Nothing is mocked.

```bash
python3 -m http.server 4173 --directory extension
# then open
#   /dev/preview.html        the panel over a fake timeline
#   /dev/popup-preview.html  the popup (regenerate with node dev/make-popup-preview.mjs)
```

Two things cannot run there: signing (no page wallet) and token art (the CDN
sends no CORS header, which is exactly why the worker proxies it to a `data:`
URL in the shipped build).

## The palette

Black and white, one grey ladder, no hue:

| | |
| --- | --- |
| `#FFFFFF` | the brightest step — a primary fill, a gain, a confirmed thing |
| `#F2F4F3` | paper — the accent and all primary text |
| `#C9CFD3` | dim — body text, live hairlines |
| `#9AA3AA` | quiet — connection, links, the equity class |
| `#8A9199` | muted — secondary text, and a loss |
| `#23272B` | line — hairlines at rest |
| `#08090A` | void — the ground, and the ink on any white fill |

Three signals were carried by hue alone, and mapping them to greys is not
enough — mint and danger both land on white, so buy and sell would render
identically. Each is re-established structurally, in the `MONOCHROME` block at
the end of `loupe.css` and `site.css`:

- **Direction** — buy is an outline, sell is **inverted**: a solid white block
  with black type. Money leaving is the loud one, and inversion is the only
  treatment the card uses nowhere else.
- **Danger** — a diagonal hazard hatch, the one texture in the product. The
  screening seal's four verdicts differ by shape as well as fill: solid, open,
  solid-with-a-ring, grey.
- **Gain and loss** — brightness, beside a sign that was always printed
  anyway. Up is white, down fades to muted.

Two consequences worth knowing. The mark drawn on a cashtag uses
`currentColor`, not a colour of its own, because x.com ships light, dim and
lights-out themes and a monochrome product has no hue that survives all three;
the run stage then rides the rule's *shape* — dotted, dashed, solid, doubled.
And borrowed art — chain marks, token logos — is desaturated rather than
recoloured, so the marks stay recognisable while the page stays one palette.

`mono.py` is the one-shot transform that did the hue-to-grey mapping, kept as
the record of which job became which step.

## The site

Static. `index.html` runs one scroll-driven story on a sticky stage, and the
panel it shows is the product's real markup and stylesheet rather than a
drawing of them.

```bash
./build.sh                                   # refresh site/xeet-extension.zip
source ~/.config/vercel.env && python3 deploy.py
```

## The artwork

`site/og.png` and everything in `dist/store/` are drawn by `tools/`, not
screenshotted: the page they depict is a sticky 3D stage that no headless
capture here composites, and the store wants exact pixel sizes a scaled pane
cannot produce. `tools/artwork.py` holds the machinery — it unpacks the site's
own woff2 subsets into usable faces with fontTools, so the artwork is set in
the same type as the page and cannot drift from it.

```bash
python3 tools/make-og.py             # site/og.png
python3 tools/make-store-assets.py   # dist/store/ — screenshots, tile, marquee
```

## Fee

0.5% per swap, one number on every chain, plumbed through both routers'
integrator-fee parameters. Neither can be applied without a collection
address, so a deployment with no fee account configured routes at cost rather
than pretending otherwise — see `FEE` in `src/config.js`.

## Publishing

`./build.sh` writes two archives because the two destinations want opposite
shapes: `site/xeet-extension.zip` has the folder inside it for "Load
unpacked", and `dist/xeet-store.zip` has `manifest.json` at the root, which is
what the Chrome Web Store requires. See [STORE.md](STORE.md) for the listing
copy, the graphics, and a justification for every permission.

---

## Links

| | |
|---|---|
| Site | [xeet.click](https://xeet.click) |
| Install | [Chrome Web Store](https://chromewebstore.google.com/detail/nmfjmkkgealdnpgnfgkgflkpimgdklfc) |
| Privacy policy | [xeet.click/privacy](https://xeet.click/privacy) |
| Terms | [xeet.click/terms](https://xeet.click/terms) |
| X | [@Xeet_click](https://x.com/Xeet_click) |

Built by [XeetDeveloper](https://github.com/XeetDeveloper) · [xeet.click](https://xeet.click)
