# The Xeet vault, on Solana

Leverage on coins no exchange will list, with this vault as the counterparty
to every position in it.

## What it is

A trader opens a small leveraged position on a memecoin; the house — whoever
funded the vault — takes the other side. No order book, no other side to find,
and the coin itself is never held: a position is USDC margin settled against a
price.

## Why it is shaped like this

A perp on a two-hour-old coin is a cheque written to whoever can move its pool.
Moving a $20K pool ten percent costs about $500, so any product where a ten
percent move pays out more than that is funding its own attacker. Every number
in the program exists to keep the most the book can pay under the cost of
moving the price it settles against:

- a position's payout is capped at **5x its margin**, so the house's liability
  is a number and not a hope;
- margin per position and open notional per coin are capped, both set from the
  pool's own depth;
- every open position is **pre-funded** — the vault refuses to open one it
  could not pay in full, and the owner may only withdraw what is left after
  all of them are covered;
- and if the operator who signs prices goes quiet, every trader walks out with
  their margin an hour later without asking anybody.

## The price, and the honest part

Solana cannot see a memecoin's dollar price, so an operator signs it and the
program verifies that the runtime's own ed25519 precompile checked exactly
those bytes with exactly that key, in the same transaction. That is a trust
assumption and the product says so out loud — bounded in both directions: a
price is usable for two minutes, and silence is an exit, not a trap. The
operator can stop this venue; the operator cannot keep a dollar in it.

## Tests

    cargo-build-sbf --manifest-path programs/vault-sol/Cargo.toml
    cargo test

21 tests in a real SVM (litesvm) against the real program binary, precompiles
included — including one that asserts the signed message is byte-for-byte what
`site/api/price.mjs` produces, so the two languages cannot drift apart.

## Deploying

    solana program deploy target/deploy/vault_sol.so

Costs about **4.8 SOL** of rent for a 343KB program (reclaimable by closing the
program later). Then, in order: `initialize` (operator pubkey, fees), `fund`
(the capital), and `set_market` per coin with caps taken from its pool depth.

The owner key moves the capital and belongs nowhere near a server. The operator
key signs prices every minute and lives on one. They must not be the same key.
