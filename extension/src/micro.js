/* Xeet — leverage on coins too young for an exchange.
 *
 * THE PROBLEM THIS IS SHAPED AROUND. A perp on a fresh memecoin is a gift to
 * whoever can move its pool. On a pool holding $22K, shifting the price ten
 * percent costs about $550 — so any product where a ten percent move can pay
 * out more than that is simply a cheque written to the first person who does
 * the arithmetic. Every venue that has tried to list day-one coins has been
 * taken apart this way, which is why none of them list day-one coins.
 *
 * THE SHAPE THAT SURVIVES. Not "a perp with limits bolted on", but a product
 * whose maximum payout is smaller than the cost of manipulating the price it
 * settles against:
 *
 *   - positions are capped in dollars, not in margin — $25 at 5x is $125 of
 *     exposure, and a ten percent move on that pays $12;
 *   - the whole book is capped too, so twenty wallets cannot add up to an
 *     attack: $300 of open interest against a $550 manipulation cost;
 *   - the settlement price is a five-minute average, so a one-block spike
 *     pays nobody;
 *   - and both caps scale with the pool, because a pool that grows makes
 *     bigger positions safe and a pool that shrinks makes them unsafe.
 *
 * It is a small product on purpose. Small is the only size at which this is
 * honest, and $5 is the size people actually take on a coin from the feed.
 */

const MAINTENANCE = 0.10;          // the part of margin that cannot be lost before liquidation
const FUNDING_HOURLY = 0.0001;     // 0.01% an hour, paid by the position either way
const MAX_LEVERAGE = 5;

/* What a pool can safely carry. The number that matters is not the pool's
   size but what it costs to move it: shifting a constant-product pool by `pct`
   costs roughly half the reserve times pct, and the whole book must be able to
   pay out less than that. */
export function limitsFor(liquidityUsd) {
  const liq = Math.max(0, Number(liquidityUsd) || 0);
  const costToMove10 = (liq / 2) * 0.0488;        // ≈ what a 10% push costs
  const bookPayoutAt10 = 0.10;                    // a 10% move pays 10% of exposure
  const maxExposure = Math.floor((costToMove10 * 0.55) / bookPayoutAt10);
  const maxPosition = Math.max(0, Math.min(25, Math.floor(maxExposure / 12)));
  return {
    ok: liq > 3000 && maxPosition >= 1,
    maxPosition,                                   // margin, in dollars
    maxExposure: Math.max(0, maxExposure),         // total open interest, in dollars
    costToMove10: Math.round(costToMove10),
    maxLeverage: MAX_LEVERAGE,
  };
}

/* Where the position dies. Maintenance is held back from the margin, so a 5x
   long is liquidated on a 18% move against it rather than a 20% one — the
   difference is what keeps a liquidation from settling below zero. */
export function liquidationPrice(entry, leverage, isLong) {
  const move = (1 / leverage) * (1 - MAINTENANCE);
  return isLong ? entry * (1 - move) : entry * (1 + move);
}

export function fundingOwed(usd, leverage, openedAt, now = Date.now()) {
  const hours = Math.max(0, (now - openedAt) / 3600000);
  return usd * leverage * FUNDING_HOURLY * hours;
}

/* What the position is worth right now, after funding and before fees. */
export function valueOf(pos, mark, now = Date.now()) {
  const dir = pos.isLong ? 1 : -1;
  const move = (mark - pos.entry) / pos.entry;
  const gross = pos.usd * pos.leverage * move * dir;
  const funding = fundingOwed(pos.usd, pos.leverage, pos.openedAt, now);
  const pnl = gross - funding;
  const liq = liquidationPrice(pos.entry, pos.leverage, pos.isLong);
  const dead = pos.isLong ? mark <= liq : mark >= liq;
  return {
    pnl: dead ? -pos.usd : pnl,
    equity: dead ? 0 : Math.max(0, pos.usd + pnl),
    pct: dead ? -100 : (pnl / pos.usd) * 100,
    funding,
    liq,
    liquidated: dead,
  };
}

/* The rules, answered in one place so the panel and the worker cannot disagree
   about what is allowed. */
export function check({ usd, leverage, liquidityUsd, openExposure }) {
  const lim = limitsFor(liquidityUsd);
  if (!lim.ok) return { ok: false, why: "this pool is too thin to carry leverage safely", lim };
  const lev = Math.round(Number(leverage) || 1);
  if (lev < 1 || lev > MAX_LEVERAGE) return { ok: false, why: `leverage is capped at ${MAX_LEVERAGE}x`, lim };
  const size = Number(usd) || 0;
  if (size <= 0) return { ok: false, why: "size must be positive", lim };
  if (size > lim.maxPosition) return { ok: false, why: `this pool allows $${lim.maxPosition} per position`, lim };
  if ((Number(openExposure) || 0) + size * lev > lim.maxExposure) {
    return { ok: false, why: "the book is full — total exposure is capped for this pool", lim };
  }
  return { ok: true, lim };
}

/* A five-minute average, not the last trade: a single block's spike should pay
   nobody, in either direction. */
export function twap(candles) {
  const rows = (candles || []).slice(-5);
  if (!rows.length) return null;
  const sum = rows.reduce((n, c) => n + (Number(c.close ?? c[4]) || 0), 0);
  return sum / rows.length;
}
