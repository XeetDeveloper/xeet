use anchor_lang::prelude::*;

/* The venue's fences. Every one of them exists to keep the most the book can
   pay under the cost of moving the price it settles against. */

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const TREASURY_SEED: &[u8] = b"treasury";
#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const POSITION_SEED: &[u8] = b"position";

/// How much a position may be paid, as a multiple of its margin — set per
/// market, because the ceiling is really two questions at once: how far the
/// coin could plausibly run, and how much the house can actually cover. A
/// vault with $60 in it cannot promise 5x on a $25 position however much it
/// would like to, and the honest answer is a lower ceiling rather than a
/// refused trade.
pub const MIN_PAYOUT_MULT: u8 = 2;
pub const MAX_PAYOUT_MULT: u8 = 10;

/// How much of the margin must survive: liquidated once 90% of it is gone.
pub const MAINTENANCE_BPS: u64 = 1_000;

/// Fee ceilings the owner can never raise past.
pub const MAX_FEE_BPS: u16 = 100; // 1% of notional at open
pub const MAX_FUNDING_BPS: u16 = 10; // 0.1% of notional an hour

/// A signed price is usable for this long, and no longer.
pub const MAX_PRICE_AGE: i64 = 120;

/// If the operator goes quiet for this long, traders walk out at entry
/// without anybody's permission.
pub const STALE_EXIT: i64 = 3_600;

/// Prices are integers at 1e18, the same scale the price service signs.
pub const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;

/// What the operator signs, so a signature for one venue cannot be replayed
/// at another: a tag, the vault, the coin, the price and when it was seen.
pub const PRICE_TAG: &[u8] = b"xeet-price-v1";
pub const PRICE_MESSAGE_LEN: usize = 13 + 32 + 32 + 16 + 8;
