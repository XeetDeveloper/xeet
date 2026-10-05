/* Xeet — Ethereum transaction machinery for one-click trading.
 *
 * Only what a trading account needs: an address from a key, RLP, and a signed
 * EIP-1559 transaction. No provider, no ABI layer, no wallet — those come from
 * the wallet the user connects, and none of them belong in the worker.
 *
 * Everything here was checked against something outside itself before it was
 * trusted, because a transaction is not a thing you find out is wrong later:
 *
 *   - RLP against the specification's own vectors ("dog", nested lists, the
 *     55-byte boundary, zero, 1024).
 *   - Addresses against the published ones for private keys 1, 2 and 3.
 *   - keccak256("") against its canonical digest.
 *   - A whole signed transaction against Robinhood Chain itself, which parsed
 *     it, recovered the sender, and refused it only for having no funds.
 *
 * That last one caught a bug the others could not. @noble/secp256k1 puts the
 * recovery byte FIRST in its 65-byte "recovered" signature; taking it off the
 * end instead shifts r and s by a byte, and the result still recovers to the
 * right key when the library is handed the whole blob back. Only a node
 * rejecting it says otherwise. Hence Signature.fromBytes below, and hence no
 * hand-slicing of signature bytes anywhere in this file.
 */
import * as secp from "../vendor/secp256k1.js";
import { keccak_256 } from "../vendor/sha3.js";

/* ------------------------------------------------------------------ bytes */
export const toHex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(s) {
  const h = String(s).replace(/^0x/i, "");
  if (!h) return new Uint8Array(0);
  if (!/^[0-9a-f]*$/i.test(h)) throw new Error("not hexadecimal");
  const even = h.length % 2 ? "0" + h : h;
  return Uint8Array.from(even.match(/../g).map((p) => parseInt(p, 16)));
}

function minimal(n) {
  if (n <= 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return Uint8Array.from(h.match(/../g).map((p) => parseInt(p, 16)));
}

function concat(list) {
  const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
  let i = 0;
  for (const b of list) { out.set(b, i); i += b.length; }
  return out;
}

/* -------------------------------------------------------------------- RLP */
/* Integers carry no leading zeros and zero is the empty string — that is not
   a style choice, it is what makes an encoding canonical, and a node rejects
   anything else. */
export function rlp(x) {
  if (Array.isArray(x)) {
    const body = concat(x.map(rlp));
    return concat([header(body.length, 0xc0), body]);
  }
  const b = asBytes(x);
  if (b.length === 1 && b[0] < 0x80) return b;
  return concat([header(b.length, 0x80), b]);
}

function header(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const l = minimal(BigInt(len));
  return concat([Uint8Array.of(offset + 55 + l.length), l]);
}

function asBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (typeof x === "bigint") return minimal(x);
  if (typeof x === "number") return minimal(BigInt(x));
  if (typeof x === "string") return x.startsWith("0x") ? fromHex(x) : new TextEncoder().encode(x);
  if (x === null || x === undefined) return new Uint8Array(0);
  throw new Error("cannot encode " + typeof x);
}

/* ------------------------------------------------------------------- keys */
export function addressOf(priv) {
  // An address is the last twenty bytes of the keccak of the public key with
  // its 0x04 prefix removed.
  return toHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(-20));
}

export const newKey = () => secp.utils.randomSecretKey();

/* EIP-55: the mixed case that lets a wallet notice a mistyped address. */
export function checksum(addr) {
  const lower = addr.replace(/^0x/, "").toLowerCase();
  const hash = toHex(keccak_256(new TextEncoder().encode(lower))).slice(2);
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/* --------------------------------------------------------- transactions */
export async function signTx(priv, t) {
  const fields = [
    t.chainId,
    t.nonce,
    t.maxPriorityFeePerGas,
    t.maxFeePerGas,
    t.gas,
    t.to || "0x",
    t.value || 0n,
    t.data || "0x",
    [],                               // no access list
  ];
  const digest = keccak_256(new Uint8Array([2, ...rlp(fields)]));
  const packed = await secp.signAsync(digest, priv, { prehash: false, format: "recovered" });
  const sig = secp.Signature.fromBytes(packed, "recovered");
  const signed = new Uint8Array([2, ...rlp([...fields, sig.recovery, sig.r, sig.s])]);
  return { raw: toHex(signed), hash: toHex(keccak_256(signed)) };
}

/* --------------------------------------------------------------- the node */
export function rpc(url) {
  let id = 0;
  return async function call(method, params) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params || [] }),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error.message || method + " failed");
    return r.result;
  };
}

/* What a transaction costs to send, asked of the chain rather than guessed.
   The tip is padded because a fee that was right when quoted and wrong when
   mined is a transaction that sits unmined, which reads as the button being
   broken. */
export async function fees(call) {
  const [base, tip] = await Promise.all([
    call("eth_gasPrice", []),
    call("eth_maxPriorityFeePerGas", []).catch(() => null),
  ]);
  const gasPrice = BigInt(base);
  const priority = tip ? BigInt(tip) : gasPrice / 10n;
  return {
    maxPriorityFeePerGas: priority,
    maxFeePerGas: gasPrice * 2n + priority,
  };
}

/* ERC-20 calls the account has to make for itself. Two selectors, hand-encoded
   — pulling in an ABI coder to build eighty bytes would be the larger risk. */
const SELECTOR = {
  approve: "095ea7b3",
  allowance: "dd62ed3e",
  balanceOf: "70a08231",
};

const word = (v) => {
  const b = typeof v === "string" ? fromHex(v) : minimal(BigInt(v));
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return [...out].map((x) => x.toString(16).padStart(2, "0")).join("");
};

export const encodeApprove = (spender, amount) =>
  "0x" + SELECTOR.approve + word(spender) + word(amount);

export const encodeAllowance = (owner, spender) =>
  "0x" + SELECTOR.allowance + word(owner) + word(spender);

export const encodeBalanceOf = (owner) => "0x" + SELECTOR.balanceOf + word(owner);
