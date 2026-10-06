use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::*;
use crate::error::XeetError;
use crate::math;
use crate::price;
use crate::state::*;

/* ------------------------------------------------------------- the house */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, Vault>,
    pub mint: Account<'info, Mint>,
    #[account(
        init, payer = owner, seeds = [TREASURY_SEED], bump,
        token::mint = mint, token::authority = vault, 
    )]
    pub treasury: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    operator: Pubkey,
    open_fee_bps: u16,
    funding_bps_per_hour: u16,
) -> Result<()> {
    require!(
        open_fee_bps <= MAX_FEE_BPS && funding_bps_per_hour <= MAX_FUNDING_BPS,
        XeetError::FeeTooHigh
    );
    let v = &mut ctx.accounts.vault;
    v.owner = ctx.accounts.owner.key();
    v.operator = operator;
    v.mint = ctx.accounts.mint.key();
    v.liabilities = 0;
    v.next_id = 1;
    v.open_fee_bps = open_fee_bps;
    v.funding_bps_per_hour = funding_bps_per_hour;
    v.paused = false;
    v.bump = ctx.bumps.vault;
    v.treasury_bump = ctx.bumps.treasury;
    Ok(())
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [TREASURY_SEED], bump = vault.treasury_bump)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.mint)]
    pub from: Account<'info, TokenAccount>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.from.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}

#[derive(Accounts)]
pub struct Defund<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [TREASURY_SEED], bump = vault.treasury_bump)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.mint)]
    pub to: Account<'info, TokenAccount>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

/* The house may take out the surplus and never a cent more: every open
   position's best case is inside `liabilities`, and the trader's own margin
   is inside it too. */
pub fn handle_defund(ctx: Context<Defund>, amount: u64) -> Result<()> {
    let held = ctx.accounts.treasury.amount;
    let free = held.saturating_sub(ctx.accounts.vault.liabilities);
    require!(amount <= free, XeetError::Undercollateralised);
    pay(
        &ctx.accounts.token_program,
        &ctx.accounts.treasury,
        &ctx.accounts.to,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        amount,
    )
}

#[derive(Accounts)]
#[instruction(token: Pubkey)]
pub struct SetMarket<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(
        init_if_needed, payer = owner, space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, token.as_ref()], bump,
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_set_market(
    ctx: Context<SetMarket>,
    token: Pubkey,
    max_margin: u64,
    max_notional: u64,
    max_leverage: u8,
    payout_mult: u8,
    live: bool,
) -> Result<()> {
    require!(
        (MIN_PAYOUT_MULT..=MAX_PAYOUT_MULT).contains(&payout_mult),
        XeetError::BadPayoutMult
    );
    let m = &mut ctx.accounts.market;
    m.payout_mult = payout_mult;
    m.token = token;
    m.max_margin = max_margin;
    m.max_notional = max_notional;
    m.max_leverage = max_leverage;
    m.live = live;
    m.bump = ctx.bumps.market;
    Ok(())
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

pub fn handle_set_config(
    ctx: Context<SetConfig>,
    operator: Option<Pubkey>,
    open_fee_bps: Option<u16>,
    funding_bps_per_hour: Option<u16>,
    paused: Option<bool>,
    new_owner: Option<Pubkey>,
) -> Result<()> {
    let v = &mut ctx.accounts.vault;
    if let Some(o) = operator {
        v.operator = o;
    }
    if let Some(f) = open_fee_bps {
        require!(f <= MAX_FEE_BPS, XeetError::FeeTooHigh);
        v.open_fee_bps = f;
    }
    if let Some(f) = funding_bps_per_hour {
        require!(f <= MAX_FUNDING_BPS, XeetError::FeeTooHigh);
        v.funding_bps_per_hour = f;
    }
    // Pausing stops NEW positions. It cannot touch open ones, which close and
    // liquidate exactly as before — a pause that trapped money would be a rug
    // with a nicer name.
    if let Some(p) = paused {
        v.paused = p;
    }
    if let Some(o) = new_owner {
        v.owner = o;
    }
    Ok(())
}

/* ------------------------------------------------------------ the trading */

#[derive(Accounts)]
#[instruction(id: u64, token: Pubkey)]
pub struct Open<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [MARKET_SEED, token.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = trader, space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, &id.to_le_bytes()], bump,
    )]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = vault.mint, token::authority = trader)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, seeds = [TREASURY_SEED], bump = vault.treasury_bump)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    /// CHECK: the instructions sysvar, checked by address inside price::verify
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_open(
    ctx: Context<Open>,
    id: u64,
    token: Pubkey,
    margin: u64,
    leverage: u8,
    is_long: bool,
    price_value: u128,
    price_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.vault.paused, XeetError::Paused);
    require!(id == ctx.accounts.vault.next_id, XeetError::WrongId);

    let market = &ctx.accounts.market;
    require!(market.live, XeetError::MarketClosed);
    require!(market.token == token, XeetError::WrongMarket);
    require!(leverage >= 1 && leverage <= market.max_leverage, XeetError::BadLeverage);
    require!(margin > 0 && margin <= market.max_margin, XeetError::MarginTooLarge);

    let vault_key = ctx.accounts.vault.key();
    price::verify(
        &ctx.accounts.instructions.to_account_info(),
        &vault_key,
        &ctx.accounts.vault.operator,
        &token,
        price_value,
        price_at,
        now,
    )?;

    /* The fee comes out of the margin rather than being invoiced later: the
       trader pays what the button said, and the position is the rest of it.
       Taking it at close instead would mean a liquidated position paid none. */
    let fee = (margin as u128)
        .saturating_mul(leverage as u128)
        .saturating_mul(ctx.accounts.vault.open_fee_bps as u128)
        / 10_000;
    require!((fee as u64) < margin, XeetError::MarginTooLarge);
    let net = margin - fee as u64;

    let notional = net.checked_mul(leverage as u64).ok_or(XeetError::Overflow)?;
    require!(
        market.open_notional.saturating_add(notional) <= market.max_notional,
        XeetError::MarketFull
    );

    // Pre-funded or not opened: the vault must be able to pay this position's
    // best case the moment it exists.
    let promise = net
        .checked_mul(market.payout_mult.max(1) as u64)
        .ok_or(XeetError::Overflow)?;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.from.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        margin,
        ctx.accounts.mint.decimals,
    )?;

    ctx.accounts.treasury.reload()?;
    let liabilities = ctx
        .accounts
        .vault
        .liabilities
        .checked_add(promise)
        .ok_or(XeetError::Overflow)?;
    require!(
        ctx.accounts.treasury.amount >= liabilities,
        XeetError::Undercollateralised
    );

    ctx.accounts.vault.liabilities = liabilities;
    ctx.accounts.vault.next_id = id + 1;
    ctx.accounts.market.open_notional += notional;
    ctx.accounts.market.last_price_at = ctx.accounts.market.last_price_at.max(price_at);

    let p = &mut ctx.accounts.position;
    p.trader = ctx.accounts.trader.key();
    p.token = token;
    p.margin = net;
    p.entry = price_value;
    p.opened_at = now;
    p.id = id;
    p.leverage = leverage;
    p.payout_mult = ctx.accounts.market.payout_mult;
    p.is_long = is_long;
    p.bump = ctx.bumps.position;
    Ok(())
}

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Whoever sends it. For a close this must be the trader; for a
    /// liquidation it may be anybody, because a venue where only the house
    /// may liquidate is a venue that liquidates when it feels like it.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: the position's owner, who gets the payout and the rent back
    #[account(mut, address = position.trader)]
    pub trader: UncheckedAccount<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [MARKET_SEED, position.token.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, close = trader, seeds = [POSITION_SEED, &position.id.to_le_bytes()], bump = position.bump)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [TREASURY_SEED], bump = vault.treasury_bump)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.mint, token::authority = trader)]
    pub to: Account<'info, TokenAccount>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    /// CHECK: the instructions sysvar, checked by address inside price::verify
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_close(ctx: Context<Settle>, price_value: u128, price_at: i64) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.caller.key(),
        ctx.accounts.position.trader,
        XeetError::BadSignature
    );
    settle(ctx, price_value, price_at, false)
}

pub fn handle_liquidate(ctx: Context<Settle>, price_value: u128, price_at: i64) -> Result<()> {
    settle(ctx, price_value, price_at, true)
}

fn settle(ctx: Context<Settle>, price_value: u128, price_at: i64, must_be_dead: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_key = ctx.accounts.vault.key();
    price::verify(
        &ctx.accounts.instructions.to_account_info(),
        &vault_key,
        &ctx.accounts.vault.operator,
        &ctx.accounts.position.token,
        price_value,
        price_at,
        now,
    )?;

    let pos = &ctx.accounts.position;
    let pnl = math::pnl(pos, price_value, ctx.accounts.vault.funding_bps_per_hour, now);
    let dead = math::liquidatable(pos, pnl);
    require!(!must_be_dead || dead, XeetError::NotLiquidatable);
    let owed = if dead { 0 } else { math::payout(pos, pnl) };

    let notional = math::notional(pos);
    let promise = math::promised(pos);

    ctx.accounts.market.open_notional = ctx.accounts.market.open_notional.saturating_sub(notional);
    ctx.accounts.market.last_price_at = ctx.accounts.market.last_price_at.max(price_at);
    ctx.accounts.vault.liabilities = ctx.accounts.vault.liabilities.saturating_sub(promise);

    if owed > 0 {
        pay(
            &ctx.accounts.token_program,
            &ctx.accounts.treasury,
            &ctx.accounts.to,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            owed,
        )?;
    }
    Ok(())
}

/* The way out when the operator goes quiet: no signature, no permission, no
   price. The position never happened and the margin goes home. */
#[derive(Accounts)]
pub struct CloseStale<'info> {
    #[account(mut, address = position.trader)]
    pub trader: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [MARKET_SEED, position.token.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, close = trader, seeds = [POSITION_SEED, &position.id.to_le_bytes()], bump = position.bump)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [TREASURY_SEED], bump = vault.treasury_bump)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.mint, token::authority = trader)]
    pub to: Account<'info, TokenAccount>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_close_stale(ctx: Context<CloseStale>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pos = &ctx.accounts.position;
    let since = ctx.accounts.market.last_price_at.max(pos.opened_at);
    require!(now > since + STALE_EXIT, XeetError::NotStale);

    let margin = pos.margin;
    let notional = math::notional(pos);
    let promise = math::promised(pos);

    ctx.accounts.market.open_notional = ctx.accounts.market.open_notional.saturating_sub(notional);
    ctx.accounts.vault.liabilities = ctx.accounts.vault.liabilities.saturating_sub(promise);

    pay(
        &ctx.accounts.token_program,
        &ctx.accounts.treasury,
        &ctx.accounts.to,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        margin,
    )
}

/* Keeps a quiet market from looking abandoned: anybody holding a fresh signed
   price may refresh it. */
#[derive(Accounts)]
pub struct Poke<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [MARKET_SEED, market.token.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: the instructions sysvar, checked by address inside price::verify
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_poke(ctx: Context<Poke>, price_value: u128, price_at: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_key = ctx.accounts.vault.key();
    price::verify(
        &ctx.accounts.instructions.to_account_info(),
        &vault_key,
        &ctx.accounts.vault.operator,
        &ctx.accounts.market.token,
        price_value,
        price_at,
        now,
    )?;
    ctx.accounts.market.last_price_at = ctx.accounts.market.last_price_at.max(price_at);
    Ok(())
}

/* ----------------------------------------------------------------- inside */

fn pay<'info>(
    token_program: &Program<'info, Token>,
    treasury: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    vault: &Account<'info, Vault>,
    amount: u64,
) -> Result<()> {
    let bump = [vault.bump];
    let seeds: &[&[u8]] = &[VAULT_SEED, &bump];
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: treasury.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}
