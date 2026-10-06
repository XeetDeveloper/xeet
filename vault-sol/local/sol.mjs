/* A Solana client with no dependencies.
 *
 * The extension ships no bundler and no npm — every file in it is one somebody
 * has read — so the vault's client is written the same way here: base58, the
 * hash, the derived addresses, the instruction encoding and the transaction
 * itself. It is about three hundred lines, and it is the same three hundred
 * lines the extension will use, which is the point: the thing proven on a
 * local validator is the thing that runs in the panel.
 */
import crypto from "node:crypto";

/* ------------------------------------------------------------- base58 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function bs58(bytes) {
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

export function unbs58(s) {
  let n = 0n;
  for (const c of String(s)) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("bad base58: " + s);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of String(s)) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/* ------------------------------------------------- derived addresses */

/* Whether 32 bytes are a point on ed25519 — which is how a program-derived
   address is recognised: it is the hash that is NOT a point, so no private
   key can ever exist for it. Decompression per RFC 8032, written out because
   there is nothing else here to borrow it from. */
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

const modpow = (b, e, m) => {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
};

export function isOnCurve(bytes) {
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
  if (check === u % P) {
    /* already the root */
  } else if (check === (P - (u % P)) % P) {
    x = (x * modpow(2n, (P - 1n) / 4n, P)) % P;
  } else {
    return false;
  }
  if (x === 0n && sign === 1n) return false;
  return true;
}

const sha256 = (...parts) => {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(Buffer.from(p));
  return new Uint8Array(h.digest());
};

const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

export function findPda(seeds, programId) {
  const pid = unbs58(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(...seeds, Uint8Array.of(bump), pid, PDA_MARKER);
    if (!isOnCurve(hash)) return [bs58(hash), bump];
  }
  throw new Error("no derived address for these seeds");
}

/* An Anchor instruction is named by the first eight bytes of this hash. */
export const discriminator = (name) => sha256(Buffer.from("global:" + name)).slice(0, 8);

/* ---------------------------------------------------------- encoding */

export const u8 = (n) => Uint8Array.of(Number(n) & 0xff);
export const bool = (b) => Uint8Array.of(b ? 1 : 0);
export const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(n)); return b; };
export const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); return b; };
export const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const i64le = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
export const u128le = (n) => {
  const b = Buffer.alloc(16);
  let v = BigInt(n);
  for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};
export const key = (k) => unbs58(k);
export const option = (v, enc) => (v === null || v === undefined
  ? Uint8Array.of(0)
  : Buffer.concat([Uint8Array.of(1), enc(v)]));

export const cat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

/* Solana's own compact-u16: seven bits at a time, high bit says "more". */
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

/* ------------------------------------------------------ transactions */

export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ED25519 = "Ed25519SigVerify111111111111111111111111111";
export const SYSVAR_IX = "Sysvar1nstructions1111111111111111111111111";
export const RENT = "SysvarRent111111111111111111111111111111111";

/* Build a legacy message. The account list is the fiddly part: signers first,
   then writable, then read-only, each account appearing exactly once with the
   strongest role anything asked of it. */
export function message(payer, instructions, blockhash) {
  const roles = new Map();
  const note = (pubkey, signer, writable) => {
    const was = roles.get(pubkey) || { signer: false, writable: false };
    roles.set(pubkey, { signer: was.signer || signer, writable: was.writable || writable });
  };

  note(payer, true, true);
  for (const ix of instructions) {
    for (const a of ix.keys) note(a.pubkey, !!a.isSigner, !!a.isWritable);
    note(ix.programId, false, false);
  }

  const rank = (k) => {
    const r = roles.get(k);
    if (r.signer && r.writable) return 0;
    if (r.signer) return 1;
    if (r.writable) return 2;
    return 3;
  };
  const keys = [...roles.keys()].sort((a, b) => {
    if (a === payer) return -1;
    if (b === payer) return 1;
    return rank(a) - rank(b) || (a < b ? -1 : 1);
  });

  const signers = keys.filter((k) => roles.get(k).signer);
  const header = Uint8Array.of(
    signers.length,
    signers.filter((k) => !roles.get(k).writable).length,
    keys.filter((k) => !roles.get(k).signer && !roles.get(k).writable).length,
  );

  const index = new Map(keys.map((k, i) => [k, i]));
  const body = instructions.map((ix) => cat(
    u8(index.get(ix.programId)),
    shortvec(ix.keys.length),
    Uint8Array.from(ix.keys.map((a) => index.get(a.pubkey))),
    shortvec(ix.data.length),
    ix.data,
  ));

  return {
    keys,
    signers,
    bytes: cat(
      header,
      shortvec(keys.length),
      ...keys.map((k) => unbs58(k)),
      unbs58(blockhash),
      shortvec(instructions.length),
      ...body,
    ),
  };
}

/* An ed25519 secret as node's crypto wants it: the eleven bytes of PKCS8 that
   a raw seed needs, and nothing more. */
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

export function keypairFromSeed(seed) {
  const bytes = Buffer.from(seed).subarray(0, 32);
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8, bytes]), format: "der", type: "pkcs8",
  });
  const pub = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
  return { priv, pubkey: bs58(pub), seed: bytes };
}

export const newKeypair = () => keypairFromSeed(crypto.randomBytes(32));

export function sign(msg, keypairs) {
  const sigs = msg.signers.map((who) => {
    const kp = keypairs.find((k) => k.pubkey === who);
    if (!kp) throw new Error("no key for signer " + who);
    return crypto.sign(null, msg.bytes, kp.priv);
  });
  return cat(shortvec(sigs.length), ...sigs, msg.bytes).toString("base64");
}

/* ------------------------------------------------------------- the rpc */

export function rpc(url) {
  let id = 0;
  return async function call(method, params = []) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = await r.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

export async function send(call, instructions, payer, signers) {
  const { blockhash } = (await call("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  const msg = message(payer, instructions, blockhash);
  const tx = sign(msg, signers);
  const sig = await call("sendTransaction", [tx, { encoding: "base64", preflightCommitment: "confirmed" }]);
  for (let i = 0; i < 60; i++) {
    const st = (await call("getSignatureStatuses", [[sig]])).value[0];
    if (st && st.err) throw new Error("transaction failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("transaction did not confirm");
}

export async function account(call, pubkey) {
  const r = await call("getAccountInfo", [pubkey, { encoding: "base64", commitment: "confirmed" }]);
  if (!r || !r.value) return null;
  return { ...r.value, bytes: Buffer.from(r.value.data[0], "base64") };
}

/* --------------------------------------------------------- spl token */

export const tokenBalance = (bytes) => bytes.readBigUInt64LE(64);

export function createMintIxs(payer, mint, authority, decimals, rentLamports) {
  return [
    {
      programId: SYSTEM,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: true, isWritable: true },
      ],
      data: cat(u32le(0), u64le(rentLamports), u64le(82), key(TOKEN)),
    },
    {
      programId: TOKEN,
      keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
      data: cat(u8(20), u8(decimals), key(authority), u8(0)),   // InitializeMint2
    },
  ];
}

export function createTokenAccountIxs(payer, acc, mint, owner, rentLamports) {
  return [
    {
      programId: SYSTEM,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: acc, isSigner: true, isWritable: true },
      ],
      data: cat(u32le(0), u64le(rentLamports), u64le(165), key(TOKEN)),
    },
    {
      programId: TOKEN,
      keys: [
        { pubkey: acc, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
      ],
      data: cat(u8(18), key(owner)),                            // InitializeAccount3
    },
  ];
}

export const mintToIx = (mint, to, authority, amount) => ({
  programId: TOKEN,
  keys: [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: to, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ],
  data: cat(u8(7), u64le(amount)),                              // MintTo
});

/* The ed25519 precompile instruction: one signature, everything inside this
   instruction's own data. The vault program reads this exact layout. */
export function ed25519Ix(pubkeyHex, signatureHex, messageHex) {
  const pub = Buffer.from(pubkeyHex, "hex");
  const sig = Buffer.from(signatureHex, "hex");
  const msg = Buffer.from(messageHex, "hex");
  const keyOff = 16;
  const sigOff = keyOff + 32;
  const msgOff = sigOff + 64;
  const here = 0xffff;
  return {
    programId: ED25519,
    keys: [],
    data: cat(
      u8(1), u8(0),
      u16le(sigOff), u16le(here),
      u16le(keyOff), u16le(here),
      u16le(msgOff), u16le(msg.length), u16le(here),
      pub, sig, msg,
    ),
  };
}
