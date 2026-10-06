/* The vault's instructions, as the client builds them.
 *
 * Anchor names an instruction by the first eight bytes of sha256("global:" +
 * name) and lays its arguments out in declaration order; the account list is
 * the order of the fields in the #[derive(Accounts)] struct. Both are written
 * out here against programs/vault-sol/src, and the local run is what proves
 * they are right. */
import * as s from "./sol.mjs";

export const PROGRAM = "EHwwa3q9WQd3s5NzWvUZjk83zuCyApDbXep6DPEjyMzx";

export const pdas = (program = PROGRAM) => ({
  vault: s.findPda([Buffer.from("vault")], program)[0],
  treasury: s.findPda([Buffer.from("treasury")], program)[0],
  market: (mint) => s.findPda([Buffer.from("market"), s.unbs58(mint)], program)[0],
  position: (id) => s.findPda([Buffer.from("position"), s.u64le(id)], program)[0],
});

const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey, writable = true) => ({ pubkey, isSigner: true, isWritable: writable });

export const initialize = ({ program = PROGRAM, owner, vault, mint, treasury, operator, openFeeBps, fundingBps }) => ({
  programId: program,
  keys: [signer(owner), rw(vault), ro(mint), rw(treasury), ro(s.TOKEN), ro(s.SYSTEM)],
  data: s.cat(s.discriminator("initialize"), s.key(operator), s.u16le(openFeeBps), s.u16le(fundingBps)),
});

export const fund = ({ program = PROGRAM, funder, vault, treasury, from, mint, amount }) => ({
  programId: program,
  keys: [signer(funder), ro(vault), rw(treasury), rw(from), ro(mint), ro(s.TOKEN)],
  data: s.cat(s.discriminator("fund"), s.u64le(amount)),
});

export const defund = ({ program = PROGRAM, owner, vault, treasury, to, mint, amount }) => ({
  programId: program,
  keys: [signer(owner, false), ro(vault), rw(treasury), rw(to), ro(mint), ro(s.TOKEN)],
  data: s.cat(s.discriminator("defund"), s.u64le(amount)),
});

export const setMarket = ({ program = PROGRAM, owner, vault, market, token, maxMargin, maxNotional, maxLeverage, live }) => ({
  programId: program,
  keys: [signer(owner), ro(vault), rw(market), ro(s.SYSTEM)],
  data: s.cat(
    s.discriminator("set_market"), s.key(token), s.u64le(maxMargin), s.u64le(maxNotional),
    s.u8(maxLeverage), s.bool(live),
  ),
});

export const open = ({ program = PROGRAM, trader, vault, market, position, from, treasury, mint,
  id, token, margin, leverage, isLong, price, at }) => ({
  programId: program,
  keys: [
    signer(trader), rw(vault), rw(market), rw(position), rw(from), rw(treasury),
    ro(mint), ro(s.SYSVAR_IX), ro(s.TOKEN), ro(s.SYSTEM),
  ],
  data: s.cat(
    s.discriminator("open"), s.u64le(id), s.key(token), s.u64le(margin),
    s.u8(leverage), s.bool(isLong), s.u128le(price), s.i64le(at),
  ),
});

const settle = (name) => ({ program = PROGRAM, caller, trader, vault, market, position, treasury, to, mint, price, at }) => ({
  programId: program,
  keys: [
    signer(caller), rw(trader), rw(vault), rw(market), rw(position), rw(treasury),
    rw(to), ro(mint), ro(s.SYSVAR_IX), ro(s.TOKEN),
  ],
  data: s.cat(s.discriminator(name), s.u128le(price), s.i64le(at)),
});

export const close = settle("close");
export const liquidate = settle("liquidate");

export const closeStale = ({ program = PROGRAM, trader, vault, market, position, treasury, to, mint }) => ({
  programId: program,
  keys: [signer(trader), rw(vault), rw(market), rw(position), rw(treasury), rw(to), ro(mint), ro(s.TOKEN)],
  data: s.cat(s.discriminator("close_stale")),
});

/* ------------------------------------------------------------ reading */

export const readVault = (b) => ({
  owner: s.bs58(b.subarray(8, 40)),
  operator: s.bs58(b.subarray(40, 72)),
  mint: s.bs58(b.subarray(72, 104)),
  liabilities: b.readBigUInt64LE(104),
  nextId: b.readBigUInt64LE(112),
  openFeeBps: b.readUInt16LE(120),
  fundingBpsPerHour: b.readUInt16LE(122),
  paused: !!b[124],
});

export const readMarket = (b) => ({
  token: s.bs58(b.subarray(8, 40)),
  maxMargin: b.readBigUInt64LE(40),
  maxNotional: b.readBigUInt64LE(48),
  openNotional: b.readBigUInt64LE(56),
  lastPriceAt: b.readBigInt64LE(64),
  maxLeverage: b[72],
  live: !!b[73],
});

export const readPosition = (b) => ({
  trader: s.bs58(b.subarray(8, 40)),
  token: s.bs58(b.subarray(40, 72)),
  margin: b.readBigUInt64LE(72),
  entry: b.subarray(80, 96).reduce((n, byte, i) => n + (BigInt(byte) << BigInt(8 * i)), 0n),
  openedAt: b.readBigInt64LE(96),
  id: b.readBigUInt64LE(104),
  leverage: b[112],
  isLong: !!b[113],
});

/* What a position is worth, in the same arithmetic the program uses — this is
   for showing a number, never for deciding one. */
export function valueOf(pos, price, fundingBpsPerHour, now) {
  const notional = pos.margin * BigInt(pos.leverage);
  let gross = (notional * (price - pos.entry)) / pos.entry;
  if (!pos.isLong) gross = -gross;
  const seconds = BigInt(Math.max(0, now - Number(pos.openedAt)));
  const funding = (notional * BigInt(fundingBpsPerHour) * seconds) / (10000n * 3600n);
  const pnl = gross - funding;
  const dead = pnl <= -((pos.margin * 9000n) / 10000n);
  const payout = dead ? 0n : (() => {
    const net = BigInt(pos.margin) + pnl;
    if (net <= 0n) return 0n;
    const cap = pos.margin * 5n;
    return net > cap ? cap : net;
  })();
  return { pnl, payout, liquidatable: dead, funding };
}
