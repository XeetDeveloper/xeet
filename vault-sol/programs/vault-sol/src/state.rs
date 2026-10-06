use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Moves the capital. Never a key that lives on a server.
    pub owner: Pubkey,
    /// Signs prices. Lives on a server, and can take nothing out of here.
    pub operator: Pubkey,
    /// What margin is denominated in — USDC.
    pub mint: Pubkey,
    /// The sum of every open position's best case. The treasury may never
    /// hold less than this.
    pub liabilities: u64,
    pub next_id: u64,
    pub open_fee_bps: u16,
    pub funding_bps_per_hour: u16,
    pub paused: bool,
    pub bump: u8,
    pub treasury_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// The coin being traded. It is never held by this program — a position
    /// is margin settled against a price, not a token.
    pub token: Pubkey,
    pub max_margin: u64,
    pub max_notional: u64,
    pub open_notional: u64,
    /// When this market last saw a signed price, which is what the stale
    /// exit measures its silence from.
    pub last_price_at: i64,
    pub max_leverage: u8,
    /// The most this market pays, as a multiple of margin.
    pub payout_mult: u8,
    pub live: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub trader: Pubkey,
    pub token: Pubkey,
    pub margin: u64,
    pub entry: u128,
    pub opened_at: i64,
    pub id: u64,
    pub leverage: u8,
    /// Copied from the market at open. The ceiling a position was opened
    /// under is the ceiling it settles under — changing a market's cap must
    /// never reach back into a position somebody already took.
    pub payout_mult: u8,
    pub is_long: bool,
    pub bump: u8,
}
