# The venue, on your laptop, for nothing

```bash
./local/run.sh                      # validator + price service + the whole setup
node local/trade.mjs long 30 2      # $30 of margin, 2x, long $XEET
node local/trade.mjs list
node local/trade.mjs close 1
./local/run.sh stop
```

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
LONG #2 open
  margin     $29.94 (of $30.00, the rest was the fee)
  leverage   2x  →  $59.88 of exposure
  entry      $0.00002176  (1 pools, $13,678 deep)
  liquidated near $0.00001197
… the coin runs 40% …
#2  LONG  $29.94  2x  entry $0.00002176  +$23.94 → $53.88
closed #2 at $0.00003046 — $53.88 back
you $1023.82 · vault $4976.18
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

## If you ever want it on mainnet

- **~4.8 SOL** of rent to deploy a 343KB program, reclaimable by closing it.
- **~$120 of USDC** in the vault per concurrent $30 position: the payout is
  capped at five times the margin, and the vault refuses to open a position it
  could not pay in full — so $30 of yours plus $120 of the house's backs one.
- The caps here are set for a laptop ($50 a position). On the live $XEET pool
  — about $13.7K deep — the honest cap is **$25 a position**, because moving
  that pool ten percent costs around $334 and the book must never be able to
  pay more than that.
