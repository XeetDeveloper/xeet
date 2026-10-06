/* Trading against the local vault.
 *
 *   node local/trade.mjs long 30 2      $30 of margin, 2x, long
 *   node local/trade.mjs short 10 3
 *   node local/trade.mjs list
 *   node local/trade.mjs close 1
 *
 * The price is the live one: fetched from the operator's service, which reads
 * the coin's real pools and signs what it saw. The program checks that
 * signature exactly as it would on mainnet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as s from "./sol.mjs";
import * as v from "./vault.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(HERE, "state.json"), "utf8"));
const seeds = JSON.parse(fs.readFileSync(path.join(HERE, ".keys.json"), "utf8"));
const trader = s.keypairFromSeed(Buffer.from(seeds.trader, "hex"));
const call = s.rpc(state.rpc);
const PRICE = process.env.PRICE || "http://127.0.0.1:8910/price";
const USD = 1_000_000n;

const money = (n) => (n < 0n ? "-$" : "$") + (Number(n < 0n ? -n : n) / 1e6).toFixed(2);
const show = (p) => (Number(p) / 1e18).toPrecision(4);

/* PRICE_AT=0.000026 pretends the pool moved, so a win, a loss and a
   liquidation can all be tried without waiting for the market to oblige. The
   deployed service refuses to sign a price it was handed. */
async function signedPrice() {
  const forced = process.env.PRICE_AT ? `&price=${process.env.PRICE_AT}` : "";
  const url = `${PRICE}?chain=solana&address=${state.coin}&vault=${state.vault}&scheme=solana${forced}`;
  const r = await fetch(url);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || "no price");
  return body;
}

async function read(pubkey, reader) {
  const acc = await s.account(call, pubkey);
  return acc ? reader(acc.bytes) : null;
}

async function open(isLong, usd, leverage) {
  const price = await signedPrice();
  const vault = await read(state.vault, v.readVault);
  const market = await read(state.market, v.readMarket);
  const margin = BigInt(Math.round(usd * 1e6));

  if (margin > market.maxMargin) {
    throw new Error(`this market allows ${money(market.maxMargin)} a position`);
  }
  const id = Number(vault.nextId);
  const ixs = [
    s.ed25519Ix(price.pubkey, price.signature, price.message),
    v.open({
      trader: trader.pubkey, vault: state.vault, market: state.market,
      position: v.pdas().position(id), from: state.traderUsd, treasury: state.treasury,
      mint: state.mint, id, token: state.coin, margin, leverage, isLong,
      price: BigInt(price.value), at: price.at,
    }),
  ];
  const sig = await s.send(call, ixs, trader.pubkey, [trader]);

  const pos = await read(v.pdas().position(id), v.readPosition);
  console.log(`${isLong ? "LONG" : "SHORT"} #${id} open`);
  console.log(`  margin     ${money(pos.margin)} (of ${money(margin)}, the rest was the fee)`);
  console.log(`  leverage   ${pos.leverage}x  →  ${money(pos.margin * BigInt(pos.leverage))} of exposure`);
  console.log(`  entry      $${show(pos.entry)}  (${price.pools} pools, $${Math.round(price.liquidity).toLocaleString()} deep)`);
  const move = isLong ? 1 - 0.9 / leverage : 1 + 0.9 / leverage;
  console.log(`  liquidated near $${(Number(pos.entry) / 1e18 * move).toPrecision(4)}`);
  console.log(`  most it can pay  ${money(pos.margin * BigInt(pos.payoutMult))} (${pos.payoutMult}x the margin)`);
  console.log(`  tx         ${sig}`);
}

async function list() {
  const vault = await read(state.vault, v.readVault);
  const price = await signedPrice().catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  let any = false;
  for (let id = 1; id < Number(vault.nextId); id++) {
    const pos = await read(v.pdas().position(id), v.readPosition);
    if (!pos) continue;
    any = true;
    const line = [`#${id}`, pos.isLong ? "LONG" : "SHORT", money(pos.margin), `${pos.leverage}x`,
      `entry $${show(pos.entry)}`];
    if (price) {
      const val = v.valueOf(pos, BigInt(price.value), vault.fundingBpsPerHour, now);
      line.push(val.liquidatable ? "LIQUIDATABLE"
        : `${val.pnl >= 0n ? "+" : ""}${money(val.pnl)} → ${money(val.payout)}`);
    }
    console.log(line.join("  "));
  }
  if (!any) console.log("nothing open");
  console.log(`\nvault owes ${money(vault.liabilities)}; price now $${price ? show(BigInt(price.value)) : "?"}`);
}

async function close(id) {
  const price = await signedPrice();
  const before = (await s.account(call, state.traderUsd)).bytes.readBigUInt64LE(64);
  const sig = await s.send(call, [
    s.ed25519Ix(price.pubkey, price.signature, price.message),
    v.close({
      caller: trader.pubkey, trader: trader.pubkey, vault: state.vault, market: state.market,
      position: v.pdas().position(id), treasury: state.treasury, to: state.traderUsd,
      mint: state.mint, price: BigInt(price.value), at: price.at,
    }),
  ], trader.pubkey, [trader]);
  const after = (await s.account(call, state.traderUsd)).bytes.readBigUInt64LE(64);
  console.log(`closed #${id} at $${show(BigInt(price.value))} — ${money(after - before)} back`);
  console.log(`  tx ${sig}`);
}

const [cmd, a, b] = process.argv.slice(2);
const run = {
  long: () => open(true, Number(a), Number(b || 2)),
  short: () => open(false, Number(a), Number(b || 2)),
  list,
  close: () => close(Number(a)),
  balance: async () => {
    const bal = (await s.account(call, state.traderUsd)).bytes.readBigUInt64LE(64);
    const held = (await s.account(call, state.treasury)).bytes.readBigUInt64LE(64);
    console.log(`you ${money(bal)} · vault ${money(held)}`);
  },
}[cmd];

if (!run) {
  console.log("usage: trade.mjs long|short <usd> <leverage> | list | close <id> | balance");
  process.exit(1);
}
run().catch((e) => { console.error(e.message); process.exit(1); });
