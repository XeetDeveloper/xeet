/* Xeet — perpetuals, through Hyperliquid.
 *
 * The panel already knows how to put a market on a post. This is the other
 * side of a position:long or short, with leverage, signed by the same wallet
 * that signs a swap. Nothing is held here either — the funds sit in the
 * exchange's own account, which the user deposits to and withdraws from.
 *
 * WHY HYPERLIQUID AND NOT A SOLANA VENUE. The extension ships no bundler and
 * no npm: every dependency is a file somebody has read. Drift and Jupiter's
 * perps want a multi-megabyte SDK; Hyperliquid wants a signed JSON body. That
 * is the whole reason, and it is the same reason the swap path uses plain
 * HTTP against routers instead of their SDKs.
 *
 * THE SIGNATURE IS THE WHOLE JOB. An order is msgpack of the action, with the
 * nonce and a vault flag appended, keccak'd, and that digest signed as EIP-712
 * typed data by the user's wallet. Get one byte of the encoding wrong and the
 * exchange recovers a different address and rejects the order — which is why
 * the encoder below is written out rather than imported, and why it is tested
 * against the live exchange before it is trusted.
 */
import { keccak_256 } from "../vendor/sha3.js";

const API = "https://api.hyperliquid.xyz";

/* ------------------------------------------------------------- msgpack */
/* Only the shapes an order uses: maps with string keys, strings, integers,
   booleans, arrays and doubles. Written against the format's own spec. */
function mp(value) {
  const out = [];
  encode(value, out);
  return Uint8Array.from(out);
}

function encode(v, out) {
  if (v === null) return out.push(0xc0);
  if (v === true) return out.push(0xc3);
  if (v === false) return out.push(0xc2);
  if (typeof v === "number") return Number.isInteger(v) ? int(v, out) : dbl(v, out);
  if (typeof v === "string") return str(v, out);
  if (Array.isArray(v)) {
    if (v.length < 16) out.push(0x90 | v.length);
    else { out.push(0xdc, (v.length >> 8) & 0xff, v.length & 0xff); }
    for (const item of v) encode(item, out);
    return;
  }
  if (v instanceof Uint8Array) {
    out.push(0xc4, v.length);
    for (const b of v) out.push(b);
    return;
  }
  const keys = Object.keys(v);
  if (keys.length < 16) out.push(0x80 | keys.length);
  else out.push(0xde, (keys.length >> 8) & 0xff, keys.length & 0xff);
  for (const k of keys) { str(k, out); encode(v[k], out); }
}

function str(s, out) {
  const b = new TextEncoder().encode(s);
  if (b.length < 32) out.push(0xa0 | b.length);
  else if (b.length < 256) out.push(0xd9, b.length);
  else out.push(0xda, (b.length >> 8) & 0xff, b.length & 0xff);
  for (const x of b) out.push(x);
}

function int(n, out) {
  if (n >= 0) {
    if (n < 128) return out.push(n);
    if (n < 256) return out.push(0xcc, n);
    if (n < 65536) return out.push(0xcd, (n >> 8) & 0xff, n & 0xff);
    if (n < 4294967296) return out.push(0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    return big(BigInt(n), 0xcf, out);
  }
  if (n >= -32) return out.push(0xe0 | (n + 32));
  if (n >= -128) return out.push(0xd0, n & 0xff);
  if (n >= -32768) return out.push(0xd1, (n >> 8) & 0xff, n & 0xff);
  return out.push(0xd2, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function big(n, tag, out) {
  out.push(tag);
  for (let i = 7; i >= 0; i--) out.push(Number((n >> BigInt(i * 8)) & 0xffn));
}

function dbl(n, out) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, n);
  out.push(0xcb);
  for (let i = 0; i < 8; i++) out.push(buf.getUint8(i));
}

/* ------------------------------------------------------------ the market */
let cache = { at: 0, universe: [], mids: {} };

export async function markets(force) {
  if (!force && Date.now() - cache.at < 60000 && cache.universe.length) return cache;
  const [meta, mids] = await Promise.all([
    post("/info", { type: "meta" }),
    post("/info", { type: "allMids" }),
  ]);
  cache = {
    at: Date.now(),
    universe: (meta.universe || []).map((u, i) => ({
      index: i, name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
    })),
    mids: mids || {},
  };
  return cache;
}

/* Does this ticker have a perp at all? Most memecoins do not, and saying so is
   the difference between a product and a disappointment. */
export async function marketFor(symbol) {
  const s = String(symbol || "").replace(/^\$/, "").toUpperCase();
  const { universe, mids } = await markets();
  const hit = universe.find((u) => u.name.toUpperCase() === s)
    || universe.find((u) => u.name.toUpperCase() === "k" + s.toUpperCase());
  if (!hit) return null;
  return { ...hit, mid: Number(mids[hit.name]) || null };
}

export async function accountState(address) {
  if (!address) return null;
  return post("/info", { type: "clearinghouseState", user: address });
}

/* ------------------------------------------------------------ the order */
/* Sizes and prices have to arrive as the exchange formats them: at most five
   significant figures, and no more decimals than the asset allows. A number
   formatted loosely is rejected, so this is not cosmetic. */
export function fmtSize(n, szDecimals) {
  const v = Number(n);
  return trim(v.toFixed(Math.max(0, szDecimals)));
}

export function fmtPrice(n, szDecimals) {
  const v = Number(n);
  const maxDec = Math.max(0, 6 - szDecimals);
  let s = v.toPrecision(5);
  if (s.includes("e")) s = v.toFixed(maxDec);
  const [i, d = ""] = s.split(".");
  return trim(d ? `${i}.${d.slice(0, maxDec)}` : i);
}

const trim = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/* The digest the wallet is asked to sign: msgpack(action) ‖ nonce ‖ vault flag,
   keccak'd, wrapped in the exchange's EIP-712 envelope. */
export function orderPayload({ assetIndex, isBuy, price, size, reduceOnly = false, nonce }) {
  const action = {
    type: "order",
    orders: [{
      a: assetIndex,
      b: !!isBuy,
      p: String(price),
      s: String(size),
      r: !!reduceOnly,
      t: { limit: { tif: "Ioc" } },     // immediate-or-cancel: a market order
    }],
    grouping: "na",
  };
  return { action, nonce, typedData: typedDataFor(action, nonce) };
}

export function typedDataFor(action, nonce) {
  const packed = mp(action);
  const buf = new Uint8Array(packed.length + 9);
  buf.set(packed, 0);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(packed.length, BigInt(nonce));
  buf[packed.length + 8] = 0;            // no vault
  const connectionId = "0x" + [...keccak_256(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return {
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: "a", connectionId },
  };
}

/* What the wallet hands back is one 65-byte string; the exchange wants it in
   pieces. */
export function splitSignature(sig) {
  const s = String(sig).replace(/^0x/, "");
  let v = parseInt(s.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { r: "0x" + s.slice(0, 64), s: "0x" + s.slice(64, 128), v };
}

export async function submit({ action, nonce, signature }) {
  const body = { action, nonce, signature: splitSignature(signature), vaultAddress: null };
  const r = await post("/exchange", body);
  if (r && r.status === "err") throw new Error(readable(r.response));
  const statuses = ((r || {}).response || {}).data?.statuses || [];
  const bad = statuses.find((s) => s && s.error);
  if (bad) throw new Error(readable(bad.error));
  return r;
}

function readable(msg) {
  const m = String(msg || "");
  if (/does not exist/i.test(m)) return "this wallet has no Hyperliquid account yet — deposit USDC there first";
  if (/insufficient margin|not enough/i.test(m)) return "not enough margin for this size";
  if (/reduce only/i.test(m)) return "nothing open to reduce";
  if (/Order has invalid price|tick/i.test(m)) return "price is outside what the market accepts right now";
  return m;
}

async function post(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("hyperliquid " + r.status);
  return r.json();
}
