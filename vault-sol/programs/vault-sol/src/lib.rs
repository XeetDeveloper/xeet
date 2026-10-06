pub mod constants;
pub mod error;
pub mod instructions;
pub mod math;
pub mod price;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("EHwwa3q9WQd3s5NzWvUZjk83zuCyApDbXep6DPEjyMzx");

/* Xeet — leverage on coins no exchange will list, with a vault as the
 * counterparty to every position in it.
 *
 * The whole product is three fences and an escape hatch:
 *   - a position's payout is capped at a multiple of its margin, set per
 *     market, so the house's liability is a number rather than a hope — and a
 *     vault that cannot cover 5x says 3x instead of refusing the trade;
 *   - margin per position and open notional per coin are capped, both set
 *     from the pool's own depth;
 *   - every open position is pre-funded — the vault refuses to open one it
 *     could not pay in full, and the house may only withdraw what is left
 *     after all of them are covered;
 *   - and if the operator who signs prices ever goes quiet, every trader
 *     walks out with their margin an hour later without asking anybody.
 *
 * Why so small: moving a $20K pool ten percent costs about $500, so any venue
 * where a ten percent move can pay out more than that is funding its own
 * attacker. Small is the only size at which this is honest.
 */
#[program]
pub mod vault_sol {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        operator: Pubkey,
        open_fee_bps: u16,
        funding_bps_per_hour: u16,
    ) -> Result<()> {
        instructions::handle_initialize(ctx, operator, open_fee_bps, funding_bps_per_hour)
    }

    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        instructions::handle_fund(ctx, amount)
    }

    pub fn defund(ctx: Context<Defund>, amount: u64) -> Result<()> {
        instructions::handle_defund(ctx, amount)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_market(
        ctx: Context<SetMarket>,
        token: Pubkey,
        max_margin: u64,
        max_notional: u64,
        max_leverage: u8,
        payout_mult: u8,
        live: bool,
    ) -> Result<()> {
        instructions::handle_set_market(
            ctx, token, max_margin, max_notional, max_leverage, payout_mult, live,
        )
    }

    pub fn set_config(
        ctx: Context<SetConfig>,
        operator: Option<Pubkey>,
        open_fee_bps: Option<u16>,
        funding_bps_per_hour: Option<u16>,
        paused: Option<bool>,
        new_owner: Option<Pubkey>,
    ) -> Result<()> {
        instructions::handle_set_config(
            ctx, operator, open_fee_bps, funding_bps_per_hour, paused, new_owner,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        ctx: Context<Open>,
        id: u64,
        token: Pubkey,
        margin: u64,
        leverage: u8,
        is_long: bool,
        price_value: u128,
        price_at: i64,
    ) -> Result<()> {
        instructions::handle_open(ctx, id, token, margin, leverage, is_long, price_value, price_at)
    }

    pub fn close(ctx: Context<Settle>, price_value: u128, price_at: i64) -> Result<()> {
        instructions::handle_close(ctx, price_value, price_at)
    }

    pub fn liquidate(ctx: Context<Settle>, price_value: u128, price_at: i64) -> Result<()> {
        instructions::handle_liquidate(ctx, price_value, price_at)
    }

    pub fn close_stale(ctx: Context<CloseStale>) -> Result<()> {
        instructions::handle_close_stale(ctx)
    }

    pub fn poke(ctx: Context<Poke>, price_value: u128, price_at: i64) -> Result<()> {
        instructions::handle_poke(ctx, price_value, price_at)
    }
}
