/* Xeet — the data layer.
 *
 * Everything the panel knows arrives through here. The content script asks a
 * question ("what is $ANSEM", "quote 50 dollars of it") and gets an answer or
 * an error; it never talks to a third party itself. Two reasons, and both are
 * load-bearing:
 *
 *   1. x.com ships a strict CSP. A fetch from the content script inherits the
 *      extension's host permissions, but a *redirect* into an unlisted origin
 *      dies silently in the page's console where nobody sees it.
 *   2. One cache. Ten cashtags in one screenful of timeline are ten hovers of
 *      the same three tokens; the panel should open instantly the second time.
 *
 * The worker holds NO key material and never sees one. It builds unsigned
 * transactions and hands them back for the page's wallet to sign. */

// config.js has no imports or exports — it assigns to globalThis — so a
// side-effect import is all it needs, and it stays loadable as a classic
// script by the content scripts and the popup.
import "./config.js";
import * as turbo from "./turbo.js";
import * as perps from "./perps.js";

const { CHAINS, BY_DS, BY_GT, API, FEE, DEFAULTS } = self.XEET_CFG;

/* --------------------------------------------------------------- caching */
/* A service worker is evicted after ~30s idle, so this cache is a burst cache
   — it survives a scroll through a thread, not a coffee break. That is the
   right lifetime for a price. */
const cache = new Map();
const inflight = new Map();

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttl) return Promise.resolve(hit.v);
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(fn)
    .then((v) => {
      cache.set(key, { t: Date.now(), v });
      inflight.delete(key);
      if (cache.size > 400) cache.delete(cache.keys().next().value);
      return v;
    })
    .catch((e) => {
      inflight.delete(key);
      throw e;
    });
  inflight.set(key, p);
  return p;
}

async function getJSON(url, opts) {
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 12000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!r.ok) {
      const msg = (body && (body.message || body.error || (body.errors && body.errors[0] && body.errors[0].message))) ||
        `${r.status} ${r.statusText}`;
      const err = new Error(msg);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(kill);
  }
}

async function rpc(url, method, params) {
  const body = await getJSON(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (body && body.error) throw new Error(body.error.message || "rpc error");
  return body && body.result;
}

/* ------------------------------------------------------ address shapes */
const RE_EVM = /^0x[a-fA-F0-9]{40}$/;
const RE_SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function addrKind(s) {
  if (RE_EVM.test(s)) return "evm";
  if (RE_SOL.test(s)) return "svm";
  return null;
}

/* --------------------------------------------------------- token lookup */
/* Dexscreener returns every pair a token trades in, most of them noise: a
   forked pool with $80 of liquidity quoting the same mint. The pair Xeet
   shows is the one a trade would actually route through.
 *
 * DEPTH IS ONLY DEPTH IF IT TURNS OVER.
 *
 * Ranking on liquidity alone is how a panel ends up quoting $BONK against a
 * Uniswap pool holding $358M and doing one cent of volume a day — a pool that
 * exists to be found, not to be traded. Measured against live Dexscreener
 * results: the fake pairs carry 1-3 trades in 24 hours, the real ones carry
 * thousands, and the gap is four orders of magnitude wide.
 *
 * So a pair scores as the smaller of what it holds and what it actually
 * trades. A pool with no flow cannot outrank a pool with flow no matter how
 * much money is parked in it. */
function scorePair(p) {
  const liq = (p.liquidity && p.liquidity.usd) || 0;
  const vol = (p.volume && p.volume.h24) || 0;
  const tx = ((p.txns && p.txns.h24 && p.txns.h24.buys) || 0) + ((p.txns && p.txns.h24 && p.txns.h24.sells) || 0);
  const cap = p.marketCap || p.fdv || 0;
  if (liq < 400) return -1;
  if (tx < 4) return -1;                       // not a market, whatever its TVL
  let s = Math.min(liq, Math.max(vol, 1) * 3);
  if (cap > 0 && liq > cap * 1.4) s *= 0.05;   // depth exceeding the whole cap
  return s;
}

/* The lenient pass exists for the honest edge case the strict one rejects: a
   token minted four minutes ago has real liquidity and three trades. It is
   only reached when nothing passes strictly, so it can never outrank a real
   market. */
function loosePair(p) {
  const liq = (p.liquidity && p.liquidity.usd) || 0;
  const cap = p.marketCap || p.fdv || 0;
  if (liq < 400) return -1;
  return cap > 0 && liq > cap * 1.4 ? liq * 0.05 : liq;
}

/* Symbols are compared with the dollar sign stripped. dogwifhat's ticker is
   literally "$WIF" in Jupiter's index and "WIF" in Dexscreener's, and an
   exact-string match on one of those spellings silently drops the largest
   token in the result set. */
const sym = (s) => String(s || "").replace(/^\$/, "").toUpperCase();

function narrow(pairs, wantSymbol) {
  let list = (pairs || []).filter((p) => p && p.baseToken && BY_DS[p.chainId]);
  if (wantSymbol) {
    const want = sym(wantSymbol);
    const exact = list.filter((p) => sym(p.baseToken.symbol) === want);
    if (exact.length) list = exact;
  }
  return list;
}

function pickPair(pairs, wantSymbol) {
  const list = narrow(pairs, wantSymbol);
  for (const score of [scorePair, loosePair]) {
    const ok = list.filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a));
    if (ok.length) return ok[0];
  }
  return null;
}

/* Candidates for the disambiguation list: one row per distinct token (not per
   pool), deepest first, so "$MOON" that exists on four chains offers four
   rows rather than forty. */
function candidates(pairs, wantSymbol) {
  const seen = new Map();
  for (const p of narrow(pairs, wantSymbol)) {
    if (scorePair(p) <= 0) continue;
    const id = p.chainId + ":" + p.baseToken.address;
    const prev = seen.get(id);
    if (!prev || scorePair(p) > scorePair(prev)) seen.set(id, p);
  }
  return [...seen.values()].sort((a, b) => scorePair(b) - scorePair(a)).slice(0, 8).map(shapePair);
}

/* ---------------------------------------------- the fallback resolver ---
 * Dexscreener indexes pools; it does not index a token that has not got one
 * yet. A coin announced the minute it launches is on a launchpad bonding
 * curve, and the curve is exactly when somebody most wants the panel — which
 * is how "no market for this address" ended up on a live $9K token that three
 * other services could price and one could route.
 *
 * GeckoTerminal's pool search covers every network in one call and answers
 * for curve pools, so it is the second look. It also reports how far the
 * launch has graduated, which is the real explanation for the gap.
 */
function gtNum(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/* GeckoTerminal's pool, in the shape the rest of the panel already speaks. */
function shapeGeckoPool(pool, included, wantAddress) {
  const a = pool.attributes || {};
  const rel = pool.relationships || {};
  const network = String(pool.id || "").split("_")[0];
  const chain = BY_GT[network];
  if (!chain) return null;

  const tokens = {};
  for (const inc of included || []) {
    if (inc.type === "token") tokens[String(inc.id).split("_").slice(1).join("_").toLowerCase()] = inc.attributes || {};
  }
  const idOf = (side) => {
    const dt = rel[side] && rel[side].data;
    return dt ? String(dt.id).split("_").slice(1).join("_").toLowerCase() : null;
  };
  let baseId = idOf("base_token"), quoteId = idOf("quote_token");

  // If the search matched the quote side, the token the person asked about is
  // the quote — showing them the other one would be answering a different
  // question.
  let flipped = false;
  if (wantAddress) {
    const want = wantAddress.toLowerCase();
    if (quoteId === want && baseId !== want) flipped = true;
  }
  const selfId = flipped ? quoteId : baseId;
  const otherId = flipped ? baseId : quoteId;
  const self = tokens[selfId] || {};
  const other = tokens[otherId] || {};

  const price = flipped ? gtNum(a.quote_token_price_usd) : gtNum(a.base_token_price_usd);
  const supply = gtNum(self.total_supply) && self.decimals != null
    ? gtNum(self.total_supply) / Math.pow(10, self.decimals) : null;
  const lp = a.launchpad_details || null;

  return {
    chain: chain.key,
    chainName: chain.name,
    dexId: (rel.dex && rel.dex.data && rel.dex.data.id) || "",
    pairAddress: a.address,
    url: `https://www.geckoterminal.com/${network}/pools/${a.address}`,
    address: selfId,
    symbol: sym(self.symbol || ""),
    name: self.name || self.symbol || "",
    decimals: self.decimals != null ? self.decimals : null,
    quoteSymbol: other.symbol || "",
    quoteAddress: otherId,
    priceUsd: price || null,
    priceNative: gtNum(a.base_token_price_native_currency) || null,
    change: {
      m5: a.price_change_percentage && a.price_change_percentage.m5,
      h1: a.price_change_percentage && a.price_change_percentage.h1,
      h6: a.price_change_percentage && a.price_change_percentage.h6,
      h24: a.price_change_percentage && a.price_change_percentage.h24,
    },
    volume: {
      m5: gtNum(a.volume_usd && a.volume_usd.m5),
      h1: gtNum(a.volume_usd && a.volume_usd.h1),
      h6: gtNum(a.volume_usd && a.volume_usd.h6),
      h24: gtNum(a.volume_usd && a.volume_usd.h24),
    },
    txns: {
      m5: (a.transactions && a.transactions.m5) || null,
      h1: (a.transactions && a.transactions.h1) || null,
      h6: (a.transactions && a.transactions.h6) || null,
      h24: (a.transactions && a.transactions.h24) || null,
    },
    liquidity: gtNum(a.reserve_in_usd),
    marketCap: gtNum(a.market_cap_usd) || (price && supply ? price * supply : gtNum(a.fdv_usd)),
    fdv: gtNum(a.fdv_usd),
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    image: self.image_url && /^https:\/\//.test(self.image_url) ? self.image_url : null,
    website: null, x: null, telegram: null, discord: null,
    boosts: 0,
    // How far a launchpad coin has come. Null for anything already graduated.
    launchpad: lp && !lp.completed && lp.graduation_percentage != null
      ? { graduation: Number(lp.graduation_percentage) } : null,
    via: "geckoterminal",
  };
}

async function geckoResolve(query, chainHint, wantSymbol) {
  const body = await getJSON(
    `${API.gt}/search/pools?query=${encodeURIComponent(query)}&include=base_token,quote_token,dex`,
    { headers: { accept: "application/json" }, timeout: 9000 });
  const pools = (body && body.data) || [];
  const included = (body && body.included) || [];
  const wantAddress = addrKind(query) ? query : null;

  let shaped = pools.map((p) => shapeGeckoPool(p, included, wantAddress)).filter(Boolean);
  if (wantAddress) {
    const want = wantAddress.toLowerCase();
    shaped = shaped.filter((t) => (t.address || "").toLowerCase() === want);
  }
  if (wantSymbol) shaped = shaped.filter((t) => sym(t.symbol) === sym(wantSymbol));
  if (chainHint && CHAINS[chainHint]) {
    const only = shaped.filter((t) => t.chain === chainHint);
    if (only.length) shaped = only;
  }
  // A curve pool has almost no depth by design, so the floor here is a floor
  // against dust, not against thinness.
  shaped = shaped.filter((t) => t.liquidity > 25 && t.priceUsd);
  shaped.sort((a, b) => Math.min(b.liquidity, Math.max(b.volume.h24, 1) * 3)
    - Math.min(a.liquidity, Math.max(a.volume.h24, 1) * 3));

  // The search endpoint does not carry launchpad_details; the pool endpoint
  // does, and the answer decides whether this token can be traded at all. A
  // coin still on its curve is not in any aggregator's routes — LI.FI answers
  // "no available quotes" — so the panel has to know before it offers a size
  // rather than after the tap.
  if (shaped.length) {
    const top = shaped[0];
    const chain = CHAINS[top.chain];
    const detail = await getJSON(
      `${API.gt}/networks/${chain.gt}/pools/${top.pairAddress}`,
      { headers: { accept: "application/json" }, timeout: 8000 }).catch(() => null);
    const lp = detail && detail.data && detail.data.attributes
      && detail.data.attributes.launchpad_details;
    if (lp) {
      top.launchpad = {
        graduation: Number(lp.graduation_percentage) || 0,
        completed: !!lp.completed,
      };
    }
  }
  return shaped;
}

/* The panel's own view of a pair. Nothing downstream touches a raw
   Dexscreener object, so a field they rename breaks in one place. */
function shapePair(p) {
  const chain = BY_DS[p.chainId];
  const info = p.info || {};
  const socials = info.socials || [];
  const site = (info.websites || [])[0];
  const txns = p.txns || {};
  return {
    chain: chain ? chain.key : p.chainId,
    chainName: chain ? chain.name : p.chainId,
    dexId: p.dexId,
    pairAddress: p.pairAddress,
    url: p.url,
    address: p.baseToken.address,
    // Display symbol, normalised: dogwifhat's ticker is literally "$WIF" in
    // one index, and the panel writes its own dollar sign.
    symbol: sym(p.baseToken.symbol),
    name: p.baseToken.name,
    quoteSymbol: p.quoteToken && p.quoteToken.symbol,
    quoteAddress: p.quoteToken && p.quoteToken.address,
    priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : null,
    priceNative: p.priceNative ? parseFloat(p.priceNative) : null,
    change: {
      m5: p.priceChange && p.priceChange.m5,
      h1: p.priceChange && p.priceChange.h1,
      h6: p.priceChange && p.priceChange.h6,
      h24: p.priceChange && p.priceChange.h24,
    },
    volume: p.volume || {},
    txns: {
      m5: txns.m5 || null, h1: txns.h1 || null, h6: txns.h6 || null, h24: txns.h24 || null,
    },
    liquidity: (p.liquidity && p.liquidity.usd) || 0,
    marketCap: p.marketCap || p.fdv || 0,
    fdv: p.fdv || 0,
    createdAt: p.pairCreatedAt || null,
    image: info.imageUrl || null,
    website: site && site.url,
    x: (socials.find((s) => s.type === "twitter") || {}).url,
    telegram: (socials.find((s) => s.type === "telegram") || {}).url,
    discord: (socials.find((s) => s.type === "discord") || {}).url,
    boosts: (p.boosts && p.boosts.active) || 0,
  };
}

async function resolveToken(query, chainHint) {
  const q = String(query || "").trim();
  if (!q) throw new Error("nothing to look up");
  const kind = addrKind(q);

  if (kind) {
    const key = "tok:" + q;
    return cached(key, 20000, async () => {
      const body = await getJSON(API.dsTokens + encodeURIComponent(q)).catch(() => null);
      const best = pickPair((body && body.pairs) || []);
      if (best) return { token: shapePair(best), candidates: [] };

      // Second look, because Dexscreener indexes pools and a coin posted the
      // minute it launches does not have one yet.
      const gt = await geckoResolve(q, chainHint).catch(() => []);
      if (gt.length) return { token: gt[0], candidates: gt.slice(0, 8) };

      throw new Error("no market for this address");
    });
  }

  const want = sym(q);
  const key = "sym:" + want + ":" + (chainHint || "");
  return cached(key, 20000, async () => {
    // TWO INDEXES, because neither one alone answers "$WIF".
    //
    // Dexscreener's search is pair-relevance ranked and, measured live, its
    // top 30 for "WIF" is entirely small tokens named after the big one —
    // dogwifhat itself is not in the list. Jupiter's token search is ranked by
    // organic score and puts the real one first. Merging the two and ranking
    // by tradable depth gets the answer a person meant, which is the whole
    // job of a cashtag.
    const [dsBody, jupPairs] = await Promise.all([
      getJSON(API.dsSearch + encodeURIComponent(want)).catch(() => null),
      jupiterPairs(want),
    ]);
    let pairs = ((dsBody && dsBody.pairs) || []).concat(jupPairs);
    if (chainHint && CHAINS[chainHint]) {
      const only = pairs.filter((p) => p.chainId === CHAINS[chainHint].ds);
      if (only.length) pairs = only;
    }
    const best = pickPair(pairs, want);
    if (!best) {
      const gt = await geckoResolve(want, chainHint, want).catch(() => []);
      if (gt.length) return { token: gt[0], candidates: gt.slice(0, 8) };
      throw new Error("no token trading as $" + want);
    }
    const cands = candidates(pairs, want);
    return { token: shapePair(best), candidates: cands.length > 1 ? cands : [] };
  });
}

/* Jupiter's index, folded back into Dexscreener pairs so everything
   downstream ranks one kind of object. Verified tokens first, at most three,
   because each one costs a second request. */
async function jupiterPairs(want) {
  try {
    const list = await getJSON(`${API.jup}/tokens/v2/search?query=${encodeURIComponent(want)}`, { timeout: 6000 });
    const hits = (Array.isArray(list) ? list : [])
      .filter((t) => t && t.id && sym(t.symbol) === want)
      .sort((a, b) => (Number(b.isVerified) - Number(a.isVerified)) ||
        ((b.liquidity || 0) - (a.liquidity || 0)))
      .slice(0, 3);
    const bodies = await Promise.all(hits.map((t) =>
      getJSON(API.dsTokens + encodeURIComponent(t.id)).catch(() => null)));
    return bodies.flatMap((b) => (b && b.pairs) || []);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- the chart */
/* GeckoTerminal indexes the same pools Dexscreener does, keyed by its own
   network slug. A range is a (timeframe, aggregate, limit) triple chosen so
   every range draws roughly the same number of points — the line should look
   like the same instrument at three zoom levels, not three different charts. */
/* The candle ranges. GeckoTerminal's finest candle is one minute, which is why
   the two shortest ranges below are not in this table at all — they are built
   from individual trades instead. */
const RANGES = {
  "1h": { tf: "minute", agg: 1, limit: 60 },
  "24h": { tf: "minute", agg: 15, limit: 96 },
  "7d": { tf: "hour", agg: 4, limit: 42 },
};

/* The two live ranges, drawn from trades rather than candles.
   `bucket` is how much time one point covers; `window` is how far back it goes. */
const LIVE = {
  "30s": { window: 30 * 1000, bucket: 1000 },
  "5m": { window: 5 * 60 * 1000, bucket: 5 * 1000 },
};

/* The last half hour of actual swaps, newest first, priced in dollars.
   Cached briefly: at a few trades a second, a fresh call per range switch would
   be three identical requests to draw three views of the same thirty minutes. */
async function trades(chainKey, pool, denom) {
  const c = CHAINS[chainKey];
  if (!c || !pool) return [];
  const inToken = denom === "token";
  return cached(`trades:${chainKey}:${pool}:${denom || "usd"}`, 15000, async () => {
    const body = await getJSON(`${API.gt}/networks/${c.gt}/pools/${pool}/trades`,
      { headers: { accept: "application/json" } });
    return ((body && body.data) || [])
      .map((t) => t.attributes || {})
      .map((a) => {
        // Which side of the pair is the token depends on the trade's direction,
        // and each side is quoted twice — once in dollars, once in the pair's
        // own quote coin.
        const buy = a.kind === "buy";
        const c = inToken
          ? (buy ? a.price_to_in_currency_token : a.price_from_in_currency_token)
          : (buy ? a.price_to_in_usd : a.price_from_in_usd);
        return { t: Date.parse(a.block_timestamp), c: Number(c) };
      })
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.c) && p.c > 0)
      .sort((a, b) => a.t - b.t);
  }).catch(() => []);
}

/* A short window at a fine resolution, from trades.
   Every bucket that saw a trade becomes a point; a bucket that saw none is
   simply absent rather than invented, so a gap in the line is a real gap in
   the trading. */
async function liveChart(chainKey, pool, range, denom) {
  const spec = LIVE[range];
  const all = await trades(chainKey, pool, denom);
  if (!all.length) return { points: [], live: true, trades: 0 };

  // Measured from the newest trade, not from the clock: a token that last
  // traded two minutes ago would otherwise show an empty box.
  const end = all[all.length - 1].t;
  const from = end - spec.window;
  const inWindow = all.filter((p) => p.t >= from);

  const buckets = new Map();
  for (const p of inWindow) buckets.set(Math.floor(p.t / spec.bucket), p);
  const points = [...buckets.values()].sort((a, b) => a.t - b.t);
  return { points, live: true, trades: inWindow.length, latest: end };
}

/* `denom` is what the price is measured in: "usd", or "token" for the pair's
   own quote coin. On a chain where everything trades against WETH, a token can
   sit perfectly still in ETH while its dollar line moves — that movement is
   ETH's, not the token's, and only one of the two views can show which. */
async function chart(chainKey, pool, range, denom) {
  if (LIVE[range]) return liveChart(chainKey, pool, range, denom);
  const c = CHAINS[chainKey];
  const r = RANGES[range] || RANGES["24h"];
  if (!c || !pool) return { points: [] };
  const currency = denom === "token" ? "token" : "usd";
  const key = `chart:${chainKey}:${pool}:${range}:${currency}`;
  return cached(key, 45000, async () => {
    const url = `${API.gt}/networks/${c.gt}/pools/${pool}/ohlcv/${r.tf}?aggregate=${r.agg}&limit=${r.limit}&currency=${currency}`;
    const body = await getJSON(url, { headers: { accept: "application/json" } });
    const list = (body && body.data && body.data.attributes && body.data.attributes.ohlcv_list) || [];
    // GeckoTerminal returns newest-first; a chart reads left to right.
    const points = list
      .map((row) => ({ t: row[0] * 1000, c: Number(row[4]) }))
      .filter((p) => Number.isFinite(p.c))
      .sort((a, b) => a.t - b.t);
    return { points };
  }).catch(() => ({ points: [] }));
}

/* ------------------------------------------------------------ screening */
/* The seal is a claim, so it only ever reports what a screener actually said.
   A screener that is down produces "unknown", never "safe". */
async function screen(chainKey, address) {
  const c = CHAINS[chainKey];
  if (!c) return { verdict: "unknown", findings: [] };
  const key = `screen:${chainKey}:${address}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const findings = [];
    let ok = true, known = false;

    try {
      if (c.kind === "svm") {
        const b = await getJSON(`${API.goplus}/solana/token_security?contract_addresses=${address}`);
        const r = b && b.result && b.result[address];
        if (r) {
          known = true;
          if (r.mintable && r.mintable.status === "1") { findings.push({ level: "bad", text: "Mint authority is still live" }); ok = false; }
          if (r.freezable && r.freezable.status === "1") { findings.push({ level: "bad", text: "Accounts can be frozen" }); ok = false; }
          if (r.transfer_fee && Object.keys(r.transfer_fee).length) findings.push({ level: "warn", text: "Token charges a transfer fee" });
          if (r.closable && r.closable.status === "1") findings.push({ level: "warn", text: "Mint account can be closed" });
          const top = r.holders && r.holders[0];
          if (top && parseFloat(top.percent) > 0.25) findings.push({ level: "warn", text: `Top holder owns ${(parseFloat(top.percent) * 100).toFixed(0)}%` });
        }
      } else {
        const b = await getJSON(`${API.goplus}/token_security/${c.id}?contract_addresses=${address}`);
        const r = b && b.result && (b.result[address.toLowerCase()] || b.result[address]);
        if (r) {
          known = true;
          if (r.is_honeypot === "1") { findings.push({ level: "bad", text: "Honeypot: this token cannot be sold" }); ok = false; }
          if (r.cannot_sell_all === "1") { findings.push({ level: "bad", text: "You cannot sell your whole position" }); ok = false; }
          if (r.is_mintable === "1") { findings.push({ level: "warn", text: "Supply is mintable" }); }
          if (r.owner_change_balance === "1") { findings.push({ level: "bad", text: "Owner can change balances" }); ok = false; }
          if (r.hidden_owner === "1") { findings.push({ level: "bad", text: "Hidden owner" }); ok = false; }
          if (r.can_take_back_ownership === "1") findings.push({ level: "warn", text: "Ownership can be taken back" });
          const bt = parseFloat(r.buy_tax || "0"), st = parseFloat(r.sell_tax || "0");
          if (bt > 0.1 || st > 0.1) { findings.push({ level: "bad", text: `Tax ${Math.round(bt * 100)}% in / ${Math.round(st * 100)}% out` }); ok = false; }
          else if (bt > 0 || st > 0) findings.push({ level: "warn", text: `Tax ${Math.round(bt * 100)}% in / ${Math.round(st * 100)}% out` });
          if (r.is_proxy === "1") findings.push({ level: "warn", text: "Proxy contract — code can change" });
        }
      }
    } catch { /* screener down: stays unknown */ }

    const verdict = !known ? "unknown" : (!ok ? "danger" : (findings.length ? "caution" : "safe"));
    return { verdict, findings };
  }).catch(() => ({ verdict: "unknown", findings: [] }));
}

/* ------------------------------------------------------------- pricing */
async function nativeUsd(chainKey) {
  const c = CHAINS[chainKey];
  if (!c) return null;
  return cached("nusd:" + chainKey, 30000, async () => {
    if (c.kind === "svm") {
      const b = await getJSON(`${API.jup}/price/v3?ids=${c.native.mint}`);
      const row = b && b[c.native.mint];
      return row ? Number(row.usdPrice) : null;
    }
    const b = await getJSON(`${API.lifi}/token?chain=${c.id}&token=${c.native.address}`);
    return b && b.priceUSD ? Number(b.priceUSD) : null;
  }).catch(() => null);
}

/* ------------------------------------------------------------ balances */
async function balances(chainKey, owner, tokenAddress) {
  const c = CHAINS[chainKey];
  if (!c || !owner) return { native: 0, token: 0, tokenDecimals: null };
  const key = `bal:${chainKey}:${owner}:${tokenAddress || ""}`;
  return cached(key, 8000, async () => {
    if (c.kind === "svm") {
      // NOT getTokenAccountsByOwner. That is an "indexed" request and every
      // free Solana RPC either rejects it outright (publicnode answers
      // "Indexed requests require a personal token") or rate-limits it into
      // uselessness — which read as a wallet holding nothing, so every sell
      // tile was struck through for people who did hold the token.
      //
      // Jupiter's balances endpoint answers the same question in one call and
      // returns the whole wallet, which is also what the panel wants next.
      let native = 0, token = 0, tokenDecimals = null;
      const all = await getJSON(`${API.jup}/ultra/v1/balances/${owner}`).catch(() => null);
      if (all) {
        native = Number((all.SOL && all.SOL.uiAmount) || 0);
        const row = tokenAddress && all[tokenAddress];
        if (row) {
          token = Number(row.uiAmount || 0);
          // uiAmount is amount scaled by the mint's decimals; the ratio is the
          // scale, and it saves a second round trip for the mint.
          const raw = Number(row.amount || 0);
          if (raw > 0 && row.uiAmount > 0) tokenDecimals = Math.round(Math.log10(raw / row.uiAmount));
        }
      } else {
        const lam = await rpc(c.rpc, "getBalance", [owner, { commitment: "confirmed" }]);
        native = ((lam && lam.value) || 0) / 1e9;
      }
      if (tokenAddress && tokenDecimals === null) {
        const s = await rpc(c.rpc, "getTokenSupply", [tokenAddress]).catch(() => null);
        tokenDecimals = s && s.value ? s.value.decimals : 6;
      }
      return { native, token, tokenDecimals };
    }

    const hexBal = await rpc(c.rpc, "eth_getBalance", [owner, "latest"]);
    const native = Number(BigInt(hexBal || "0x0")) / 1e18;
    let token = 0, tokenDecimals = null;
    if (tokenAddress && RE_EVM.test(tokenAddress)) {
      const pad = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
      const [rawBal, rawDec] = await Promise.all([
        rpc(c.rpc, "eth_call", [{ to: tokenAddress, data: "0x70a08231" + pad(owner) }, "latest"]).catch(() => "0x0"),
        rpc(c.rpc, "eth_call", [{ to: tokenAddress, data: "0x313ce567" }, "latest"]).catch(() => "0x12"),
      ]);
      tokenDecimals = Number(BigInt(rawDec || "0x12"));
      token = Number(BigInt(rawBal || "0x0")) / Math.pow(10, tokenDecimals);
    }
    return { native, token, tokenDecimals };
  }).catch(() => ({ native: 0, token: 0, tokenDecimals: null }));
}

/* A token's decimals, independent of any wallet. The panel needs it to turn
   a router's base-unit answer into a quantity, and it must be right before
   anyone connects — otherwise every tile quotes the wrong number of tokens to
   people who have not signed in yet. */
async function decimals(chainKey, address) {
  const c = CHAINS[chainKey];
  if (!c || !address) return null;
  return cached(`dec:${chainKey}:${address}`, 24 * 3600 * 1000, async () => {
    if (c.kind === "svm") {
      const s = await rpc(c.rpc, "getTokenSupply", [address]);
      return s && s.value ? s.value.decimals : null;
    }
    const raw = await rpc(c.rpc, "eth_call", [{ to: address, data: "0x313ce567" }, "latest"]);
    return raw && raw !== "0x" ? Number(BigInt(raw)) : null;
  }).catch(() => null);
}

async function allowance(chainKey, token, owner, spender) {
  const c = CHAINS[chainKey];
  if (!c || c.kind !== "evm") return null;
  const pad = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const raw = await rpc(c.rpc, "eth_call",
    [{ to: token, data: "0xdd62ed3e" + pad(owner) + pad(spender) }, "latest"]).catch(() => "0x0");
  return BigInt(raw || "0x0").toString();
}

/* ------------------------------------------------------------- routing */
/* A quote is always built for the wallet that will sign it: both routers
   address the transaction to the payer, so there is no "generic" quote to
   cache and no way for one user's transaction to reach another. */

function toBaseUnits(amount, decimals) {
  // Decimal string → integer string, without floating point in the middle.
  const s = String(amount);
  const neg = s.startsWith("-");
  const [ip, fp = ""] = s.replace("-", "").split(".");
  const frac = (fp + "0".repeat(decimals)).slice(0, decimals);
  const out = (ip + frac).replace(/^0+(?=\d)/, "");
  return (neg ? "-" : "") + (out || "0");
}

/* One shape for both routers: pay `from`, receive `to`, this many of `from`.
   Direction is the caller's business — a sell is a buy with the legs the
   other way round, and encoding "side" down here is how a sell ends up
   quoted against the wrong pair. */
async function quote(req) {
  const c = CHAINS[req.chain];
  if (!c) throw new Error("unknown chain");
  if (!c.router) throw new Error(`${c.name} is view only — no router covers it yet`);
  if (!req.owner) throw new Error("connect a wallet first");
  return c.kind === "svm" ? quoteJupiter(c, req) : quoteLifi(c, req);
}

function isNative(c, addr) {
  if (c.kind === "svm") return addr === c.native.mint;
  return !addr || /^0x0{40}$/i.test(addr) || addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
}

async function quoteJupiter(c, req) {
  const amount = toBaseUnits(req.amount, req.from.decimals);
  if (amount === "0") throw new Error("amount is zero");

  const p = new URLSearchParams({
    inputMint: req.from.address,
    outputMint: req.to.address,
    amount,
    slippageBps: String(req.slippageBps || 100),
    restrictIntermediateTokens: "true",
  });
  // Only take a fee where the account can actually receive one. Jupiter's API
  // accepts any address here and hands back a transaction that then fails ON
  // CHAIN with error 6025 — verified by simulation, a plain wallet address
  // reverts every swap. What it does accept, also verified: an ordinary SPL
  // token account, on either side of the trade. No referral program needed.
  // So the account is checked first, and a swap that cannot pay a fee is routed
  // without one rather than routed into a failure.
  const feeAcct = await solanaFeeAccount(req.from.address, req.to.address);
  if (feeAcct) p.set("platformFeeBps", String(FEE.bps));
  const q = await getJSON(`${API.jup}/swap/v1/quote?${p}`);
  if (!q || !q.outAmount) throw new Error("no route for this trade");

  return {
    router: "jupiter",
    raw: q,
    inAmount: Number(q.inAmount) / Math.pow(10, req.from.decimals),
    outAmount: Number(q.outAmount) / Math.pow(10, req.to.decimals),
    minOut: Number(q.otherAmountThreshold) / Math.pow(10, req.to.decimals),
    priceImpact: q.priceImpactPct != null ? Number(q.priceImpactPct) * 100 : null,
    via: (q.routePlan || []).map((r) => r.swapInfo && r.swapInfo.label).filter(Boolean).join(" → ") || "Jupiter",
    needsApproval: false,
  };
}

async function quoteLifi(c, req) {
  const amount = toBaseUnits(req.amount, req.from.decimals);
  if (amount === "0") throw new Error("amount is zero");

  const p = new URLSearchParams({
    fromChain: String(c.id), toChain: String(c.id),
    fromToken: req.from.address, toToken: req.to.address,
    fromAddress: req.owner, fromAmount: amount,
    slippage: String((req.slippageBps || 100) / 10000),
    integrator: FEE.evmIntegrator,
  });
  // LI.FI pays an integrator only if that integrator has a fee wallet set up
  // in its portal; asking otherwise is refused outright with code 1011. Ask
  // when it is configured, and fall back to a plain quote if the answer is
  // that we may not — a fee we cannot collect must never cost somebody a trade.
  if (FEE.evmFeeConfigured) p.set("fee", String(FEE.pct));
  let q;
  try {
    q = await getJSON(`${API.lifi}/quote?${p}`);
  } catch (e) {
    if (!FEE.evmFeeConfigured || !/1011|not configured for collecting fees/i.test(e.message || "")) throw e;
    p.delete("fee");
    q = await getJSON(`${API.lifi}/quote?${p}`);
  }
  const est = q.estimate || {};
  const act = q.action || {};
  const outDecimals = (act.toToken && act.toToken.decimals) ?? req.to.decimals;

  // Only a token you already hold needs an allowance; native value rides on
  // the transaction itself.
  let needsApproval = false;
  if (!isNative(c, req.from.address) && est.approvalAddress) {
    const have = await allowance(c.key, req.from.address, req.owner, est.approvalAddress);
    needsApproval = have !== null && BigInt(have) < BigInt(amount);
  }

  return {
    router: "lifi",
    raw: q,
    inAmount: Number(est.fromAmount || amount) / Math.pow(10, req.from.decimals),
    outAmount: Number(est.toAmount || 0) / Math.pow(10, outDecimals),
    minOut: Number(est.toAmountMin || 0) / Math.pow(10, outDecimals),
    priceImpact: null,
    via: (q.toolDetails && q.toolDetails.name) || q.tool || "LI.FI",
    gasUsd: (est.gasCosts || []).reduce((a, g) => a + Number(g.amountUSD || 0), 0) || null,
    needsApproval,
    approvalAddress: est.approvalAddress || null,
    approvalAmount: amount,
    tx: q.transactionRequest || null,
  };
}

/* The signable payload. Solana comes back as a base64 versioned transaction
   for the wallet to sign and send; EVM comes back as a plain tx request. */
async function build(req) {
  const c = CHAINS[req.chain];
  if (!c) throw new Error("unknown chain");
  if (c.kind === "svm") {
    const body = {
      quoteResponse: req.quote.raw,
      userPublicKey: req.owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2000000, priorityLevel: "high" } },
    };
    // The mints live on the router's own response, not on the shape we return.
    const raw = (req.quote && req.quote.raw) || {};
    // noFee: the second attempt, after the router refused the fee account.
    const feeAcct = req.noFee ? null : await solanaFeeAccount(raw.inputMint, raw.outputMint);
    if (feeAcct) body.feeAccount = feeAcct;
    const r = await getJSON(`${API.jup}/swap/v1/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r || !r.swapTransaction) throw new Error("router did not return a transaction");
    return { kind: "svm", transaction: r.swapTransaction, lastValidBlockHeight: r.lastValidBlockHeight };
  }
  const tx = req.quote.tx;
  if (!tx) throw new Error("router did not return a transaction");
  return {
    kind: "evm",
    chainId: c.id,
    tx: { to: tx.to, data: tx.data, value: tx.value, from: req.owner, gas: tx.gasLimit },
  };
}

/* The ERC-20 allowance step, as its own transaction. Exact amount, not
   MAX_UINT: an unlimited approval to a router is a standing permission most
   people never revoke, and Xeet has no business asking for one. */
function buildApproval(req) {
  const c = CHAINS[req.chain];
  const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
  const padA = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  return {
    kind: "evm",
    chainId: c.id,
    tx: {
      to: req.token, from: req.owner,
      data: "0x095ea7b3" + padA(req.spender) + pad(req.amount),
      value: "0x0",
    },
  };
}

/* --------------------------------------------------------- confirmation */
async function confirm(chainKey, hash) {
  const c = CHAINS[chainKey];
  if (!c) throw new Error("unknown chain");
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    try {
      if (c.kind === "svm") {
        const r = await rpc(c.rpc, "getSignatureStatuses", [[hash], { searchTransactionHistory: true }]);
        const st = r && r.value && r.value[0];
        if (st) {
          if (st.err) return { ok: false, reason: "The transaction failed on chain" };
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return { ok: true };
        }
      } else {
        const r = await rpc(c.rpc, "eth_getTransactionReceipt", [hash]);
        if (r) return r.status === "0x1" ? { ok: true } : { ok: false, reason: "The transaction reverted" };
      }
    } catch { /* keep waiting: an RPC blip is not a failed trade */ }
    await new Promise((r) => setTimeout(r, 1800));
  }
  return { ok: null, reason: "Still pending — check the explorer" };
}

/* ------------------------------------------------------------- holdings */
/* What the connected wallet actually owns, priced.
 *
 * Solana answers completely: one call lists every mint held, and Jupiter
 * prices and names them in batches. EVM does not — reading "every ERC-20 this
 * address holds" needs an indexer, and adding eight explorer hosts to the
 * manifest to fill one tab is a permission bill this extension has not earned.
 * So EVM shows the native balance plus every token you have traded through
 * Xeet, read straight from the chain. That is a smaller list, and it is the
 * one the person is most likely to be looking for.
 */
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function solanaHoldings(owner) {
  const c = CHAINS.solana;
  const all = await getJSON(`${API.jup}/ultra/v1/balances/${owner}`);
  const rows = [];
  const native = Number((all.SOL && all.SOL.uiAmount) || 0);
  const mints = Object.keys(all).filter((k) => k !== "SOL" && Number((all[k] || {}).uiAmount) > 0);

  // Metadata and prices, both batched — 136 mints is three round trips, not
  // a hundred and thirty-six.
  const meta = {}, price = {};
  for (const batch of chunk(mints, 50)) {
    const q = batch.join(",");
    const [m, p] = await Promise.all([
      getJSON(`${API.jup}/tokens/v2/search?query=${q}`).catch(() => []),
      getJSON(`${API.jup}/price/v3?ids=${q}`).catch(() => ({})),
    ]);
    for (const t of Array.isArray(m) ? m : []) if (t && t.id) meta[t.id] = t;
    for (const k in p) if (p[k]) price[k] = Number(p[k].usdPrice);
  }

  const solPrice = await nativeUsd("solana");
  if (native > 0) {
    rows.push({
      chain: "solana", chainName: c.name, address: c.native.mint, symbol: "SOL",
      name: "Solana", amount: native, price: solPrice, usd: solPrice ? native * solPrice : null,
      image: null, native: true,
    });
  }
  for (const mint of mints) {
    const amt = Number(all[mint].uiAmount);
    const m = meta[mint] || {};
    // Jupiter calls the wrapped mint "SOL" too, which puts two rows named SOL
    // in the list holding different money. They are different balances.
    const wrapped = mint === c.native.mint;
    const pr = price[mint] ?? (m.usdPrice != null ? Number(m.usdPrice) : null);
    rows.push({
      chain: "solana", chainName: c.name, address: mint,
      symbol: wrapped ? "wSOL" : sym(m.symbol || mint.slice(0, 4)),
      name: wrapped ? "Wrapped SOL" : (m.name || ""),
      amount: amt, price: pr, usd: pr ? amt * pr : null,
      image: m.icon && /^https:\/\//.test(m.icon) ? m.icon : null, native: false,
    });
  }
  return rows;
}

async function evmHoldings(owner) {
  const { swaps } = await chrome.storage.local.get({ swaps: [] });
  const rows = [];
  // one native row per chain the wallet has actually touched, plus the
  // tokens Xeet has bought or sold for it
  const seen = new Map();
  for (const s of swaps) {
    const c = CHAINS[s.chain];
    if (!c || c.kind !== "evm" || !s.address) continue;
    seen.set(c.key + ":" + s.address.toLowerCase(), { chain: c, address: s.address, symbol: s.symbol, image: s.image });
  }
  const chains = new Set([...seen.values()].map((v) => v.chain.key));
  if (!chains.size) chains.add("base");

  await Promise.all([...chains].map(async (key) => {
    const c = CHAINS[key];
    const [bal, usd] = await Promise.all([
      balances(key, owner, null).catch(() => null),
      nativeUsd(key).catch(() => null),
    ]);
    if (bal && bal.native > 0) {
      rows.push({
        chain: key, chainName: c.name, address: c.native.address, symbol: c.native.symbol,
        name: c.name, amount: bal.native, price: usd, usd: usd ? bal.native * usd : null,
        image: null, native: true,
      });
    }
  }));

  await Promise.all([...seen.values()].map(async (t) => {
    const b = await balances(t.chain.key, owner, t.address).catch(() => null);
    if (!b || !b.token) return;
    const info = await resolveToken(t.address, t.chain.key).catch(() => null);
    const pr = info && info.token ? info.token.priceUsd : null;
    rows.push({
      chain: t.chain.key, chainName: t.chain.name, address: t.address,
      symbol: sym(t.symbol || (info && info.token && info.token.symbol) || "?"),
      name: (info && info.token && info.token.name) || "",
      amount: b.token, price: pr, usd: pr ? b.token * pr : null,
      image: (info && info.token && info.token.image) || t.image || null, native: false,
    });
  }));
  return rows;
}

/* Both wallets at once, because both can be connected. The list is one list:
   a person looking at what they own does not care which world a coin is in
   until they go to sell it. */
async function holdings() {
  const { wallets } = await chrome.storage.local.get({ wallets: null });
  const svm = wallets && wallets.svm, evm = wallets && wallets.evm;
  // The trading account is money the user owns, sitting in an account they
  // do not open a wallet app to see. Leaving it out of "Holdings" would make
  // this list quietly wrong for exactly the people using one-click.
  const turboAcc = await turbo.account("svm").catch(() => null);
  if (!svm && !evm && !turboAcc) return { rows: [], total: 0, wallet: null, partial: false };
  const key = `hold:${(svm || {}).address || "-"}:${(evm || {}).address || "-"}:${(turboAcc || {}).address || "-"}`;
  return cached(key, 20000, async () => {
    const parts = await Promise.all([
      svm ? solanaHoldings(svm.address).catch(() => []) : [],
      evm ? evmHoldings(evm.address).catch(() => []) : [],
      turboAcc ? solanaHoldings(turboAcc.address).catch(() => []) : [],
    ]);
    parts[2].forEach((r) => { r.oneClick = true; });
    const rows = parts.flat();
    rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));
    const total = rows.reduce((n, r) => n + (r.usd || 0), 0);
    return { rows, total, wallet: svm || evm || turboAcc, partial: !!evm };
  });
}

/* ---------------------------------------------------------- happening now */
/* The popup's board. Stage is computed from flow, not from price alone: a
   token up 30% on nine trades is not "sending", it is illiquid. */
function stageOf(t) {
  const m5 = t.txns.m5 || { buys: 0, sells: 0 };
  const h1 = t.txns.h1 || { buys: 0, sells: 0 };
  const rate5 = (m5.buys || 0) + (m5.sells || 0);
  const rate1 = ((h1.buys || 0) + (h1.sells || 0)) / 12; // per 5 min
  const accel = rate1 > 0 ? rate5 / rate1 : (rate5 > 0 ? 2 : 0);
  const chg = Number(t.change.h1 || 0);
  const buyShare = rate5 ? (m5.buys || 0) / rate5 : 0.5;
  if (rate5 >= 25 && accel >= 1.6 && chg > 6 && buyShare > 0.58) return "sending";
  if (rate5 >= 10 && accel >= 1.15 && chg > 1.5) return "running";
  if (rate5 >= 4 && (chg > 0.4 || buyShare > 0.55)) return "warm";
  return "quiet";
}

async function trending(limit) {
  return cached("trending", 45000, async () => {
    const boosts = await getJSON(API.dsBoosts).catch(() => []);
    const picks = (Array.isArray(boosts) ? boosts : []).filter((b) => BY_DS[b.chainId]).slice(0, 28);
    const seen = new Set();
    const out = [];
    // Dexscreener rate-limits, so ask in small waves rather than 28 at once.
    for (let i = 0; i < picks.length; i += 6) {
      const wave = picks.slice(i, i + 6);
      const rows = await Promise.all(wave.map((b) =>
        getJSON(API.dsTokens + encodeURIComponent(b.tokenAddress)).catch(() => null)));
      for (const body of rows) {
        const best = pickPair((body && body.pairs) || []);
        if (!best) continue;
        const t = shapePair(best);
        if (seen.has(t.address) || t.liquidity < 12000) continue;
        seen.add(t.address);
        t.stage = stageOf(t);
        out.push(t);
      }
      if (out.length >= (limit || 12) * 2) break;
    }
    const rank = { sending: 3, running: 2, warm: 1, quiet: 0 };
    out.sort((a, b) => (rank[b.stage] - rank[a.stage]) || (Number(b.change.h1 || 0) - Number(a.change.h1 || 0)));
    return out.slice(0, limit || 12);
  }).catch(() => []);
}

/* --------------------------------------------------------- token art */
/* x.com's CSP is `img-src 'self' https://*.twimg.com … data: blob:`, which
 * means a token logo on any other host is dropped by the page before it is
 * fetched — no error, no event, just no picture. So the worker fetches it (an
 * extension request, under host permissions the manifest lists by name) and
 * hands back a data: URL, which the CSP does allow.
 *
 * Only Dexscreener's own CDN is permitted, so this cannot be turned into a
 * general-purpose fetch by a token that names its logo as somewhere else. */
const ART_HOSTS = /^https:\/\/(cdn|dd)\.dexscreener\.com\//;

async function art(url) {
  if (!ART_HOSTS.test(url || "")) throw new Error("not an allowed image host");
  return cached("art:" + url, 30 * 60 * 1000, async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error("image " + r.status);
    const blob = await r.blob();
    if (blob.size > 512 * 1024) throw new Error("image too large");
    if (!/^image\//.test(blob.type)) throw new Error("not an image");
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return `data:${blob.type};base64,${btoa(bin)}`;
  });
}

/* ------------------------------------------------------------ the fee */
/* Jupiter takes its platform fee in the OUTPUT token, into a referral token
   account created through referral.jup.ag — one per mint. There is no way to
   tell from the swap API whether the configured account is right for a given
   mint; the only place that is checked is the chain, at the moment the swap
   would have gone through. So check here instead: an initialised SPL token
   account whose mint matches. Answers are cached because the set of tokens
   somebody trades in a session is small and this must not add a round trip to
   every quote. */
const feeOk = new Map();
const mintProg = new Map();

/* The original Solana token program. A mint owned by anything else — in
   practice Token-2022, TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb — cannot be
   paired with a fee account held under this one: the router checks the two
   against each other and aborts the whole swap with 0x177e,
   IncorrectTokenProgramID. That is a failed trade, not a missed fee, so the
   fee is dropped instead. */
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

async function solanaMintProgram(mint) {
  if (!mint) return null;
  if (mintProg.has(mint)) return mintProg.get(mint);
  let owner = null;
  try {
    const r = await fetch(CHAINS.solana.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
      }),
    }).then((x) => x.json());
    owner = (r && r.result && r.result.value && r.result.value.owner) || null;
  } catch { owner = null; }
  mintProg.set(mint, owner);
  return owner;
}

async function solanaFeeAccount(inputMint, outputMint) {
  const acct = FEE.solanaFeeAccount;
  if (!acct || (!inputMint && !outputMint)) return null;
  const key = `${acct}:${inputMint}:${outputMint}`;
  if (feeOk.has(key)) return feeOk.get(key);

  let usable = null;
  try {
    // Both sides have to be ordinary SPL. One Token-2022 mint anywhere in the
    // route and the fee is simply not taken on this trade.
    const [pin, pout] = await Promise.all([
      solanaMintProgram(inputMint), solanaMintProgram(outputMint),
    ]);
    if ((inputMint && pin && pin !== SPL_TOKEN) || (outputMint && pout && pout !== SPL_TOKEN)) {
      feeOk.set(key, null);
      return null;
    }

    const r = await fetch(CHAINS.solana.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [acct, { encoding: "jsonParsed", commitment: "confirmed" }],
      }),
    }).then((x) => x.json());
    const info = r && r.result && r.result.value;
    const parsed = info && info.data && info.data.parsed;
    // Either side of the swap. Verified against the network: Jupiter takes the
    // fee wherever the account's mint appears, so ONE wrapped-SOL account
    // collects on every trade — buys pay in SOL, sells receive it — instead of
    // needing an account per token bought, which is not a thing anyone can
    // maintain across thousands of memecoins.
    const mint = parsed && parsed.info && parsed.info.mint;
    const ok = !!parsed
      && parsed.type === "account"
      && parsed.info
      && (mint === outputMint || mint === inputMint)
      && parsed.info.state === "initialized";
    usable = ok ? acct : null;
  } catch {
    usable = null;                 // unreachable node: trade, do not charge
  }
  feeOk.set(key, usable);
  return usable;
}

/* ---------------------------------------------------------- one click */
/* The whole point of routing this through the worker: the cap is checked
   where the page cannot reach it, and the key is used where the page cannot
   see it. The content script asks for a trade and gets a hash or a refusal;
   it never touches either. */
async function oneClick(m) {
  const c = CHAINS[m.chain];
  if (!c) throw new Error("unknown chain");
  const gate = await turbo.allow(c.key, m.usd, { sell: !!m.sell });
  if (!gate.ok) throw new Error(gate.why);

  // Quote and build are addressed to the TRADING account, not the main
  // wallet — it is a different account holding different money.
  const owner = gate.account.address;
  const q = await quote(Object.assign({}, m, { owner }));
  const built = await build({ chain: m.chain, owner, quote: q });

  /* Solana arrives finished: the router returns a transaction with the fee
     account already in it and an empty signature slot, so there is nothing to
     approve first and nothing to assemble — the account signs it and the
     cluster takes it. */
  if (built.kind === "svm") {
    try {
      const sent = await turbo.signAndSend(built.transaction, c.rpc, m.sell ? 0 : m.usd);
      return { quote: q, hash: sent.hash, owner, approval: null };
    } catch (e) {
      // 0x177e / 6014 is the router saying the fee account's token program does
      // not match the mint's. The trade is fine; the fee is what has to go.
      if (!/0x177e|6014|IncorrectTokenProgram/i.test(String(e && e.message))) throw e;
      // The quote carries the fee too: leave it in and the router answers
      // "feeAccount is required for swap with platformFee".
      const bare = Object.assign({}, q, { raw: Object.assign({}, q.raw) });
      delete bare.raw.platformFee;
      const plain = await build({ chain: m.chain, owner, quote: bare, noFee: true });
      const sent = await turbo.signAndSend(plain.transaction, c.rpc, m.sell ? 0 : m.usd);
      return { quote: q, hash: sent.hash, owner, approval: null, feeWaived: true };
    }
  }

  // Selling a token means letting the router move it first. The quote already
  // says whether the allowance is short and who needs it — it was priced for
  // this very account — so there is nothing to work out again here. The account
  // pays for its own approval, and waits for it: a swap sent before the
  // approval mines is a swap that reverts and burns the gas anyway.
  let approval = null;
  if (q.needsApproval && q.approvalAddress) {
    const need = await turbo.ensureAllowance(c, m.from.address, q.approvalAddress, q.approvalAmount);
    if (!need.already) {
      approval = need.hash;
      await confirm(m.chain, need.hash);
    }
  }

  // A sale is not charged against the daily cap — it is the way back out.
  const sent = await turbo.sendCall(c, built.tx, m.sell ? 0 : m.usd);
  return { quote: q, hash: sent.hash, owner, approval };
}

/* What the trading account is holding right now. The panel needs this to
   know whether a tap on SELL has anything to sell, and the popup shows it
   so the account is never a black box you have put money into. */
async function turboHoldings(kind) {
  const id = kind === "svm" ? "svm" : "evm";
  const acc = await turbo.account(id);
  if (!acc) return { rows: [], total: 0, account: null };
  const rows = await (id === "svm" ? solanaHoldings(acc.address) : evmHoldings(acc.address)).catch(() => []);
  rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  return { rows, total: rows.reduce((n, r) => n + (r.usd || 0), 0), account: acc.address };
}

/* ------------------------------------------------------------- settings */
async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return Object.assign({}, DEFAULTS, s);
}

async function history() {
  const { swaps } = await chrome.storage.local.get({ swaps: [] });
  return swaps;
}

async function record(entry) {
  const swaps = await history();
  swaps.unshift(entry);
  await chrome.storage.local.set({ swaps: swaps.slice(0, 120) });
  return swaps.length;
}

/* ------------------------------------------------------------ the wire */
/* Which build of this file is actually answering.
 *
 * Chrome re-reads the popup off disk every time it opens, but keeps the
 * service worker alive until the extension is reloaded. Ship a version that
 * moves the trading account to another chain and the two disagree: a popup
 * describing Robinhood Chain, in front of a worker that still creates Solana
 * accounts — which is exactly what it did, silently, and the only clue was a
 * base58 address sitting under the word ETH.
 *
 * This is a literal, not the manifest's version: an old worker reading the new
 * manifest off disk would report the new number and prove nothing. */
const BUILD = "1.8.0";

const HANDLERS = {
  // Not "build" — that name is already the swap builder further down, and an
  // object literal lets the later key win, so this one was silently shadowed
  // and answered "unknown chain".
  buildId: () => ({ build: BUILD }),
  resolve: (m) => resolveToken(m.query, m.chainHint),
  chart: (m) => chart(m.chain, m.pool, m.range, m.denom),
  screen: (m) => screen(m.chain, m.address),
  art: (m) => art(m.url),
  nativeUsd: (m) => nativeUsd(m.chain),
  decimals: (m) => decimals(m.chain, m.address),
  balances: (m) => balances(m.chain, m.owner, m.token),
  quote: (m) => quote(m),
  build: (m) => build(m),
  approval: (m) => buildApproval(m),
  confirm: (m) => confirm(m.chain, m.hash),
  trending: (m) => trending(m.limit),
  holdings: () => holdings(),
  /* ------------------------------------------------------------- perps */
  /* Read-only halves answer from here; the signature itself happens in the
     page, in the user's own wallet, and comes back to perpSubmit. */
  perpMarket: (m) => perps.marketFor(m.symbol),
  perpState: (m) => perps.accountState(m.address),
  perpOrder: async (m) => {
    const market = await perps.marketFor(m.symbol);
    if (!market) throw new Error("no perp market for " + m.symbol);
    if (!market.mid) throw new Error("no price for " + market.name);
    // A market order, expressed the way the exchange wants it: an IOC limit a
    // little through the book so it fills, with the slippage capped.
    const slip = Math.min(Math.max(Number(m.slippagePct) || 1, 0.1), 5) / 100;
    const px = market.mid * (m.isBuy ? 1 + slip : 1 - slip);
    const notional = Number(m.usd) * Math.max(1, Number(m.leverage) || 1);
    const size = notional / market.mid;
    return perps.orderPayload({
      assetIndex: market.index,
      isBuy: !!m.isBuy,
      price: perps.fmtPrice(px, market.szDecimals),
      size: perps.fmtSize(size, market.szDecimals),
      nonce: Date.now(),
    });
  },
  perpSubmit: (m) => perps.submit({ action: m.action, nonce: m.nonce, signature: m.signature }),

  /* One approval, then taps. The agent key lives here; the wallet is asked to
     authorise it exactly once and never again. */
  perpAgent: async (m) => {
    const a = await turbo.agent();
    if (!a) return { address: null, live: false };
    const live = await perps.agentLive(m.address, a.address).catch(() => false);
    return { address: a.address, live };
  },

  perpAgentApproval: async () => {
    const { address } = await turbo.makeAgent();
    return { agentAddress: address, ...perps.approveAgentPayload({ agentAddress: address, nonce: Date.now() }) };
  },

  perpAgentConfirm: (m) =>
    perps.submit({ action: m.action, nonce: m.nonce, signature: m.signature }),

  /* The order itself, signed by the agent — no wallet window at all. */
  perpTap: async (m) => {
    const a = await turbo.agent();
    if (!a) throw new Error("one-tap perps are not enabled yet");
    const market = await perps.marketFor(m.symbol);
    if (!market || !market.mid) throw new Error("no perp market for " + m.symbol);
    const slip = Math.min(Math.max(Number(m.slippagePct) || 1, 0.1), 5) / 100;
    const px = market.mid * (m.isBuy ? 1 + slip : 1 - slip);
    const size = (Number(m.usd) * Math.max(1, Number(m.leverage) || 1)) / market.mid;
    const order = perps.orderPayload({
      assetIndex: market.index,
      isBuy: !!m.isBuy,
      price: perps.fmtPrice(px, market.szDecimals),
      size: perps.fmtSize(size, market.szDecimals),
      nonce: Date.now(),
    });
    const signature = await perps.signWith(a.key, order.typedData);
    return perps.submit({ action: order.action, nonce: order.nonce, signature });
  },

  turboInfo: async () => ({
    build: BUILD,
    settings: await turbo.settings(),
    account: await turbo.account("evm"),
    svm: await turbo.account("svm"),
  }),
  turboSettings: (m) => turbo.setSettings(m.patch),
  turboCreate: (m) => turbo.create(m.kind === "svm" ? "svm" : "evm"),
  turboImport: (m) => turbo.importSecret(m.secret, m.kind === "svm" ? "svm" : "evm"),
  turboWipe: (m) => turbo.wipe(m.kind === "svm" ? "svm" : "evm"),
  // The Solana account, under the name an older popup asks for. It trades; it
  // can be emptied and deleted, which is the only reason it is still reachable.
  turboLegacy: async () => {
    const acc = await turbo.legacy();
    if (!acc) return null;
    const plan = await turbo.sweepPlan(CHAINS.solana.rpc).catch(() => null);
    return { address: acc.address, sol: plan ? plan.sol : null };
  },
  turboLegacySweep: (m) => turbo.sweep(CHAINS.solana.rpc, m.to),
  turboLegacyWipe: () => turbo.wipe("svm"),
  turboBalance: (m) => (m && m.kind === "svm"
    ? turbo.sweepPlan(CHAINS.solana.rpc)
    : turbo.nativeBalance(CHAINS.robinhood)),
  turboAllow: async (m) => turbo.allow((CHAINS[m.chain] || {}).key, m.usd, { sell: !!m.sell }),
  turboHoldings: (m) => turboHoldings(m && m.kind),
  turboSweep: (m) => (m.kind === "svm"
    ? turbo.sweep(CHAINS.solana.rpc, m.to)
    : turbo.sweepEvm(CHAINS.robinhood, m.to)),
  oneClick: (m) => oneClick(m),
  settings: () => getSettings(),
  saveSettings: async (m) => { await chrome.storage.sync.set(m.patch); return getSettings(); },
  history: () => history(),
  record: (m) => record(m.entry),
  stage: (m) => stageOf(m.token),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const fn = HANDLERS[msg && msg.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg))
    .then((data) => reply({ ok: true, data }))
    .catch((e) => reply({ ok: false, error: (e && e.message) || String(e) }));
  return true; // async
});

/* A connection stored before this version records only one account and no
   icon, and there is no way to tell which of a wallet's accounts it was. Rather
   than carry a record that cannot answer that, drop it once and let the next
   connect write a complete one. Keyed so it happens exactly once, not on every
   update: wiping somebody's connections on every release would be its own bug. */
const WALLET_RESET = "accounts-1";

chrome.runtime.onInstalled.addListener(async (d) => {
  const cur = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set(Object.assign({}, DEFAULTS, cur));

  const { walletReset } = await chrome.storage.local.get({ walletReset: null });
  if (walletReset !== WALLET_RESET) {
    await chrome.storage.local.set({ wallets: { svm: null, evm: null }, walletReset: WALLET_RESET });
  }

  if (d.reason === "install") {
    chrome.tabs.create({ url: "https://x.com/home" }).catch(() => {});
  }
});
