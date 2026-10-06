/* The vault, exercised in a real SVM.
 *
 * litesvm runs the actual program binary with the actual runtime, precompiles
 * included — so the ed25519 price attestations in here are verified by the
 * same code that would verify them on mainnet, and a forged one fails for the
 * same reason it would there.
 */
use {
    anchor_lang::{
        prelude::Pubkey, solana_program::system_program, AccountDeserialize, InstructionData,
        ToAccountMetas,
    },
    ed25519_dalek::{Signer as DalekSigner, SigningKey},
    litesvm::LiteSVM,
    anchor_lang::solana_program::instruction::Instruction,
    solana_account::Account,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

/* The SPL token layouts, written out rather than depended on: pulling the
   spl-token crate in here drags a second copy of half the Solana stack with
   it, and these two structures have not changed since 2020. */
const SPL_TOKEN: Pubkey = anchor_lang::solana_program::pubkey::Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
    28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);

fn mint_bytes(authority: &Pubkey, decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());        // Some(authority)
    d[4..36].copy_from_slice(authority.as_ref());
    d[44] = decimals;                                     // after supply: u64
    d[45] = 1;                                            // is_initialized
    d
}

fn token_bytes(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;                                           // AccountState::Initialized
    d
}

const USD: u64 = 1_000_000; // USDC has six decimals
const P1: u128 = 1_000_000_000_000_000_000; // $1 at the 1e18 scale
const ED25519_ID: Pubkey = solana_sdk_ids::ed25519_program::ID;
const IX_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;

struct Bench {
    svm: LiteSVM,
    house: Keypair,
    operator: SigningKey,
    mint: Pubkey,
    vault: Pubkey,
    treasury: Pubkey,
    coin: Pubkey,
    market: Pubkey,
    house_usdc: Pubkey,
    now: i64,
}

fn program_id() -> Pubkey {
    vault_sol::id()
}

/* ------------------------------------------------------------- plumbing */

fn mint_account(svm: &mut LiteSVM, authority: &Pubkey) -> Pubkey {
    let key = Pubkey::new_unique();
    svm.set_account(key, Account {
        lamports: 1_000_000_000, data: mint_bytes(authority, 6),
        owner: SPL_TOKEN, executable: false, rent_epoch: 0,
    }).unwrap();
    key
}

fn token_account(svm: &mut LiteSVM, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
    let key = Pubkey::new_unique();
    svm.set_account(key, Account {
        lamports: 1_000_000_000, data: token_bytes(mint, owner, amount),
        owner: SPL_TOKEN, executable: false, rent_epoch: 0,
    }).unwrap();
    key
}

fn balance_of(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let acc = svm.get_account(key).unwrap();
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

/* The ed25519 precompile instruction, built by hand so that the layout this
   program reads is the layout the runtime verifies. */
fn ed25519_ix(key: &SigningKey, message: &[u8]) -> Instruction {
    let sig = key.sign(message).to_bytes();
    let pubkey = key.verifying_key().to_bytes();
    let header = 2 + 14;
    let key_off = header as u16;
    let sig_off = key_off + 32;
    let msg_off = sig_off + 64;

    let mut data = Vec::with_capacity(msg_off as usize + message.len());
    data.push(1); // one signature
    data.push(0); // padding
    data.extend_from_slice(&sig_off.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&key_off.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&msg_off.to_le_bytes());
    data.extend_from_slice(&(message.len() as u16).to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&pubkey);
    data.extend_from_slice(&sig);
    data.extend_from_slice(message);

    Instruction::new_with_bytes(ED25519_ID, &data, vec![])
}

impl Bench {
    fn new() -> Self {
        /* A plain feature set rather than LiteSVM::new()'s all-enabled one:
           with every feature on, SBPF v0 programs — which is what the stable
           build toolchain still emits — load but refuse to execute, and every
           positive test quietly turns into a negative one. */
        let mut svm = LiteSVM::default()
            .with_builtins()
            .with_lamports(1_000_000_000_000_000)
            .with_sysvars()
            .with_default_programs()
            .with_precompiles()
            .with_sigverify(true)
            .with_blockhash_check(true);
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/vault_sol.so"));
        svm.add_program(program_id(), bytes).unwrap();

        let house = Keypair::new();
        svm.airdrop(&house.pubkey(), 100_000_000_000).unwrap();
        let operator = SigningKey::from_bytes(&[7u8; 32]);

        let mint = mint_account(&mut svm, &house.pubkey());
        let (vault, _) = Pubkey::find_program_address(&[b"vault"], &program_id());
        let (treasury, _) = Pubkey::find_program_address(&[b"treasury"], &program_id());
        let coin = Pubkey::new_unique();
        let (market, _) = Pubkey::find_program_address(&[b"market", coin.as_ref()], &program_id());
        let house_usdc = token_account(&mut svm, &mint, &house.pubkey(), 100_000 * USD);

        let mut b = Bench {
            svm, house, operator, mint, vault, treasury, coin, market, house_usdc,
            now: 1_700_000_000,
        };
        b.warp(0);
        b.init();
        b
    }

    fn warp(&mut self, by: i64) {
        // A new blockhash too: two identical transactions a second apart are
        // the same transaction as far as the ledger is concerned.
        self.svm.expire_blockhash();
        self.now += by;
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = self.now;
        self.svm.set_sysvar(&clock);
    }

    fn operator_key(&self) -> Pubkey {
        Pubkey::new_from_array(self.operator.verifying_key().to_bytes())
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let payer = signers[0].pubkey();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
            .map_err(|e| e.to_string())?;
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }

    fn init(&mut self) {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &vault_sol::instruction::Initialize {
                operator: self.operator_key(),
                open_fee_bps: 10,
                funding_bps_per_hour: 1,
            }.data(),
            vault_sol::accounts::Initialize {
                owner: self.house.pubkey(), vault: self.vault, mint: self.mint,
                treasury: self.treasury, token_program: SPL_TOKEN,
                system_program: system_program::ID,
            }.to_account_metas(None),
        );
        let house = self.house.insecure_clone();
        self.send(&[ix], &[&house]).expect("initialize");
    }

    fn fund(&mut self, amount: u64) {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &vault_sol::instruction::Fund { amount }.data(),
            vault_sol::accounts::Fund {
                funder: self.house.pubkey(), vault: self.vault, treasury: self.treasury,
                from: self.house_usdc, mint: self.mint, token_program: SPL_TOKEN,
            }.to_account_metas(None),
        );
        let house = self.house.insecure_clone();
        self.send(&[ix], &[&house]).expect("fund");
    }

    fn set_market(&mut self, max_margin: u64, max_notional: u64, max_leverage: u8, live: bool) {
        self.set_market_with(max_margin, max_notional, max_leverage, 5, live);
    }

    fn set_market_with(&mut self, max_margin: u64, max_notional: u64, max_leverage: u8,
                       payout_mult: u8, live: bool) {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &vault_sol::instruction::SetMarket {
                token: self.coin, max_margin, max_notional, max_leverage, payout_mult, live,
            }.data(),
            vault_sol::accounts::SetMarket {
                owner: self.house.pubkey(), vault: self.vault, market: self.market,
                system_program: system_program::ID,
            }.to_account_metas(None),
        );
        let house = self.house.insecure_clone();
        self.send(&[ix], &[&house]).expect("set_market");
    }

    fn price_ix(&self, value: u128, at: i64, key: Option<&SigningKey>, coin: Option<Pubkey>) -> Instruction {
        let msg = vault_sol::price::message_for(
            &self.vault, &coin.unwrap_or(self.coin), value, at);
        ed25519_ix(key.unwrap_or(&self.operator), &msg)
    }

    fn vault_state(&self) -> vault_sol::state::Vault {
        let acc = self.svm.get_account(&self.vault).unwrap();
        let mut data: &[u8] = &acc.data;
        vault_sol::state::Vault::try_deserialize(&mut data).unwrap()
    }

    fn next_id(&self) -> u64 { self.vault_state().next_id }

    fn position_pda(&self, id: u64) -> Pubkey {
        Pubkey::find_program_address(&[b"position", &id.to_le_bytes()], &program_id()).0
    }

    fn open(&mut self, trader: &Keypair, usdc: Pubkey, margin: u64, leverage: u8, is_long: bool,
            price: u128) -> Result<u64, String> {
        let id = self.next_id();
        let at = self.now;
        let ix = Instruction::new_with_bytes(
            program_id(),
            &vault_sol::instruction::Open {
                id, token: self.coin, margin, leverage, is_long,
                price_value: price, price_at: at,
            }.data(),
            vault_sol::accounts::Open {
                trader: trader.pubkey(), vault: self.vault, market: self.market,
                position: self.position_pda(id), from: usdc, treasury: self.treasury,
                mint: self.mint, instructions: IX_SYSVAR, token_program: SPL_TOKEN,
                system_program: system_program::ID,
            }.to_account_metas(None),
        );
        self.send(&[self.price_ix(price, at, None, None), ix], &[trader]).map(|_| id)
    }

    fn settle(&mut self, caller: &Keypair, trader: &Keypair, usdc: Pubkey, id: u64, price: u128,
              liquidation: bool) -> Result<(), String> {
        let at = self.now;
        let accounts = vault_sol::accounts::Settle {
            caller: caller.pubkey(), trader: trader.pubkey(), vault: self.vault,
            market: self.market, position: self.position_pda(id), treasury: self.treasury,
            to: usdc, mint: self.mint, instructions: IX_SYSVAR, token_program: SPL_TOKEN,
        }.to_account_metas(None);
        let data = if liquidation {
            vault_sol::instruction::Liquidate { price_value: price, price_at: at }.data()
        } else {
            vault_sol::instruction::Close { price_value: price, price_at: at }.data()
        };
        let ix = Instruction::new_with_bytes(program_id(), &data, accounts);
        self.send(&[self.price_ix(price, at, None, None), ix], &[caller])
    }

    fn trader(&mut self, usdc: u64) -> (Keypair, Pubkey) {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let acc = token_account(&mut self.svm, &self.mint, &kp.pubkey(), usdc);
        (kp, acc)
    }

    fn ready() -> Self {
        let mut b = Bench::new();
        b.fund(10_000 * USD);
        b.set_market(25 * USD, 2_500 * USD, 5, true);
        b
    }
}

/* ---------------------------------------------------------- the money */

#[test]
fn long_in_profit_pays_out() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let before = balance_of(&b.svm, &usdc);

    let id = b.open(&alice, usdc, 10 * USD, 2, true, P1).expect("open");
    b.warp(60);
    b.settle(&alice, &alice, usdc, id, P1 * 11 / 10, false).expect("close");

    let gained = balance_of(&b.svm, &usdc) - before + 0;
    // $10 margin less a 0.1%-of-notional fee, 2x, +10% => about +$1.99
    assert!(gained > 0, "a winning long should come back with more, got {}", gained);
    assert!((1_900_000..2_100_000).contains(&gained), "unexpected payout {}", gained);
    assert_eq!(b.vault_state().liabilities, 0);
}

#[test]
fn short_profits_when_the_price_falls() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let before = balance_of(&b.svm, &usdc);
    let id = b.open(&alice, usdc, 10 * USD, 3, false, P1).expect("open");
    b.settle(&alice, &alice, usdc, id, P1 * 9 / 10, false).expect("close");
    assert!(balance_of(&b.svm, &usdc) > before, "a short should profit on the way down");
}

#[test]
fn a_loss_comes_out_of_the_margin() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let before = balance_of(&b.svm, &usdc);
    let id = b.open(&alice, usdc, 10 * USD, 2, true, P1).expect("open");
    b.settle(&alice, &alice, usdc, id, P1 * 95 / 100, false).expect("close");
    let after = balance_of(&b.svm, &usdc);
    assert!(after < before, "a losing long should come back with less");
    assert!(after > before - 10 * USD, "but not with nothing");
}

#[test]
fn profit_is_capped_at_five_times_the_margin() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let before = balance_of(&b.svm, &usdc);
    let id = b.open(&alice, usdc, 10 * USD, 5, true, P1).expect("open");
    b.settle(&alice, &alice, usdc, id, P1 * 100, false).expect("close");
    let gained = balance_of(&b.svm, &usdc) - before;
    assert!(gained <= 40 * USD, "profit above 4x the margin is not owed, got {}", gained);
    assert!(gained > 39 * USD, "but the cap itself should pay, got {}", gained);
}

/* ------------------------------------------------------- the solvency */

#[test]
fn the_house_cannot_withdraw_what_positions_need() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    b.open(&alice, usdc, 25 * USD, 5, true, P1).expect("open");

    let held = balance_of(&b.svm, &b.treasury);
    let owed = b.vault_state().liabilities;
    assert!(owed > 0, "an open position must be owed something");

    let too_much = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::Defund { amount: held - owed + 1 }.data(),
        vault_sol::accounts::Defund {
            owner: b.house.pubkey(), vault: b.vault, treasury: b.treasury,
            to: b.house_usdc, mint: b.mint, token_program: SPL_TOKEN,
        }.to_account_metas(None),
    );
    let house = b.house.insecure_clone();
    assert!(b.send(&[too_much], &[&house]).is_err(), "the surplus is the limit");

    let exactly = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::Defund { amount: held - owed }.data(),
        vault_sol::accounts::Defund {
            owner: b.house.pubkey(), vault: b.vault, treasury: b.treasury,
            to: b.house_usdc, mint: b.mint, token_program: SPL_TOKEN,
        }.to_account_metas(None),
    );
    b.send(&[exactly], &[&house]).expect("the surplus itself is allowed");

    // and the position still pays in full
    b.settle(&alice, &alice, usdc, 1, P1 * 3, false).expect("the win is still payable");
    assert_eq!(b.vault_state().liabilities, 0);
}

#[test]
fn an_open_is_refused_when_the_vault_could_not_cover_it() {
    let mut b = Bench::new();
    b.fund(50 * USD);                        // not enough for a $25 position's best case
    b.set_market(25 * USD, 2_500 * USD, 5, true);
    let (alice, usdc) = b.trader(1_000 * USD);
    assert!(b.open(&alice, usdc, 25 * USD, 5, true, P1).is_err(),
        "the vault must refuse what it could not pay");
}

/* ----------------------------------------------------------- the caps */

#[test]
fn the_caps_are_enforced() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    assert!(b.open(&alice, usdc, 26 * USD, 2, true, P1).is_err(), "margin cap");
    assert!(b.open(&alice, usdc, 10 * USD, 6, true, P1).is_err(), "leverage cap");
    b.set_market(25 * USD, 100 * USD, 5, true);
    b.open(&alice, usdc, 20 * USD, 5, true, P1).expect("fits exactly");
    assert!(b.open(&alice, usdc, 20 * USD, 5, true, P1).is_err(), "the book is full");
}

#[test]
fn a_closed_market_takes_nothing() {
    let mut b = Bench::ready();
    b.set_market(25 * USD, 2_500 * USD, 5, false);
    let (alice, usdc) = b.trader(1_000 * USD);
    assert!(b.open(&alice, usdc, 10 * USD, 2, true, P1).is_err());
}

/* --------------------------------------------------- the liquidation */

#[test]
fn a_stranger_may_liquidate_and_the_margin_stays() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let (bob, _) = b.trader(0);
    let id = b.open(&alice, usdc, 10 * USD, 5, true, P1).expect("open");
    let after_open = balance_of(&b.svm, &usdc);

    b.settle(&bob, &alice, usdc, id, P1 * 80 / 100, true).expect("liquidate");
    assert_eq!(balance_of(&b.svm, &usdc), after_open, "a liquidated position pays nothing");
    assert_eq!(b.vault_state().liabilities, 0);
}

#[test]
fn a_healthy_position_cannot_be_liquidated() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let (bob, _) = b.trader(0);
    let id = b.open(&alice, usdc, 10 * USD, 2, true, P1).expect("open");
    assert!(b.settle(&bob, &alice, usdc, id, P1 * 95 / 100, true).is_err());
}

#[test]
fn only_the_trader_closes_their_own_position() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let (bob, _) = b.trader(0);
    let id = b.open(&alice, usdc, 10 * USD, 2, true, P1).expect("open");
    assert!(b.settle(&bob, &alice, usdc, id, P1, false).is_err(), "bob is not alice");
}

/* --------------------------------------------------------- the price */

#[test]
fn only_the_operators_signature_is_accepted() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let impostor = SigningKey::from_bytes(&[9u8; 32]);
    let id = b.next_id();
    let at = b.now;
    let ix = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::Open {
            id, token: b.coin, margin: 10 * USD, leverage: 2, is_long: true,
            price_value: P1, price_at: at,
        }.data(),
        vault_sol::accounts::Open {
            trader: alice.pubkey(), vault: b.vault, market: b.market,
            position: b.position_pda(id), from: usdc, treasury: b.treasury, mint: b.mint,
            instructions: IX_SYSVAR, token_program: SPL_TOKEN,
            system_program: system_program::ID,
        }.to_account_metas(None),
    );
    let forged = b.price_ix(P1, at, Some(&impostor), None);
    assert!(b.send(&[forged, ix], &[&alice]).is_err(), "somebody else's signature is not a price");
}

#[test]
fn a_price_for_another_coin_is_refused() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let id = b.next_id();
    let at = b.now;
    let ix = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::Open {
            id, token: b.coin, margin: 10 * USD, leverage: 2, is_long: true,
            price_value: P1, price_at: at,
        }.data(),
        vault_sol::accounts::Open {
            trader: alice.pubkey(), vault: b.vault, market: b.market,
            position: b.position_pda(id), from: usdc, treasury: b.treasury, mint: b.mint,
            instructions: IX_SYSVAR, token_program: SPL_TOKEN,
            system_program: system_program::ID,
        }.to_account_metas(None),
    );
    let elsewhere = b.price_ix(P1, at, None, Some(Pubkey::new_unique()));
    assert!(b.send(&[elsewhere, ix], &[&alice]).is_err());
}

#[test]
fn a_stale_price_is_refused() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let id = b.next_id();
    let at = b.now;
    let price = b.price_ix(P1, at, None, None);
    b.warp(121);
    let ix = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::Open {
            id, token: b.coin, margin: 10 * USD, leverage: 2, is_long: true,
            price_value: P1, price_at: at,
        }.data(),
        vault_sol::accounts::Open {
            trader: alice.pubkey(), vault: b.vault, market: b.market,
            position: b.position_pda(id), from: usdc, treasury: b.treasury, mint: b.mint,
            instructions: IX_SYSVAR, token_program: SPL_TOKEN,
            system_program: system_program::ID,
        }.to_account_metas(None),
    );
    assert!(b.send(&[price, ix], &[&alice]).is_err(), "two minutes is the whole life of a price");
}

/* -------------------------------------------------------- the escape */

#[test]
fn silence_lets_the_trader_out() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let id = b.open(&alice, usdc, 10 * USD, 3, true, P1).expect("open");
    let after_open = balance_of(&b.svm, &usdc);

    let out = |b: &Bench| Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::CloseStale {}.data(),
        vault_sol::accounts::CloseStale {
            trader: alice.pubkey(), vault: b.vault, market: b.market,
            position: b.position_pda(id), treasury: b.treasury, to: usdc, mint: b.mint,
            token_program: SPL_TOKEN,
        }.to_account_metas(None),
    );

    let early = out(&b);
    assert!(b.send(&[early], &[&alice]).is_err(), "not stale yet");

    b.warp(3_601);
    let late = out(&b);
    b.send(&[late], &[&alice]).expect("an hour of silence is the way out");

    // the margin comes back whole; the fee was taken at open
    assert_eq!(balance_of(&b.svm, &usdc) - after_open, 10 * USD - 30_000);
    assert_eq!(b.vault_state().liabilities, 0);
}

#[test]
fn a_fresh_price_keeps_the_market_alive() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let id = b.open(&alice, usdc, 10 * USD, 3, true, P1).expect("open");

    b.warp(3_500);
    let at = b.now;
    let poke = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::Poke { price_value: P1, price_at: at }.data(),
        vault_sol::accounts::Poke {
            caller: alice.pubkey(), vault: b.vault, market: b.market, instructions: IX_SYSVAR,
        }.to_account_metas(None),
    );
    let price = b.price_ix(P1, at, None, None);
    b.send(&[price, poke], &[&alice]).expect("poke");

    b.warp(1_000);
    let early = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::CloseStale {}.data(),
        vault_sol::accounts::CloseStale {
            trader: alice.pubkey(), vault: b.vault, market: b.market,
            position: b.position_pda(id), treasury: b.treasury, to: usdc, mint: b.mint,
            token_program: SPL_TOKEN,
        }.to_account_metas(None),
    );
    assert!(b.send(&[early], &[&alice]).is_err(), "a poked market is not abandoned");
}

/* --------------------------------------------------------- the rules */

#[test]
fn funding_is_charged_for_the_time_the_position_was_open() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let before = balance_of(&b.svm, &usdc);
    let id = b.open(&alice, usdc, 10 * USD, 5, true, P1).expect("open");
    b.warp(10 * 3_600);
    b.settle(&alice, &alice, usdc, id, P1, false).expect("close");
    let back = balance_of(&b.svm, &usdc);
    // the margin, less the open fee and ten hours of funding on ~$49.75
    assert!(back < before, "funding is paid even when the price has not moved");
    assert!(before - back < 200_000, "but it is cents, not dollars");
}

#[test]
fn pausing_stops_opening_and_not_closing() {
    let mut b = Bench::ready();
    let (alice, usdc) = b.trader(1_000 * USD);
    let id = b.open(&alice, usdc, 10 * USD, 2, true, P1).expect("open");

    let pause = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::SetConfig {
            operator: None, open_fee_bps: None, funding_bps_per_hour: None,
            paused: Some(true), new_owner: None,
        }.data(),
        vault_sol::accounts::SetConfig { owner: b.house.pubkey(), vault: b.vault }
            .to_account_metas(None),
    );
    let house = b.house.insecure_clone();
    b.send(&[pause], &[&house]).expect("pause");

    assert!(b.open(&alice, usdc, 10 * USD, 2, true, P1).is_err(), "paused means no new positions");
    b.settle(&alice, &alice, usdc, id, P1, false).expect("but open ones still close");
}

#[test]
fn only_the_owner_runs_the_vault() {
    let mut b = Bench::ready();
    let (mallory, _) = b.trader(0);
    let ix = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::SetConfig {
            operator: Some(mallory.pubkey()), open_fee_bps: None,
            funding_bps_per_hour: None, paused: None, new_owner: Some(mallory.pubkey()),
        }.data(),
        vault_sol::accounts::SetConfig { owner: mallory.pubkey(), vault: b.vault }
            .to_account_metas(None),
    );
    assert!(b.send(&[ix], &[&mallory]).is_err(), "the vault has one owner");
}

#[test]
fn fees_have_a_ceiling() {
    let mut b = Bench::ready();
    let house = b.house.insecure_clone();
    let too_much = Instruction::new_with_bytes(
        program_id(),
        &vault_sol::instruction::SetConfig {
            operator: None, open_fee_bps: Some(101), funding_bps_per_hour: None,
            paused: None, new_owner: None,
        }.data(),
        vault_sol::accounts::SetConfig { owner: b.house.pubkey(), vault: b.vault }
            .to_account_metas(None),
    );
    assert!(b.send(&[too_much], &[&house]).is_err());
}

/* The one place two languages have to agree byte for byte: what the operator
   signs. The hex below came out of the price service (site/api/price.mjs) for
   the same inputs; if either side's layout drifts, this fails here rather
   than as an unexplained rejection on mainnet. */
#[test]
fn the_signed_message_matches_the_price_service() {
    let vault = Pubkey::default(); // 1111...
    let coin: Pubkey = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263".parse().unwrap();
    let msg = vault_sol::price::message_for(&vault, &coin, 3_700_000_000_000u128, 1_700_000_000i64);
    let hex: String = msg.iter().map(|b| format!("{:02x}", b)).collect();
    assert_eq!(
        hex,
        "786565742d70726963652d76310000000000000000000000000000000000000000000000000000000000000000\
bc07c56e60ad3d3f177382eac6548fba1fd32cfd90ca02b3e7cfa185fdce739800882f795d030000000000000000000000\
f1536500000000"
    );
}

/* The constraint a real $60 vault runs into, and the answer to it. */
#[test]
fn a_small_vault_lowers_the_ceiling_instead_of_refusing_the_trade() {
    let mut b = Bench::new();
    b.fund(60 * USD);
    let (alice, usdc) = b.trader(1_000 * USD);

    // At 5x the promise on a $25 position is $125 and the vault holds $85.
    b.set_market_with(25 * USD, 2_500 * USD, 5, 5, true);
    assert!(b.open(&alice, usdc, 25 * USD, 2, true, P1).is_err(),
        "a vault that cannot cover the promise must not take the position");

    // At 3x the promise is $75, which $60 plus the margin covers.
    b.warp(1);                      // a different blockhash, or it is the same transaction
    b.set_market_with(25 * USD, 2_500 * USD, 5, 3, true);
    let id = b.open(&alice, usdc, 25 * USD, 2, true, P1).expect("$60 backs this one");

    let before = balance_of(&b.svm, &usdc);
    b.settle(&alice, &alice, usdc, id, P1 * 10, false).expect("close into the ceiling");
    let gained = balance_of(&b.svm, &usdc) - before;
    // the ceiling is three times the margin, of which one is the margin back
    assert!(gained <= 75 * USD && gained > 74 * USD, "paid {}", gained);
    assert_eq!(b.vault_state().liabilities, 0);
}

/* A market whose ceiling is raised later must not reach back into positions
   that were opened under the old one — in either direction. */
#[test]
fn a_position_keeps_the_ceiling_it_was_opened_under() {
    let mut b = Bench::ready();
    b.set_market_with(25 * USD, 2_500 * USD, 5, 2, true);
    let (alice, usdc) = b.trader(1_000 * USD);
    let id = b.open(&alice, usdc, 10 * USD, 2, true, P1).expect("open at 2x payout");

    b.set_market_with(25 * USD, 2_500 * USD, 5, 10, true);   // raised afterwards
    let before = balance_of(&b.svm, &usdc);
    b.settle(&alice, &alice, usdc, id, P1 * 50, false).expect("close");
    let gained = balance_of(&b.svm, &usdc) - before;
    assert!(gained <= 20 * USD, "the old ceiling still applies, got {}", gained);
}

#[test]
fn the_payout_multiple_has_bounds() {
    let mut b = Bench::new();
    let house = b.house.insecure_clone();
    for bad in [1u8, 11u8] {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &vault_sol::instruction::SetMarket {
                token: b.coin, max_margin: 25 * USD, max_notional: 2_500 * USD,
                max_leverage: 5, payout_mult: bad, live: true,
            }.data(),
            vault_sol::accounts::SetMarket {
                owner: b.house.pubkey(), vault: b.vault, market: b.market,
                system_program: system_program::ID,
            }.to_account_metas(None),
        );
        assert!(b.send(&[ix], &[&house]).is_err(), "{} is not a payout multiple", bad);
    }
}
