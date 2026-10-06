/* Give the extension's own Solana trading account something to trade with.
 *
 *   node local/fund-panel.mjs <the account from the popup> [dollars]
 *
 * SOL for fees comes from the validator's faucet, the dollars from the mint
 * this venue was set up with. Both are local and both are free.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as s from "./sol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(HERE, "state.json"), "utf8"));
const seeds = JSON.parse(fs.readFileSync(path.join(HERE, ".keys.json"), "utf8"));
const house = s.keypairFromSeed(Buffer.from(seeds.house, "hex"));
const call = s.rpc(state.rpc);

const who = process.argv[2];
const dollars = Number(process.argv[3] || 100);
if (!who || !/^[A-Za-z0-9]{32,44}$/.test(who)) {
  console.error("usage: fund-panel.mjs <solana address from the Xeet popup> [dollars]");
  process.exit(1);
}

const sig = await call("requestAirdrop", [who, 2_000_000_000]);
for (let i = 0; i < 40; i++) {
  const st = (await call("getSignatureStatuses", [[sig]])).value[0];
  if (st && st.confirmationStatus) break;
  await new Promise((r) => setTimeout(r, 200));
}

const ata = s.ataOf(who, state.mint);
const exists = await s.account(call, ata);
const ixs = [];
if (!exists) ixs.push(s.createAtaIx(house.pubkey, who, state.mint));
ixs.push(s.mintToIx(state.mint, ata, house.pubkey, BigInt(Math.round(dollars * 1e6))));
await s.send(call, ixs, house.pubkey, [house]);

const after = await s.account(call, ata);
console.log(`${who}`);
console.log(`  2 SOL for fees`);
console.log(`  $${(Number(after.bytes.readBigUInt64LE(64)) / 1e6).toFixed(2)} in ${ata}`);
console.log(`\nNow wire the extension at it:  ./local/wire-extension.sh`);
