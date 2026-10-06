/* One command that puts the whole venue on a validator running on this
 * laptop: the program, a dollar token nobody has to buy, the house's capital,
 * and a market for one coin with its caps.
 *
 * NOTHING HERE COSTS ANYTHING. The SOL is airdropped by the validator, the
 * dollars are minted by a mint this script creates, and the program is loaded
 * at genesis rather than deployed. What is real is everything else: the
 * program is the same binary, the price is the live one off the coin's own
 * pools, and a position is a signed transaction that moves tokens.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as s from "./sol.mjs";
import * as v from "./vault.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const COIN = process.env.COIN || "6HFJ5sxVoEtczr9siAUeGssmpfhQSS3pEoBcCycUpump";  // $XEET
const HOUSE_CAPITAL = Number(process.env.HOUSE_CAPITAL || 60);    // dollars the house puts up
const TRADER_USD = Number(process.env.TRADER_USD || 100);         // dollars to trade with
const MAX_MARGIN = Number(process.env.MAX_MARGIN || 25);          // per position
const MAX_NOTIONAL = Number(process.env.MAX_NOTIONAL || 500);     // across the market
const MAX_LEVERAGE = Number(process.env.MAX_LEVERAGE || 5);
const USD = 1_000_000n;                                           // six decimals, like USDC

const call = s.rpc(RPC);
const keysPath = path.join(HERE, ".keys.json");
const statePath = path.join(HERE, "state.json");

function keys() {
  if (fs.existsSync(keysPath)) {
    const saved = JSON.parse(fs.readFileSync(keysPath, "utf8"));
    return Object.fromEntries(Object.entries(saved).map(
      ([k, seed]) => [k, s.keypairFromSeed(Buffer.from(seed, "hex"))]));
  }
  const made = { house: s.newKeypair(), operator: s.newKeypair(), trader: s.newKeypair() };
  fs.writeFileSync(keysPath, JSON.stringify(
    Object.fromEntries(Object.entries(made).map(([k, kp]) => [k, Buffer.from(kp.seed).toString("hex")])),
    null, 2));
  fs.chmodSync(keysPath, 0o600);
  return made;
}

async function airdrop(who, sol) {
  const sig = await call("requestAirdrop", [who, sol * 1_000_000_000]);
  for (let i = 0; i < 40; i++) {
    const st = (await call("getSignatureStatuses", [[sig]])).value[0];
    if (st && st.confirmationStatus) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("airdrop did not confirm");
}

const main = async () => {
  const k = keys();
  const p = v.pdas();

  const health = await call("getHealth").catch(() => null);
  if (health !== "ok") throw new Error(`no validator at ${RPC} — start it with local/run.sh`);

  const program = await s.account(call, v.PROGRAM);
  if (!program || !program.executable) {
    throw new Error("the vault program is not on this validator — start it with local/run.sh");
  }

  console.log("house   ", k.house.pubkey);
  console.log("operator", k.operator.pubkey);
  console.log("trader  ", k.trader.pubkey);

  await airdrop(k.house.pubkey, 10);
  await airdrop(k.trader.pubkey, 10);

  // the dollar token: a mint this script owns, so nobody has to buy anything
  const mint = s.newKeypair();
  const houseUsd = s.newKeypair();
  const traderUsd = s.newKeypair();
  const mintRent = await call("getMinimumBalanceForRentExemption", [82]);
  const accRent = await call("getMinimumBalanceForRentExemption", [165]);

  await s.send(call, [
    ...s.createMintIxs(k.house.pubkey, mint.pubkey, k.house.pubkey, 6, mintRent),
    ...s.createTokenAccountIxs(k.house.pubkey, houseUsd.pubkey, mint.pubkey, k.house.pubkey, accRent),
    ...s.createTokenAccountIxs(k.house.pubkey, traderUsd.pubkey, mint.pubkey, k.trader.pubkey, accRent),
    s.mintToIx(mint.pubkey, houseUsd.pubkey, k.house.pubkey, BigInt(HOUSE_CAPITAL) * USD),
    s.mintToIx(mint.pubkey, traderUsd.pubkey, k.house.pubkey, BigInt(TRADER_USD) * USD),
  ], k.house.pubkey, [k.house, mint, houseUsd, traderUsd]);
  console.log("dollars  minted:", HOUSE_CAPITAL, "to the house,", TRADER_USD, "to you");

  await s.send(call, [v.initialize({
    owner: k.house.pubkey, vault: p.vault, mint: mint.pubkey, treasury: p.treasury,
    operator: k.operator.pubkey, openFeeBps: 10, fundingBps: 1,
  })], k.house.pubkey, [k.house]);
  console.log("vault    initialized at", p.vault);

  await s.send(call, [v.fund({
    funder: k.house.pubkey, vault: p.vault, treasury: p.treasury,
    from: houseUsd.pubkey, mint: mint.pubkey, amount: BigInt(HOUSE_CAPITAL) * USD,
  })], k.house.pubkey, [k.house]);
  console.log("capital  in:", "$" + HOUSE_CAPITAL);

  /* The ceiling the house can actually honour. The vault must be able to pay
     margin x multiple on every open position at once, and it holds its own
     capital plus the margins — so with $60 behind a $25 position the honest
     answer is 3x, not the 5x a bigger vault could promise. */
  const payoutMult = Number(process.env.PAYOUT_MULT
    || Math.max(2, Math.min(10, Math.floor((HOUSE_CAPITAL + MAX_MARGIN) / MAX_MARGIN))));

  const market = p.market(COIN);
  await s.send(call, [v.setMarket({
    owner: k.house.pubkey, vault: p.vault, market, token: COIN,
    maxMargin: BigInt(MAX_MARGIN) * USD, maxNotional: BigInt(MAX_NOTIONAL) * USD,
    maxLeverage: MAX_LEVERAGE, payoutMult, live: true,
  })], k.house.pubkey, [k.house]);
  console.log("market   live for", COIN);
  console.log("         up to $" + MAX_MARGIN + " a position, " + MAX_LEVERAGE + "x, $" + MAX_NOTIONAL + " of book");
  console.log("         profit capped at " + payoutMult + "x margin — the most $" + HOUSE_CAPITAL + " can honour");

  fs.writeFileSync(statePath, JSON.stringify({
    rpc: RPC, program: v.PROGRAM, coin: COIN,
    vault: p.vault, treasury: p.treasury, market,
    mint: mint.pubkey, houseUsd: houseUsd.pubkey, traderUsd: traderUsd.pubkey,
    house: k.house.pubkey, operator: k.operator.pubkey, trader: k.trader.pubkey,
  }, null, 2));
  console.log("\nready. Open one with:  node local/trade.mjs long 25 2");
};

main().catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
