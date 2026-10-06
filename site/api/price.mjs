/* Xeet — the price the vault settles against.
 *
 * The vault lives on Robinhood Chain and the coins it prices live on Solana,
 * so the chain cannot see them. This service looks the price up and signs it;
 * the contract checks that signature and refuses anything older than two
 * minutes. That is a trust assumption and the product says so out loud — but
 * it is fenced on both sides: a price can only be used while it is fresh, and
 * if this service ever goes quiet, every trader can walk out of the vault with
 * their margin an hour later without asking anybody. This key can stop the
 * venue; it cannot keep a single dollar inside it.
 *
 * WHAT IS SIGNED. The median price across the token's own pools, not the first
 * one a DEX index returns: a single thin pool is the cheapest thing in crypto
 * to push around, and taking the median of several makes one pool's spike
 * somebody else's problem rather than the vault's. Pools under $3K of
 * liquidity are ignored entirely.
 *
 * The key is in the environment and never leaves this file.
 */
import * as secp from "./_lib/secp256k1.js";
import { keccak_256 } from "./_lib/sha3.js";

const KEY = process.env.XEET_OPERATOR_KEY || "";
const MIN_POOL_USD = 3000;

const utf8 = (s) => new TextEncoder().encode(s);
const hex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) || []).map((x) => parseInt(x, 16)));

const pad32 = (b) => { const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
const cat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0; for (const x of a) { out.set(x, i); i += x.length; } return out;
};
const num32 = (n) => { let h = BigInt(n).toString(16); if (h.length % 2) h = "0" + h; return pad32(bytes(h)); };

/* A market is named the same way everywhere — here, in the contract's
   setMarket, and in the extension — or the signature is for nothing. */
export const marketId = (chain, address) => hex(keccak_256(utf8(`${chain}:${address}`)));

function domainSeparator(chainId, vault) {
  return keccak_256(cat(
    keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak_256(utf8("XeetVault")),
    keccak_256(utf8("1")),
    num32(chainId),
    pad32(bytes(vault)),
  ));
}

export function digest(chainId, vault, market, value, at) {
  const structHash = keccak_256(cat(
    keccak_256(utf8("Price(bytes32 market,uint256 value,uint64 at)")),
    bytes(market),
    num32(value),
    num32(at),
  ));
  return keccak_256(cat(Uint8Array.from([0x19, 0x01]), domainSeparator(chainId, vault), structHash));
}

export async function sign(d) {
  const key = bytes(KEY);
  const packed = await secp.signAsync(d, key, { prehash: false, format: "recovered" });
  const sig = secp.Signature.fromBytes(packed, "recovered");
  return "0x" + sig.r.toString(16).padStart(64, "0")
    + sig.s.toString(16).padStart(64, "0")
    + (sig.recovery + 27).toString(16).padStart(2, "0");
}

/* The price itself. Dexscreener indexes every chain this product touches, and
   a token's pairs come back in one request. */
export async function priceOf(chain, address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error("price source is unavailable");
  const pairs = ((await r.json()) || {}).pairs || [];

  const usable = pairs
    .filter((p) => String(p.chainId || "").toLowerCase() === chain.toLowerCase())
    .filter((p) => String((p.baseToken || {}).address || "").toLowerCase() === address.toLowerCase())
    .filter((p) => Number((p.liquidity || {}).usd || 0) >= MIN_POOL_USD)
    // The price is kept as the TEXT the index returned. A memecoin price is a
    // number like 0.0000037, and the moment it becomes a double the last
    // digits stop being the ones anybody quoted.
    .map((p) => ({ text: String(p.priceUsd || ""), n: Number(p.priceUsd), liq: Number((p.liquidity || {}).usd || 0) }))
    .filter((p) => p.n > 0);

  if (!usable.length) throw new Error("no pool deep enough to price this token");

  // A median that is an actual observed price, not an average of two of them.
  const sorted = usable.slice().sort((a, b) => a.n - b.n);
  const mid = sorted[Math.floor((sorted.length - 1) / 2)];

  return {
    price: mid.text, pools: usable.length,
    liquidity: usable.reduce((n, p) => n + p.liq, 0),
  };
}

/* 1e18 of a price, done on the decimal text rather than on a double.
   0.0000037 * 1e18 in floating point is 3699999999999.9995, and a price that
   disagrees with the one the pool quoted — in the last digits or anywhere
   else — is a price somebody can argue with. */
export function scale18(input) {
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(input).trim());
  if (!m) throw new Error("bad price");
  const [, sign, int = "", frac = "", exp = "0"] = m;
  if (sign === "-") throw new Error("negative price");
  const digits = (int + frac).replace(/^0+/, "") || "0";
  const shift = 18 - frac.length + Number(exp || 0);
  let out = BigInt(digits);
  if (shift >= 0) out *= 10n ** BigInt(shift);
  else out /= 10n ** BigInt(-shift);
  return out;
}

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!KEY) return res.status(503).json({ error: "no operator key configured" });

  const url = new URL(req.url, "http://x");
  const chain = (url.searchParams.get("chain") || "solana").toLowerCase();
  const address = url.searchParams.get("address") || "";
  const vault = url.searchParams.get("vault") || process.env.XEET_VAULT || "";
  const chainId = Number(url.searchParams.get("chainId") || process.env.XEET_VAULT_CHAIN || 4663);

  if (!/^[A-Za-z0-9]{32,44}$|^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "bad token address" });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) {
    return res.status(400).json({ error: "no vault address" });
  }

  try {
    const { price, pools, liquidity } = await priceOf(chain, address);
    const value = scale18(price);
    if (value === 0n) throw new Error("this token's price rounds to nothing at 18 decimals");
    const at = Math.floor(Date.now() / 1000);
    const market = marketId(chain, address);
    const signature = await sign(digest(chainId, vault, market, value, at));

    // Short enough that a cached answer is still inside the contract's own
    // freshness window, long enough that a busy panel is not re-signing.
    res.setHeader("cache-control", "public, max-age=0, s-maxage=5");
    res.status(200).json({
      market, value: value.toString(), at, signature,
      price, pools, liquidity, maxAge: 120,
    });
  } catch (e) {
    res.status(502).json({ error: e.message || "could not price this token" });
  }
}
