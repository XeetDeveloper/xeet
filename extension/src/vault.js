/* Xeet — talking to the vault.
 *
 * The venue for coins no exchange will list is a contract on Robinhood Chain
 * (contracts/XeetVault.sol in this repo). This file is the only thing that
 * knows how to speak to it: what a market is called, how a call is encoded,
 * and where the signed price comes from.
 *
 * THREE PARTIES, AND WHAT EACH ONE IS TRUSTED WITH.
 *   - the contract holds the margin and pays the payouts; it is the only
 *     thing that moves money, and it will not open a position it could not
 *     pay in full;
 *   - the price service signs prices; it can stop the venue by going quiet
 *     and it cannot take a dollar out of it — after an hour of silence every
 *     trader walks out with their margin;
 *   - this file encodes calls. It is trusted with nothing.
 *
 * No ABI library: a call is a selector and some 32-byte words, and the words
 * are written out here the same way the swap path writes its own.
 */
import { keccak_256 } from "../vendor/sha3.js";
import * as evm from "./evm.js";

const enc = new TextEncoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const keccakHex = (s) => "0x" + hex(keccak_256(enc.encode(s)));

const sel = (sig) => "0x" + hex(keccak_256(enc.encode(sig))).slice(0, 8);
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const b32 = (h) => String(h).replace(/^0x/, "").padStart(64, "0");

const SELECTORS = {
  open: sel("open(bytes32,uint128,uint32,bool,(bytes32,uint256,uint64),bytes)"),
  close: sel("close(uint256,(bytes32,uint256,uint64),bytes)"),
  closeStale: sel("closeStale(uint256)"),
  positions: sel("positions(uint256)"),
  valueOf: sel("valueOf(uint256,uint256)"),
  liquidationPrice: sel("liquidationPrice(uint256)"),
  markets: sel("markets(bytes32)"),
  openNotional: sel("openNotional(bytes32)"),
  free: sel("free()"),
  allowance: sel("allowance(address,address)"),
  approve: sel("approve(address,uint256)"),
  balanceOf: sel("balanceOf(address)"),
};

/* A market is named the same way here, in the price service and in the
   contract's setMarket. One of the three spelling it differently is a
   signature that verifies against nothing. */
export const marketId = (chain, address) => keccakHex(`${chain}:${address}`);

/* `bytes` is dynamic, so it goes at the end behind an offset. Everything
   before it is one word each, including the price struct, which is three
   static fields and therefore inline. */
function withPrice(selector, head, price, signature) {
  const sig = String(signature).replace(/^0x/, "");
  const bytesLen = sig.length / 2;
  const offset = (head.length + 3 + 1) * 32;        // head + the struct + the offset word
  const padded = sig.padEnd(Math.ceil(bytesLen / 32) * 64, "0");
  return selector
    + head.join("")
    + b32(price.market) + word(price.value) + word(price.at)
    + word(offset)
    + word(bytesLen) + padded;
}

export const encodeOpen = (market, margin, leverage, isLong, price, signature) =>
  withPrice(SELECTORS.open,
    [b32(market), word(margin), word(leverage), word(isLong ? 1 : 0)], price, signature);

export const encodeClose = (id, price, signature) =>
  withPrice(SELECTORS.close, [word(id)], price, signature);

export const encodeCloseStale = (id) => SELECTORS.closeStale + word(id);
export const encodeApprove = (spender, amount) => SELECTORS.approve + addrWord(spender) + word(amount);

/* ------------------------------------------------------------- reading */

const call = (node, to, data) => node("eth_call", [{ to, data }, "latest"]);
const slice = (hexStr, i) => "0x" + String(hexStr).replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
const u = (hexStr, i) => BigInt(slice(hexStr, i));
const asInt = (hexStr, i) => {
  const v = u(hexStr, i);
  return v >= 2n ** 255n ? v - 2n ** 256n : v;
};

export function rpc(url) {
  return evm.rpc(url);
}

/* What this coin is allowed to carry, straight from the chain rather than
   from a number the panel made up. */
export async function market(node, vault, id) {
  const [raw, open_] = await Promise.all([
    call(node, vault, SELECTORS.markets + b32(id)),
    call(node, vault, SELECTORS.openNotional + b32(id)),
  ]);
  const maxMargin = u(raw, 0);
  const maxNotional = u(raw, 1);
  const maxLeverage = Number(u(raw, 2));
  const live = u(raw, 3) === 1n;
  const used = BigInt(open_);
  return {
    live,
    maxMargin, maxNotional, maxLeverage,
    openNotional: used,
    roomNotional: maxNotional > used ? maxNotional - used : 0n,
  };
}

export async function houseFree(node, vault) {
  return BigInt(await call(node, vault, SELECTORS.free));
}

export async function allowance(node, usdg, owner, spender) {
  return BigInt(await call(node, usdg, SELECTORS.allowance + addrWord(owner) + addrWord(spender)));
}

export async function balance(node, usdg, who) {
  return BigInt(await call(node, usdg, SELECTORS.balanceOf + addrWord(who)));
}

export async function position(node, vault, id) {
  const raw = await call(node, vault, SELECTORS.positions + word(id));
  return {
    id,
    trader: "0x" + slice(raw, 0).slice(-40),
    market: slice(raw, 1),
    margin: u(raw, 2),
    openedAt: Number(u(raw, 3)),
    leverage: Number(u(raw, 4)),
    isLong: u(raw, 5) === 1n,
    open: u(raw, 6) === 1n,
    entry: u(raw, 7),
  };
}

export async function valueOf(node, vault, id, price) {
  const raw = await call(node, vault, SELECTORS.valueOf + word(id) + word(price));
  return { pnl: asInt(raw, 0), payout: u(raw, 1), liquidatable: u(raw, 2) === 1n };
}

export async function liquidationPrice(node, vault, id) {
  return BigInt(await call(node, vault, SELECTORS.liquidationPrice + word(id)));
}

/* The id of the position a transaction just opened, read out of the receipt's
   own Opened log rather than guessed from nextId — two people opening in the
   same block would otherwise be told they own each other's position. */
export const OPENED_TOPIC = keccakHex(
  "Opened(uint256,address,bytes32,uint128,uint32,bool,uint256)");

export function openedIdFrom(receipt, vault) {
  const logs = (receipt && receipt.logs) || [];
  const hit = logs.find((l) =>
    String(l.address || "").toLowerCase() === String(vault).toLowerCase()
    && (l.topics || [])[0] === OPENED_TOPIC);
  return hit ? Number(BigInt(hit.topics[1])) : null;
}
