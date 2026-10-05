# Publishing Xeet to the Chrome Web Store

Everything the listing asks for, already prepared. Run the build, then work
down this page — the fields are in the order the dashboard presents them.

```bash
./build.sh                       # -> dist/xeet-store.zip
python3 tools/make-store-assets.py   # -> dist/store/*.png
```

Upload **`dist/xeet-store.zip`**, not `site/xeet-extension.zip`. The two are
different shapes on purpose: the store needs `manifest.json` at the root of the
archive, and the site's download needs the folder inside it so "Load unpacked"
has something to point at. `build.sh` checks the store one and fails loudly if
the manifest ends up nested.

---

## 0. Before the first upload

1. Go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   and sign in with the Google account that should own the listing. **Use an
   account you will keep** — a listing cannot be moved between accounts later.
2. Pay the one-time **$5** registration fee. It is per account, not per
   extension.
3. Verify a contact email in **Account** → it is required before anything can
   be published, and it is the address Google writes to about review problems.

## 1. Upload

**Items** → **Add new item** → drop `dist/xeet-store.zip`.

Everything below then lives under **Store listing**, **Privacy** and
**Distribution**.

## 2. Store listing

| Field | Value |
| --- | --- |
| Name | `Xeet — Swap at the speed of X` |
| Summary (132 max) | `Trade any token on X without leaving the feed. Non-custodial, ten chains, 0.5% per swap.` |
| Category | **Tools** — the dashboard's current list has no Finance category, and Tools is where comparable trading extensions sit |
| Language | English |

**Description** (paste as-is):

```
Xeet turns cashtags and contract addresses in your X timeline into a trading panel. Point at one and the panel opens right on the post with the token's price, market cap, liquidity, a live chart and a safety check. Pick an amount and your own wallet asks you to sign.

Non-custodial. Xeet never holds your funds or your keys. Every swap is built by a third-party router and approved in your wallet's own window.

Works on Solana and on EVM networks, with the wallets you already have installed.

Fee: 0.5% per swap, taken by the router as part of the trade. Nothing is charged if a trade fails.

Optional one-click trading is off by default. It uses separate accounts that Xeet creates on your device — one on Robinhood Chain, one on Solana — capped per trade and per day. The Solana key is held unexportably by the browser; the Robinhood Chain key is stored in readable form, because the browser offers no unreadable option for its signing curve. The settings screen says which is which before you fund either, and you can send a balance back to your wallet at any time. Xeet never accepts a seed phrase.

No accounts, no analytics, no Xeet server. Privacy policy: https://xeet.click/privacy

Xeet is software, not financial advice. Trading tokens is high risk and you can lose what you put in.
```

**Graphics** — all in `dist/store/`:

| Asset | File | Required |
| --- | --- | --- |
| Icon 128×128 | `store-icon-128.png` — the form wants it uploaded separately, not read from the zip | yes |
| Screenshot 1280×800 | `screenshot-1-panel.png` | at least one |
| Screenshot 1280×800 | `screenshot-2-contract.png` | |
| Screenshot 1280×800 | `screenshot-3-noncustodial.png` | |
| Small promo tile 440×280 | `promo-tile-440x280.png` | optional, but a listing without one is not eligible for any featuring |
| Marquee 1400×560 | `marquee-1400x560.png` | optional |

## 3. Privacy — the part that actually gets rejected

**Single purpose** (one sentence, paste as-is):

> Xeet lets a person trade a token from the X timeline: it detects tickers and
> contract addresses in posts and opens a panel that shows that token's market
> data and builds a swap for the user's own wallet to sign.

**Permission justifications.** Every one of these has to be filled in, and
"needed for functionality" gets the submission bounced. Paste these:

| Permission | Justification |
| --- | --- |
| `storage` | Stores the user's own settings (slippage, quick-buy sizes, on/off), the public address of the wallet they connected, and their local swap history. Nothing is transmitted anywhere. If the user enables the optional one-click mode, it also stores that feature's spending caps; the signing keys themselves live in IndexedDB and never leave the device — the Solana key as a non-extractable CryptoKey, the Robinhood Chain key in readable form, because the browser offers no unreadable option for Ethereum's curve. |
| Host: `x.com`, `twitter.com` | This is the entire product. The content script reads post text to find tickers and contract addresses and mounts the trading panel on the page; the toolbar popup messages that tab to open a token. |
| Host: `api.dexscreener.com`, `cdn.dexscreener.com`, `dd.dexscreener.com` | Market data for the token being viewed — price, liquidity, volume, market cap, pairs — and its logo. The logo is fetched by the service worker and passed to the page as a data: URL because x.com's content security policy blocks third-party images. |
| Host: `lite-api.jup.ag` | Solana token search, prices, wallet balances, swap routing and building the unsigned transaction. |
| Host: `li.quest` | The same for the nine EVM chains, via LI.FI. |
| Host: `api.geckoterminal.com` | OHLC candles for the price chart at the 1H, 24H and 7D ranges. |
| Host: `api.gopluslabs.io` | Token safety screening — honeypot, live mint authority, transfer tax, ownership — shown on the panel before a user can trade. |
| Hosts: `*.publicnode.com`, `api.mainnet.abs.xyz`, `rpc.mainnet.chain.robinhood.com` | Public blockchain RPC nodes. Used to read balances and token decimals, check ERC-20 allowances, and confirm that a submitted transaction landed. |

**Data usage** — tick these and nothing else:

- Personally identifiable information: **no**
- Health, financial and payment information: **no** — Xeet handles no payment
  credentials; a public wallet address is not payment information and is not
  collected by the developer in any case
- Authentication information: **no**
- Personal communications, location, web history, user activity: **no**
- Website content: **no** — post text is read in the page and never leaves it

Then tick all three certifications (no unrelated selling, no unapproved use, no
creditworthiness use) — all three are true of this build.

**Privacy policy URL**: `https://xeet.click/privacy`
(swap in your own domain if you point one at the site). The policy on that page
describes *this* build: no backend, no analytics, no accounts.

**Remote code**: answer **No**. Everything executes from the package; nothing
is fetched and evaluated.

**If one-click trading is enabled in the build you submit**, expect a closer
look and answer it head-on in the listing and the policy. Lead with the part
that is least flattering, because a reviewer will find it anyway:

- The trading account's key is **stored in readable form** — thirty-two bytes
  in IndexedDB. It has to be: one-click also runs on Robinhood Chain, and Chrome's
  WebCrypto has no secp256k1 at all (`ECDSA/secp256k1` and `ECDSA/K-256` both
  throw `NotSupportedError`), so there is no unreadable-key option on this
  curve. Do not claim otherwise anywhere.
- The alternative was checked rather than dismissed: a smart account signed by
  a non-extractable P-256 key needs on-chain P-256 verification and a bundler.
  Robinhood Chain has both ERC-4337 EntryPoints deployed but **no** P-256
  precompile and **no** bundler on its public RPC, so that route does not
  exist here.
- **No seed phrase is ever accepted, anywhere.** The optional import takes a
  single account's private key, is off the default path, sits behind its own
  warning, and refuses anything that looks like a recovery phrase. Connecting
  a wallet for ordinary trading involves no key at all.
- It is a **separate account**, created on the device, funded deliberately,
  which the user's own wallet never signs for.
- Every trade is **capped** per trade and per day, enforced in the service
  worker rather than the page.
- The user can **send the balance back** to their connected wallet at any
  time; the destination is that wallet, never a typed address.
- The two vendored libraries (`@noble/secp256k1`, `@noble/hashes`) are copied
  into `extension/vendor/` with their MIT licences. **No remote code**: nothing
  is fetched at runtime.

Nineteen extensions were pulled from the official stores in August 2026 for
harvesting seed phrases, several of them after a benign version had already
shipped. Reviewers are primed for that shape. Being explicit about all four
points above is the difference between a question and a rejection.

## 4. Distribution

- **Visibility**: Public (or Unlisted first, if you want to test the install
  flow before anyone can find it).
- **Regions**: all, unless you have a reason not to.

Then **Submit for review**.

## 5. What to expect

**Rejected once already, for keyword stuffing.** The description used to list
every chain by name — "Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain,
Avalanche, Abstract and Robinhood Chain" — and the automated check ("Yellow
Argon") read that run of proper nouns as keyword stuffing rather than as
information. The wallet list beside it was built the same way and would have
tripped the same wire next time.

Both are prose now, and the brand-name count in the description went from
seventeen to six. If a future edit wants to name the chains again, name them
somewhere that is not the store listing — the panel already says which network
a token is on, and the site can carry the full list.


- Review usually lands in **a few days**; a first submission from a new account
  is slower, and anything touching crypto gets a closer look.
- The two things most likely to come back: a **permission justification** that
  reads as boilerplate, and a **privacy policy that does not match the
  manifest**. Both are covered above — keep them in sync if you change the code.
- **Updates**: bump `version` in `extension/manifest.json`, run `./build.sh`,
  upload the new `dist/xeet-store.zip` to the same item. Each update is
  reviewed again, usually faster.

## 6. A note before you publish

The fee is currently plumbed but not collected: `FEE` in
`extension/src/config.js` has no `solanaFeeAccount` and the LI.FI integrator
string is not registered, so swaps route at cost. The listing text above says
0.5% because that is the intended price — either register the integrator with
LI.FI and set up a Jupiter referral account before publishing, or change the
description until you have.
