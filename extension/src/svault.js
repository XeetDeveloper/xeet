/* Xeet — the Solana vault, from the extension.
 *
 * The same venue the panel's PERPS face trades against for coins no exchange
 * will list, spoken to from here: derived addresses, Anchor's instruction
 * naming, the transaction format, and the ed25519 attestation the program
 * insists on. No npm and no bundler, like everything else in this extension,
 * so base58, sha256 and the curve check are written out.
 *
 * The margin is USDC from the trading account and it goes to the contract.
 * Nothing about a position is held by us, and the price is signed by the
 * operator service rather than by anything in this file.
 */

/* ------------------------------------------------------------- base58 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

export function unb58(s) {
  let n = 0n;
  for (const c of String(s)) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("not base58: " + s);
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of String(s)) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------- sha256 */
/* Synchronous on purpose: deriving one address hashes up to 255 times, and
   awaiting WebCrypto that many times for every account on every panel open is
   a visible pause. FIPS 180-4, written out. */

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(...parts) {
  const msg = cat(...parts);
  const len = msg.length;
  const withPad = new Uint8Array((((len + 9) >> 6) + 1) << 6);
  withPad.set(msg);
  withPad[len] = 0x80;
  new DataView(withPad.buffer).setUint32(withPad.length - 4, len << 3, false);

  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const view = new DataView(withPad.buffer);
  const rr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let i = 0; i < withPad.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, h[0], false);
  for (let i = 0; i < 8; i++) new DataView(out.buffer).setUint32(i * 4, h[i], false);
  return out;
}

/* ------------------------------------------------- derived addresses */
/* A program-derived address is the hash that is NOT a point on ed25519 — so
   no private key can exist for it. Decompression per RFC 8032. */

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modpow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

export function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;

  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  if (v === 0n) return false;

  const uv3 = (u * modpow(v, 3n, P)) % P;
  const uv7 = (u * modpow(v, 7n, P)) % P;
  let x = (uv3 * modpow(uv7, (P - 5n) / 8n, P)) % P;

  const check = (((v * x) % P) * x) % P;
  if (check === u % P) { /* already the root */ }
  else if (check === (P - (u % P)) % P) x = (x * modpow(2n, (P - 1n) / 4n, P)) % P;
  else return false;

  return !(x === 0n && sign === 1n);
}

const MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export function pda(seeds, programId) {
  const pid = unb58(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(...seeds, Uint8Array.of(bump), pid, MARKER);
    if (!onCurve(hash)) return hash;
  }
  throw new Error("no derived address for these seeds");
}

/* ---------------------------------------------------------- encoding */

export function cat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

const text = (s) => new TextEncoder().encode(s);
export const u8 = (n) => Uint8Array.of(Number(n) & 0xff);
export const bool = (b) => Uint8Array.of(b ? 1 : 0);
export const u16le = (n) => { const o = new Uint8Array(2); new DataView(o.buffer).setUint16(0, Number(n), true); return o; };
export const u32le = (n) => { const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, Number(n), true); return o; };
export const u64le = (n) => { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, BigInt(n), true); return o; };
export const i64le = (n) => { const o = new Uint8Array(8); new DataView(o.buffer).setBigInt64(0, BigInt(n), true); return o; };
export const u128le = (n) => {
  const o = new Uint8Array(16);
  let v = BigInt(n);
  for (let i = 0; i < 16; i++) { o[i] = Number(v & 0xffn); v >>= 8n; }
  return o;
};

/* Anchor names an instruction by the first eight bytes of this hash. */
export const disc = (name) => sha256(text("global:" + name)).slice(0, 8);

function shortvec(n) {
  const out = [];
  let v = Number(n);
  for (;;) {
    if (v < 0x80) { out.push(v); break; }
    out.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return Uint8Array.from(out);
}

/* ---------------------------------------------------- the program ids */

export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ED25519 = "Ed25519SigVerify111111111111111111111111111";
export const SYSVAR_IX = "Sysvar1nstructions1111111111111111111111111";

const ro = (pubkey) => ({ pubkey, signer: false, writable: false });
const rw = (pubkey) => ({ pubkey, signer: false, writable: true });
const me = (pubkey) => ({ pubkey, signer: true, writable: true });

export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/* The associated token account — where a wallet's USDC actually lives. */
export const ata = (owner, mint) =>
  b58(pda([unb58(owner), unb58(TOKEN), unb58(mint)], ATA_PROGRAM));

export const addresses = (program) => ({
  vault: b58(pda([text("vault")], program)),
  treasury: b58(pda([text("treasury")], program)),
  market: (mint) => b58(pda([text("market"), unb58(mint)], program)),
  position: (id) => b58(pda([text("position"), u64le(id)], program)),
});

/* --------------------------------------------------- the instructions */

export const ed25519Ix = (pubkeyHex, signatureHex, messageHex) => {
  const hex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
  const pub = hex(pubkeyHex);
  const sig = hex(signatureHex);
  const msg = hex(messageHex);
  const keyOff = 16, sigOff = keyOff + 32, msgOff = sigOff + 64, here = 0xffff;
  return {
    programId: ED25519,
    keys: [],
    data: cat(
      u8(1), u8(0),
      u16le(sigOff), u16le(here), u16le(keyOff), u16le(here),
      u16le(msgOff), u16le(msg.length), u16le(here),
      pub, sig, msg,
    ),
  };
};

export const openIx = ({ program, trader, vault, market, position, from, treasury, mint,
  id, token, margin, leverage, isLong, price, at }) => ({
  programId: program,
  keys: [me(trader), rw(vault), rw(market), rw(position), rw(from), rw(treasury),
    ro(mint), ro(SYSVAR_IX), ro(TOKEN), ro(SYSTEM)],
  data: cat(disc("open"), u64le(id), unb58(token), u64le(margin),
    u8(leverage), bool(isLong), u128le(price), i64le(at)),
});

export const closeIx = ({ program, trader, vault, market, position, treasury, to, mint, price, at }) => ({
  programId: program,
  keys: [me(trader), rw(trader), rw(vault), rw(market), rw(position), rw(treasury),
    rw(to), ro(mint), ro(SYSVAR_IX), ro(TOKEN)],
  data: cat(disc("close"), u128le(price), i64le(at)),
});

export const closeStaleIx = ({ program, trader, vault, market, position, treasury, to, mint }) => ({
  programId: program,
  keys: [me(trader), rw(vault), rw(market), rw(position), rw(treasury), rw(to), ro(mint), ro(TOKEN)],
  data: disc("close_stale"),
});

/* ------------------------------------------------------ the transaction */
/* Built unsigned, with the signature slot left empty: the trading account's
   key is non-extractable and lives in the worker, so the bytes go there to be
   signed the same way a swap's do. */
export function unsignedTx(payer, instructions, blockhash) {
  const roles = new Map();
  const note = (k, signer, writable) => {
    const was = roles.get(k) || { signer: false, writable: false };
    roles.set(k, { signer: was.signer || signer, writable: was.writable || writable });
  };
  note(payer, true, true);
  for (const ix of instructions) {
    for (const a of ix.keys) note(a.pubkey, a.signer, a.writable);
    note(ix.programId, false, false);
  }

  const rank = (k) => {
    const r = roles.get(k);
    return r.signer && r.writable ? 0 : r.signer ? 1 : r.writable ? 2 : 3;
  };
  const keys = [...roles.keys()].sort((a, b) => {
    if (a === payer) return -1;
    if (b === payer) return 1;
    return rank(a) - rank(b) || (a < b ? -1 : 1);
  });

  const signers = keys.filter((k) => roles.get(k).signer);
  if (signers.length !== 1 || signers[0] !== payer) {
    throw new Error("this transaction needs a signer we do not have");
  }

  const header = Uint8Array.of(
    1,
    0,
    keys.filter((k) => !roles.get(k).signer && !roles.get(k).writable).length,
  );
  const at = new Map(keys.map((k, i) => [k, i]));
  const body = instructions.map((ix) => cat(
    u8(at.get(ix.programId)),
    shortvec(ix.keys.length),
    Uint8Array.from(ix.keys.map((a) => at.get(a.pubkey))),
    shortvec(ix.data.length),
    ix.data,
  ));

  const message = cat(
    header,
    shortvec(keys.length),
    ...keys.map((k) => unb58(k)),
    unb58(blockhash),
    shortvec(instructions.length),
    ...body,
  );
  return cat(shortvec(1), new Uint8Array(64), message);
}

/* ------------------------------------------------------------ reading */

const u64At = (b, i) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(i, true);
const i64At = (b, i) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(i, true);
const u128At = (b, i) => {
  let n = 0n;
  for (let j = 15; j >= 0; j--) n = (n << 8n) | BigInt(b[i + j]);
  return n;
};

export const readVault = (b) => ({
  owner: b58(b.slice(8, 40)),
  operator: b58(b.slice(40, 72)),
  mint: b58(b.slice(72, 104)),
  liabilities: u64At(b, 104),
  nextId: u64At(b, 112),
  openFeeBps: b[120] | (b[121] << 8),
  fundingBpsPerHour: b[122] | (b[123] << 8),
  paused: !!b[124],
});

export const readMarket = (b) => ({
  token: b58(b.slice(8, 40)),
  maxMargin: u64At(b, 40),
  maxNotional: u64At(b, 48),
  openNotional: u64At(b, 56),
  lastPriceAt: i64At(b, 64),
  maxLeverage: b[72],
  payoutMult: b[73],
  live: !!b[74],
});

export const readPosition = (b) => ({
  trader: b58(b.slice(8, 40)),
  token: b58(b.slice(40, 72)),
  margin: u64At(b, 72),
  entry: u128At(b, 80),
  openedAt: i64At(b, 96),
  id: Number(u64At(b, 104)),
  leverage: b[112],
  payoutMult: b[113],
  isLong: !!b[114],
});

export const tokenAmount = (b) => u64At(b, 64);

/* What a position is worth, in the program's own arithmetic — for showing a
   number, never for deciding one. */
export function valueOf(pos, price, fundingBpsPerHour, now) {
  const notional = pos.margin * BigInt(pos.leverage);
  let gross = (notional * (price - pos.entry)) / pos.entry;
  if (!pos.isLong) gross = -gross;
  const seconds = BigInt(Math.max(0, now - Number(pos.openedAt)));
  const funding = (notional * BigInt(fundingBpsPerHour) * seconds) / (10000n * 3600n);
  const pnl = gross - funding;
  const dead = pnl <= -((pos.margin * 9000n) / 10000n);
  let payout = 0n;
  if (!dead) {
    const net = pos.margin + pnl;
    const cap = pos.margin * BigInt(pos.payoutMult || 1);
    payout = net <= 0n ? 0n : net > cap ? cap : net;
  }
  return { pnl, payout, liquidatable: dead };
}
