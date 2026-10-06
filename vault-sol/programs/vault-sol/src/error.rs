use anchor_lang::prelude::*;

#[error_code]
pub enum XeetError {
    #[msg("the vault is paused for new positions")]
    Paused,
    #[msg("this coin is not listed")]
    MarketClosed,
    #[msg("leverage is outside what this market allows")]
    BadLeverage,
    #[msg("margin is above what this market allows")]
    MarginTooLarge,
    #[msg("the book for this coin is full")]
    MarketFull,
    #[msg("the vault could not cover this position's best case")]
    Undercollateralised,
    #[msg("the price was not signed by the operator")]
    BadSignature,
    #[msg("the price is too old or from the future")]
    StalePrice,
    #[msg("that price is for another coin or another vault")]
    WrongMarket,
    #[msg("a price of zero is not a price")]
    ZeroPrice,
    #[msg("this position is not liquidatable")]
    NotLiquidatable,
    #[msg("the operator has not gone quiet")]
    NotStale,
    #[msg("that fee is above the ceiling")]
    FeeTooHigh,
    #[msg("arithmetic overflowed")]
    Overflow,
    #[msg("the position id is not the next one")]
    WrongId,
}
