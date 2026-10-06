use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;
use solana_sdk_ids::{ed25519_program, sysvar::instructions::ID as IX_SYSVAR_ID};

use crate::constants::*;
use crate::error::XeetError;

/* The price, and the one thing this program trusts.
 *
 * Solana cannot see a memecoin's dollar price any more than any other chain
 * can, so the operator signs it and this verifies the signature — not with
 * our own curve arithmetic, but by looking at the transaction and insisting
 * that the native ed25519 program was asked to check it in the same
 * transaction, over exactly the bytes we expect, with exactly the key we
 * expect. The runtime does the cryptography; this does the agreeing.
 *
 * What that trust is worth, in both directions: a price has to be minutes
 * old at most to be used at all, and if the operator ever goes quiet every
 * trader can walk out with their margin after STALE_EXIT. The operator can
 * stop this venue. The operator cannot keep a dollar inside it.
 */

pub struct Attested {
    pub value: u128,
    pub at: i64,
}

/// The bytes the operator signs. The vault's own address is in them, so a
/// signature made for one venue verifies against nothing at another.
pub fn message_for(vault: &Pubkey, token: &Pubkey, value: u128, at: i64) -> [u8; PRICE_MESSAGE_LEN] {
    let mut m = [0u8; PRICE_MESSAGE_LEN];
    m[..13].copy_from_slice(PRICE_TAG);
    m[13..45].copy_from_slice(vault.as_ref());
    m[45..77].copy_from_slice(token.as_ref());
    m[77..93].copy_from_slice(&value.to_le_bytes());
    m[93..101].copy_from_slice(&at.to_le_bytes());
    m
}

/// Find the ed25519 verification of THIS price in THIS transaction.
pub fn verify(
    ix_sysvar: &AccountInfo,
    vault_key: &Pubkey,
    operator: &Pubkey,
    token: &Pubkey,
    value: u128,
    at: i64,
    now: i64,
) -> Result<Attested> {
    require!(value > 0, XeetError::ZeroPrice);
    require!(
        at + MAX_PRICE_AGE >= now && at <= now + MAX_PRICE_SKEW,
        XeetError::StalePrice
    );
    require_keys_eq!(*ix_sysvar.key, IX_SYSVAR_ID, XeetError::BadSignature);

    let want = message_for(vault_key, token, value, at);

    // The ed25519 instruction can sit anywhere in the transaction; what
    // matters is that one of them checked these bytes with this key.
    let mut i = 0usize;
    loop {
        let ix = match load_instruction_at_checked(i, ix_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        i += 1;
        if ix.program_id != ed25519_program::ID {
            continue;
        }
        if matches(&ix.data, operator, &want) {
            return Ok(Attested { value, at });
        }
    }
    Err(XeetError::BadSignature.into())
}

/* The ed25519 program's own layout: a count, a padding byte, then one
   fourteen-byte offsets record per signature. Everything is read defensively
   — this is attacker-supplied data that the runtime has already checked the
   signature of, but nothing else about. */
fn matches(data: &[u8], operator: &Pubkey, want: &[u8]) -> bool {
    if data.len() < 16 || data[0] != 1 {
        return false;
    }
    let u16_at = |i: usize| -> usize { u16::from_le_bytes([data[i], data[i + 1]]) as usize };

    let sig_ix = u16_at(4);
    let key_off = u16_at(6);
    let key_ix = u16_at(8);
    let msg_off = u16_at(10);
    let msg_len = u16_at(12);
    let msg_ix = u16_at(14);

    // Everything must live in this instruction's own data (0xFFFF is the
    // ed25519 program's way of saying "here"), or it is checking somebody
    // else's bytes.
    let here = |ix: usize| ix == 0xFFFF || ix == u16::MAX as usize;
    if !(here(sig_ix) && here(key_ix) && here(msg_ix)) {
        return false;
    }
    if msg_len != want.len() || key_off + 32 > data.len() || msg_off + msg_len > data.len() {
        return false;
    }
    &data[key_off..key_off + 32] == operator.as_ref() && &data[msg_off..msg_off + msg_len] == want
}
