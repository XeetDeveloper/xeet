# The venue, on your laptop, for nothing

```bash
./local/run.sh                      # validator + price service + the whole setup
node local/trade.mjs long 25 2      # $25 of margin, 2x, long $XEET
node local/trade.mjs list
node local/trade.mjs close 1
./local/run.sh stop
```

The default setup is a $60 vault and a $25 ceiling per position, which is the
smallest thing worth running. `HOUSE_CAPITAL`, `MAX_MARGIN`, `MAX_LEVERAGE`
and `PAYOUT_MULT` change it.

## The ceiling, and why $60 cannot promise 5x

The vault refuses to open a position it could not pay in full, so the most a
position may win is a number the house has actually set aside. On a $25
position a 5x ceiling means $125 promised, and a vault holding $60 plus that
$25 of margin has $85. The honest answer is a lower ceiling rather than a
refused trade, so the multiple is set per market: with $60 behind it, this one
pays up to **3x the margin** — your $25 back plus $50, which is $XEET
doubling at 2x. Put more in and it rises.

A position keeps the ceiling it was opened under; changing a market's cap
never reaches back into a trade somebody already took.

## What this costs: nothing, and there is nowhere to send money

- The SOL is **airdropped** by the validator running on this machine.
- The dollars are minted by a six-decimal mint the setup script creates. It
  stands in for USDC and nobody has to buy any.
- The program is loaded **at genesis** (`--bpf-program`) instead of deployed,
  so the ~4.8 SOL a mainnet deploy costs is not spent and not needed.

## What is real anyway

- the same program binary the tests run and mainnet would run;
- the live price of the coin, read off its own pools and signed by the
  operator, with the ed25519 precompile verifying it exactly as it would on
  mainnet;
- a position is a signed transaction that moves tokens, settles, liquidates
  and pays out.

A whole trade, as it actually ran here:

```
LONG #1 open
  margin     $24.95 (of $25.00, the rest was the fee)
  leverage   2x  →  $49.90 of exposure
  entry      $0.00002279  (1 pools, $14,046 deep)
  liquidated near $0.00001253
  most it can pay  $74.85 (3x the margin)
… the coin runs 30% …
#1  LONG  $24.95  2x  entry $0.00002279  +$12.04 → $36.99
closed #1 at $0.00002829 — $36.99 back
you $111.99 · vault $48.01
```

## Testing a move the market will not give you

`PRICE_AT` makes the operator sign a price you chose, so a win, a loss and a
liquidation can all be tried in a minute:

```bash
PRICE_AT=0.00003046 node local/trade.mjs list     # as if it ran 40%
PRICE_AT=0.00001080 node local/trade.mjs close 1  # as if it halved: liquidated
```

This only works because `run.sh` sets `XEET_PRICE_OVERRIDE=1`. The deployed
service never does — one that signs whatever it is handed is not an oracle,
it is a faucet for anybody who can reach it.

## The keys

`local/.keys.json` holds three seeds, generated on first run and git-ignored:
the **house** (owns the vault and its capital), the **operator** (signs
prices), and **you** (trades). On mainnet those first two must not be the same
key: the operator's lives on a server because it signs every minute, and the
owner's moves the money.

## One person cannot be both sides of a bet

Worth saying plainly, because the mechanics work so well that it is easy to
forget: when the same person funds the vault and takes the position, the
money moves from one of their pockets to the other. The $60 and the $25 are
both yours, and whatever the position wins the vault loses, minus the fee. It
is a faithful dress rehearsal — real program, real price, real transactions —
and it is not a bet.

A real 2x long on a coin like this, for one person, means borrowing: put up
collateral on a lending protocol, borrow the second $25, and buy $50 of the
coin spot. No program and no deploy, and the leverage is real because the
lender is somebody else.

## If you ever want the vault itself on mainnet

- **~2.1 SOL** of rent with `--max-len` at the program's exact size, or ~4.3
  with room to upgrade. It is a deposit, not a cost: `solana program close`
  gives it back.
- Enough USDC behind each position to honour its ceiling — $50 of house money
  per $25 position at 3x.
- The caps here are a laptop's. On the live $XEET pool, about $14K deep,
  **$25 a position** is also the honest mainnet cap: moving that pool ten
  percent costs around $340, and the book must never be able to pay more.
