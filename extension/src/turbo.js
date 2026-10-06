/* Xeet — one-click trading, on Robinhood Chain and on Solana.
 *
 * OPT-IN, AND OFF UNTIL SOMEBODY TURNS IT ON. The default path is unchanged:
 * your own wallet builds and confirms every swap. This is the other path, for
 * people who want the tap on an amount to be the whole trade.
 *
 * TWO ACCOUNTS, AND THEY ARE NOT EQUALLY SAFE
 *
 * There is one trading account per chain family, and the difference between
 * them is not a detail — it is the whole security story, so it is said first:
 *
 *   SOLANA. The key is an Ed25519 CryptoKey generated non-extractable. It
 *   signs, and nothing reads it back out — not a page, not this file, not a
 *   later version of this file. An imported key is put through the same door:
 *   it goes in once, as bytes you pasted, and what is stored is a handle that
 *   cannot be exported.
 *
 *   ROBINHOOD CHAIN. The same is not available. WebCrypto in Chrome implements
 *   Ed25519 and P-256 and NOT secp256k1, Ethereum's curve; ECDSA/secp256k1 and
 *   ECDSA/K-256 both throw NotSupportedError. So that key is thirty-two bytes
 *   in IndexedDB, and the honest sentence is:
 *
 *       THIS EXTENSION CAN READ THE ROBINHOOD ACCOUNT'S KEY.
 *
 *   Not "can only sign with it". Can read it. A malicious update to this
 *   extension could take it, which is exactly how nineteen extensions became
 *   drainers in the official stores in August 2026. The interface says so where
 *   that account is created, not only here.
 *
 * The passkey escape route was checked before settling for this, not assumed
 * away: a smart account signed by a non-extractable P-256 key needs the chain
 * to verify P-256 and needs a bundler to carry the operation. Robinhood Chain
 * has both ERC-4337 EntryPoints deployed, but no P-256 precompile at 0x…0100
 * and no bundler on the public RPC. Neither half exists, so neither does the
 * option.
 *
 * WHAT IS LEFT TO STAND ON
 *
 *   - A SEPARATE ACCOUNT you fund on purpose. Your own wallet is never
 *     connected to this and never signs for it, so what a bad update or a bad
 *     tap can reach is what you put here — provided you generated the account
 *     rather than importing the key to something bigger.
 *
 *   - NO SEED PHRASE, EVER. The import takes one account's private key. A
 *     phrase is every account you will ever derive, and there is no reason for
 *     software like this to be able to hold one.
 *
 *   - CAPS, per trade and per day, checked here in the worker before anything
 *     is signed — not in the UI, where a compromised page could route around
 *     them.
 *
 *   - A WAY OUT that does not involve exporting anything: `sweepEvm` sends the
 *     balance to the wallet you connected, and the destination is that wallet
 *     rather than a field you type an address into.
 *
 * The Solana account this used to use is not deleted on upgrade. It cannot
 * trade any more, but it stays readable and sweepable — see `legacy` — because
 * shipping a version that quietly stopped showing an account somebody funded
 * would strand whatever is on it.
 */

import * as evm from "./evm.js";

const DB = "xeet", STORE = "keys";

/* --------------------------------------------------------------- base58 */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes) {
  if (!bytes.length) return "";
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (let i = 0; bytes[i] === 0 && i < bytes.length - 1; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

const b64encode = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};
function b58decode(str) {
  const map = {};
  for (let i = 0; i < B58.length; i++) map[B58[i]] = i;
  const bytes = [0];
  for (const ch of str) {
    const v = map[ch];
    if (v === undefined) throw new Error("not base58: " + str);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  /* The accumulator starts as a single zero byte to have something to carry
     into. When the numeric part is zero — every character was a "1" — that
     byte is not part of the number and has to go, or the leading-zero pass
     below returns one byte too many. */
  if (bytes.length === 1 && bytes[0] === 0) bytes.pop();
  for (let i = 0; i < str.length && str[i] === "1"; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

/* A destination typed or pasted by hand is the one input here that can send
   money to nobody. Every address on Solana is 32 bytes; anything else is a
   typo, and it stops here rather than in a transaction that cannot be undone. */
function pubkey(str) {
  const raw = b58decode(String(str || "").trim());
  if (raw.length !== 32) throw new Error("not a Solana address");
  return raw;
}

const b64decode = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/* ------------------------------------------------------------ the store */
/* IndexedDB, not chrome.storage: a CryptoKey survives structured clone and
   chrome.storage only takes JSON, which would force the key to be extractable
   to be storable at all — the exact property this design exists to avoid. */
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(rec) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve(rec);
    tx.onerror = () => reject(tx.error);
  });
}

async function get(id) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(id);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function del(id) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------- settings */
const DEFAULTS = {
  on: false,          // opt-in, and this is the opt
  perTradeUsd: 50,
  dailyUsd: 250,
  spent: 0,
  day: "",
};

const today = () => new Date().toISOString().slice(0, 10);

export async function settings() {
  const { turbo } = await chrome.storage.local.get({ turbo: null });
  const s = Object.assign({}, DEFAULTS, turbo || {});
  if (s.day !== today()) { s.day = today(); s.spent = 0; }
  return s;
}

export async function setSettings(patch) {
  const s = Object.assign(await settings(), patch || {});
  await chrome.storage.local.set({ turbo: s });
  return s;
}

/* ---------------------------------------------------------- the account */
export async function create(kind) {
  const id = kind === "svm" ? "svm" : "evm";
  const existing = await get(id);
  if (existing) return { kind: id, address: existing.address };

  if (id === "svm") {
    /* extractable: FALSE. The pair is generated inside the browser's key store
       and the private half never becomes bytes anything here can see; what is
       written to IndexedDB is a handle that only crypto.subtle.sign accepts.
       This is the property Robinhood Chain cannot have. */
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const address = b58encode(pub);
    await put({ id, key: pair.privateKey, address });
    return { kind: id, address };
  }

  const key = evm.newKey();
  const address = evm.checksum(evm.addressOf(key));
  await put({ id, key, address });
  return { kind: id, address };
}

/* The Solana account, by the name the popup used while it could not trade.
   Kept so an older popup in front of a newer worker still finds it. */
export async function legacy() {
  const rec = await get("svm");
  return rec ? { kind: "svm", address: rec.address } : null;
}

/* ---------------------------------------------------------- importing */
/* Bringing your own key.
 *
 * A generated account is still the shape to prefer, but an account you already
 * fund and already trade from is a real thing to want, and refusing it does not
 * make anybody safer — it makes them paste the key somewhere with no rules at
 * all.
 *
 * On Robinhood Chain this cannot be softened the way it could on Solana. There
 * is no non-extractable secp256k1 in the browser, so an imported key is stored
 * as bytes exactly like a generated one, and the honest statement is the same
 * for both: this extension can read the key. What it will not do is take a
 * SEED PHRASE. A phrase is every account you will ever have; this takes one
 * account's key and nothing else, and the interface says which account to give
 * it.
 *
 * Accepts what a wallet exports: 32 bytes of hex, with or without 0x. */
export async function importSecret(secret, kind) {
  if (kind === "svm") return importSvm(secret);
  const text = String(secret || "").trim();
  if (!text) throw new Error("paste a private key first");
  if (/\s/.test(text) && text.split(/\s+/).length >= 12) {
    throw new Error("that is a seed phrase — Xeet never takes one. Export a single account's private key instead.");
  }

  let raw;
  try { raw = evm.fromHex(text); } catch { throw new Error("a private key is hexadecimal; that is not"); }
  if (raw.length !== 32) {
    raw.fill(0);
    throw new Error(`an Ethereum private key is 32 bytes; that is ${raw.length}`);
  }

  let address;
  try {
    address = evm.checksum(evm.addressOf(raw));
  } catch {
    raw.fill(0);
    throw new Error("that is not a valid private key for this curve");
  }

  await put({ id: "evm", key: raw, address, imported: true });
  return { kind: "evm", address, imported: true };
}

/* A Solana key you already have.
 *
 * Wallets export this as base58 — 64 bytes, the seed followed by the public
 * key — and some tools as a JSON array of the same 64 numbers. Both are taken,
 * and so is a bare 32-byte seed.
 *
 * The bytes go in once and are not kept. They are wrapped in the eight-byte
 * PKCS#8 preamble WebCrypto wants, imported ONCE as extractable purely to read
 * the public half back out (that is the address, and deriving it any other way
 * would mean shipping an Ed25519 implementation to do what the browser already
 * did), then imported again with extractable FALSE — and only that second
 * handle is stored. After this function returns, this extension can sign with
 * the account and cannot read it. */
const PKCS8_ED25519 = Uint8Array.from(
  [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

async function importSvm(secret) {
  const text = String(secret || "").trim();
  if (!text) throw new Error("paste a private key first");
  if (/\s/.test(text) && text.split(/\s+/).length >= 12 && !text.startsWith("[")) {
    throw new Error("that is a seed phrase — Xeet never takes one. Export a single account's private key instead.");
  }

  let raw;
  if (text.startsWith("[")) {
    let arr;
    try { arr = JSON.parse(text); } catch { throw new Error("that looks like an array but does not parse"); }
    if (!Array.isArray(arr) || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error("a key array is whole numbers from 0 to 255");
    }
    raw = Uint8Array.from(arr);
  } else {
    try { raw = b58decode(text); } catch { throw new Error("a Solana private key is base58; that is not"); }
  }

  if (raw.length !== 64 && raw.length !== 32) {
    raw.fill(0);
    throw new Error(`a Solana private key is 64 bytes (or a 32-byte seed); that is ${raw.length}`);
  }

  const seed = raw.slice(0, 32);
  const pkcs8 = new Uint8Array(PKCS8_ED25519.length + 32);
  pkcs8.set(PKCS8_ED25519, 0);
  pkcs8.set(seed, PKCS8_ED25519.length);

  let peek;
  try {
    peek = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  } catch {
    raw.fill(0); seed.fill(0); pkcs8.fill(0);
    throw new Error("that is not a valid Ed25519 private key");
  }
  const jwk = await crypto.subtle.exportKey("jwk", peek);
  const pub = b64urlDecode(jwk.x);

  /* When the export carried a public key of its own, it has to be the one this
     seed actually produces — otherwise the address on screen would not be the
     account that signs. */
  if (raw.length === 64) {
    const claimed = raw.slice(32);
    const same = pub.length === claimed.length && pub.every((b, i) => b === claimed[i]);
    if (!same) {
      raw.fill(0); seed.fill(0); pkcs8.fill(0);
      throw new Error("that key's two halves do not match — re-export it from your wallet");
    }
  }

  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  raw.fill(0); seed.fill(0); pkcs8.fill(0);

  const address = b58encode(pub);
  await put({ id: "svm", key, address, imported: true });
  return { kind: "svm", address, imported: true };
}

function b64urlDecode(s) {
  const pad = String(s).replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(pad + "=".repeat((4 - pad.length % 4) % 4));
}

/* The Hyperliquid agent key.
 *
 * Kept next to the trading accounts because it is the same kind of object: a
 * key this extension holds. It is a weaker one on purpose — an agent may
 * place and cancel orders and may not move a cent out of the account, so the
 * worst case here is unwanted trades, not a drained balance. */
export async function agent() {
  const rec = await get("hlagent");
  return rec ? { address: rec.address, key: rec.key } : null;
}

export async function makeAgent() {
  const existing = await get("hlagent");
  if (existing) return { address: existing.address };
  const { newAgentKey, addressOfKey } = await import("./perps.js");
  const key = newAgentKey();
  const address = addressOfKey(key);
  await put({ id: "hlagent", key, address });
  return { address };
}

export async function dropAgent() {
  await del("hlagent");
  return true;
}

export async function wipe(kind) {
  await del(kind || "svm");
  return true;
}

export async function account(kind) {
  const rec = await get(kind || "evm");
  return rec ? { kind: kind || "evm", address: rec.address, imported: !!rec.imported } : null;
}

const ID_FOR_CHAIN = { robinhood: "evm", solana: "svm" };

/* Is this trade allowed to go through without a wallet prompt? Answered in
   the worker, never in the page: a cap a compromised timeline could edit is
   not a cap. */
export async function allow(chainKey, usd, opts) {
  const s = await settings();
  if (!s.on) return { ok: false, why: "one-click is off" };
  /* One family per chain, and the account has to be the one that can sign
     there: a Solana trade signed by the Robinhood key is not a worse trade,
     it is not a trade at all. */
  const id = ID_FOR_CHAIN[chainKey];
  if (!id) return { ok: false, why: "one-click runs on Robinhood Chain and Solana" };
  const acc = await account(id);
  if (!acc) {
    return { ok: false, why: id === "svm" ? "no Solana trading account yet" : "no trading account yet" };
  }

  /* Selling is not spending. The caps exist to bound how much of your money
     can leave without you being asked; a sale moves the account TOWARDS cash
     and cannot be the thing you need protecting from. Capping it would only
     mean a position too large to sell in one tap — the account holding money
     it cannot get out of, which is the trap, not the safeguard. */
  if (opts && opts.sell) return { ok: true, account: acc, settings: s };

  const v = Number(usd);
  if (!Number.isFinite(v) || v <= 0) return { ok: false, why: "cannot price this trade" };
  if (v > s.perTradeUsd) return { ok: false, why: `over the ${s.perTradeUsd}$ per-trade cap` };
  if (s.spent + v > s.dailyUsd) return { ok: false, why: `over the ${s.dailyUsd}$ daily cap` };
  return { ok: true, account: acc, settings: s };
}

async function spend(usd) {
  const s = await settings();
  s.spent = Math.round((s.spent + Number(usd || 0)) * 100) / 100;
  await chrome.storage.local.set({ turbo: s });
  return s;
}

/* ------------------------------------------------------------- signing */
/* A Solana transaction is [compact-u16 sig count][64-byte sigs…][message].
   Jupiter returns it with the slots zeroed; this fills slot 0 and hands back
   the wire format. The same arithmetic web3.js does, without shipping
   web3.js to do it. */
function split(txBytes) {
  let i = 0, count = 0, shift = 0;
  for (;;) {
    const b = txBytes[i++];
    count |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new Error("malformed transaction");
  }
  const msgStart = i + count * 64;
  if (msgStart > txBytes.length) throw new Error("malformed transaction");
  return { header: txBytes.slice(0, i), count, sigStart: i, message: txBytes.slice(msgStart) };
}

export async function signAndSend(base64Tx, rpc, usd) {
  const rec = await get("svm");
  if (!rec) throw new Error("no trading account");

  const bytes = b64decode(base64Tx);
  const { count, sigStart, message } = split(bytes);
  if (!count) throw new Error("transaction expects no signature");

  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, rec.key, message));
  if (sig.length !== 64) throw new Error("bad signature length");
  const signed = new Uint8Array(bytes);
  signed.set(sig, sigStart);

  const body = {
    jsonrpc: "2.0", id: 1, method: "sendTransaction",
    params: [b64encode(signed), { encoding: "base64", skipPreflight: false, maxRetries: 3 }],
  };
  const r = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const out = await r.json();
  if (out.error) throw new Error(out.error.message || "the network rejected it");
  await spend(usd);
  return { hash: out.result };
}

/* -------------------------------------------------- signing, on Robinhood */
/* The router hands back a call — a destination, a value and a data blob. This
   turns that into a transaction the account has signed, and puts it on chain.

   Nonce and fees are asked of the node rather than carried in from the quote:
   a quote can be seconds old, and a stale nonce is a transaction that silently
   never mines. */
export async function sendCall(chain, call, usd) {
  const rec = await get("evm");
  if (!rec) throw new Error("no trading account");

  const node = evm.rpc(chain.rpc);
  const from = rec.address;
  const [nonceHex, fee] = await Promise.all([
    node("eth_getTransactionCount", [from, "pending"]),
    evm.fees(node),
  ]);

  // Ask the node what the call costs before committing to a number. A quote's
  // own gas estimate is for whoever it was quoted to.
  let gas;
  try {
    const est = await node("eth_estimateGas", [{
      from, to: call.to, value: call.value || "0x0", data: call.data || "0x",
    }]);
    gas = (BigInt(est) * 13n) / 10n;             // headroom for a moving pool
  } catch (e) {
    // estimateGas reverting is the chain saying this trade would fail. Passing
    // a guess instead would spend the gas to find that out on chain.
    throw new Error(readable(e.message));
  }

  const { raw, hash } = await evm.signTx(rec.key, {
    chainId: chain.id,
    nonce: parseInt(nonceHex, 16),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    maxFeePerGas: fee.maxFeePerGas,
    gas,
    to: call.to,
    value: BigInt(call.value || 0),
    data: call.data || "0x",
  });
  await node("eth_sendRawTransaction", [raw]);
  if (usd) await spend(usd);
  return { hash };
}

/* Node errors are written for nodes. */
function readable(msg) {
  const m = String(msg || "");
  if (/insufficient funds/i.test(m)) return "the trading account cannot cover this trade and its gas";
  if (/nonce/i.test(m)) return "a previous trade from this account is still pending";
  if (/execution reverted|always failing/i.test(m)) return "the route would fail — try a smaller size or more slippage";
  if (/gas required exceeds/i.test(m)) return "the trade needs more gas than the chain allows in one transaction";
  return m;
}

/* Selling an ERC-20 means letting the router move it first. This is a second
   transaction and the account pays for it, so it is only sent when the
   allowance is actually short. */
export async function ensureAllowance(chain, token, spender, amount) {
  const rec = await get("evm");
  if (!rec) throw new Error("no trading account");
  const node = evm.rpc(chain.rpc);
  const have = BigInt(await node("eth_call", [
    { to: token, data: evm.encodeAllowance(rec.address, spender) }, "latest",
  ]));
  if (have >= BigInt(amount)) return { already: true };
  const MAX = (1n << 256n) - 1n;
  const sent = await sendCall(chain, {
    to: token, value: "0x0", data: evm.encodeApprove(spender, MAX),
  }, 0);
  return { already: false, hash: sent.hash };
}

/* What the account is holding of the coin that pays for gas. */
export async function nativeBalance(chain) {
  const rec = await get("evm");
  if (!rec) throw new Error("no trading account");
  const wei = BigInt(await evm.rpc(chain.rpc)("eth_getBalance", [rec.address, "latest"]));
  return { address: rec.address, wei: wei.toString(), amount: Number(wei) / 1e18 };
}

/* The way home. Everything the account holds of the native coin, less what the
   one transfer costs — computed from the fee the chain quotes right now, not
   from a constant, because a fee guessed low leaves the transaction unmined
   and a fee guessed high leaves money behind. */
export async function sweepEvm(chain, toAddress) {
  const rec = await get("evm");
  if (!rec) throw new Error("no trading account");
  const to = String(toAddress || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("that is not an Ethereum address");

  const node = evm.rpc(chain.rpc);
  const [balHex, nonceHex, fee] = await Promise.all([
    node("eth_getBalance", [rec.address, "latest"]),
    node("eth_getTransactionCount", [rec.address, "pending"]),
    evm.fees(node),
  ]);
  const balance = BigInt(balHex);
  const gas = 21000n;
  const cost = fee.maxFeePerGas * gas;
  if (balance <= cost) throw new Error("nothing to send once gas is paid for");

  const value = balance - cost;
  const { raw, hash } = await evm.signTx(rec.key, {
    chainId: chain.id, nonce: parseInt(nonceHex, 16),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas, maxFeePerGas: fee.maxFeePerGas,
    gas: Number(gas), to, value, data: "0x",
  });
  await node("eth_sendRawTransaction", [raw]);
  return { hash, wei: value.toString(), amount: Number(value) / 1e18 };
}

/* --------------------------------------------------------------- sweep */
/* The way out. A non-extractable key cannot be backed up, so the account has
   to be emptiable in one action or the design is a trap. */
export async function sweepPlan(rpc) {
  const acc = await account("svm");
  if (!acc) throw new Error("no trading account");
  const r = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [acc.address] }),
  }).then((x) => x.json());
  const lamports = (r.result && r.result.value) || 0;
  return { address: acc.address, lamports, sol: lamports / 1e9 };
}


/* ------------------------------------------------------- the way home */
/* A transfer, built by hand.
 *
 * Everything else in this file hands Jupiter's finished transaction to the
 * signer. A withdrawal has no router to build it, so the message is assembled
 * here — and it is the one transaction in the product whose contents are
 * entirely ours, which is the argument for it being short enough to read in
 * one sitting.
 *
 * Legacy message layout:
 *   u8  signatures required
 *   u8  read-only signed accounts
 *   u8  read-only unsigned accounts
 *   compact-u16 + 32 bytes each   account keys
 *   32 bytes                      recent blockhash
 *   compact-u16                   instructions, each:
 *     u8 program index, compact-u16 account indices, compact-u16 data
 */
function shortvec(n) {
  const out = [];
  for (;;) {
    if (n < 0x80) { out.push(n); break; }
    out.push((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return out;
}

const SYSTEM_PROGRAM = new Uint8Array(32); // "111…1" is thirty-two zero bytes
const SIGNATURE_FEE = 5000;                // lamports, one signature

function transferMessage(fromPub, toPub, lamports, blockhash) {
  const data = [2, 0, 0, 0];               // SystemInstruction::Transfer
  let v = BigInt(lamports);
  for (let i = 0; i < 8; i++) { data.push(Number(v & 0xffn)); v >>= 8n; }

  const parts = [
    [1, 0, 1],                             // 1 signer, 0 readonly signed, 1 readonly unsigned
    shortvec(3), [...fromPub], [...toPub], [...SYSTEM_PROGRAM],
    [...pubkey(blockhash)],                // a blockhash is 32 bytes too
    shortvec(1),
    [2],                                   // program is accountKeys[2]
    shortvec(2), [0, 1],                   // from, to
    shortvec(data.length), data,
  ];
  return new Uint8Array(parts.flat());
}

/* Send the account's SOL to an address you name, and return the signature.
   The fee for the one signature stays behind; everything else goes. */
export async function sweep(rpc, toAddress) {
  const rec = await get("svm");
  if (!rec) throw new Error("no trading account");
  if (!toAddress) throw new Error("no destination");
  const to = pubkey(toAddress);

  const call = async (method, params) => {
    const r = await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error.message || method + " failed");
    return r.result;
  };

  const bal = await call("getBalance", [rec.address, { commitment: "confirmed" }]);
  const lamports = ((bal && bal.value) || 0) - SIGNATURE_FEE;
  if (lamports <= 0) throw new Error("nothing to send — the account is empty");

  const { blockhash } = (await call("getLatestBlockhash", [{ commitment: "finalized" }])).value;
  const message = transferMessage(rec.pub, to, lamports, blockhash);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, rec.key, message));

  const tx = new Uint8Array(1 + 64 + message.length);
  tx[0] = 1;
  tx.set(sig, 1);
  tx.set(message, 65);

  const hash = await call("sendTransaction",
    [b64encode(tx), { encoding: "base64", skipPreflight: false, maxRetries: 3 }]);
  return { hash, lamports, sol: lamports / 1e9 };
}
