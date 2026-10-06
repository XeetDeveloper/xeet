use crate::constants::*;
use crate::state::Position;

/* The arithmetic, in one place, so the panel, the chain and the tests cannot
   each have their own idea of what a position is worth. */

/// Exposure: the margin, levered.
pub fn notional(p: &Position) -> u64 {
    p.margin.saturating_mul(p.leverage as u64)
}

/// The rent the house charges for carrying the exposure, for the time it was
/// actually carried.
pub fn funding(p: &Position, bps_per_hour: u16, now: i64) -> u64 {
    let secs = (now - p.opened_at).max(0) as u128;
    let owed = (notional(p) as u128)
        .saturating_mul(bps_per_hour as u128)
        .saturating_mul(secs)
        / (10_000u128 * 3_600);
    owed.min(u64::MAX as u128) as u64
}

/// Profit or loss, funding already taken out of it.
pub fn pnl(p: &Position, price: u128, bps_per_hour: u16, now: i64) -> i128 {
    if p.entry == 0 {
        return 0;
    }
    let move_ = price as i128 - p.entry as i128;
    let mut gross = (notional(p) as i128).saturating_mul(move_) / (p.entry as i128);
    if !p.is_long {
        gross = -gross;
    }
    gross - funding(p, bps_per_hour, now) as i128
}

/// Dead when nine tenths of the margin is gone.
pub fn liquidatable(p: &Position, pnl: i128) -> bool {
    let limit = -((p.margin as i128 * (10_000 - MAINTENANCE_BPS) as i128) / 10_000);
    pnl <= limit
}

/// The payout, inside both of its fences: never below zero, never above the
/// promise the vault set aside when the position was opened.
pub fn payout(p: &Position, pnl: i128) -> u64 {
    let net = p.margin as i128 + pnl;
    if net <= 0 {
        return 0;
    }
    let cap = (p.margin as u128).saturating_mul(PAYOUT_CAP as u128);
    (net as u128).min(cap) as u64
}

/// Where the position dies, as a price.
pub fn liquidation_price(p: &Position) -> u128 {
    if p.leverage == 0 {
        return 0;
    }
    let move_ = p.entry * (10_000 - MAINTENANCE_BPS) as u128 / (10_000u128 * p.leverage as u128);
    if p.is_long {
        p.entry.saturating_sub(move_)
    } else {
        p.entry.saturating_add(move_)
    }
}
