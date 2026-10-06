# The Xeet vault, for EVM chains

The Solidity version of the leverage vault — the same venue as `vault-sol/`,
for coins on EVM chains (Robinhood Chain first, settling in USDG).

A one-sided venue: traders open small leveraged positions on a coin, and the
house that funded the contract is the counterparty to all of them. No order
book, and the coin itself is never held — a position is margin settled
against a price.

- Payout is capped at `PAYOUT_CAP` times the margin, so the house's liability
  is a number rather than a hope.
- Margin per position and open notional per market are capped, set from the
  pool's own depth.
- Every open position is pre-funded: `open` refuses a position the contract
  could not pay in full, and `defund` can only take what is left after all of
  them are covered.
- Prices are EIP-712 signatures from an operator, usable for two minutes. If
  the operator goes quiet for an hour, `closeStale` returns every trader's
  margin without anybody's permission.

## Build and test

`forge-std` is not vendored. Before the first build:

    forge install foundry-rs/forge-std --no-git
    forge test

28 tests, including a solvency invariant: whatever sequence of opens, closes,
liquidations, price moves and withdrawals the fuzzer tries, the contract
always holds enough to pay every open position in full.

## Deploy

    OPERATOR=<price signer> forge script script/Deploy.s.sol \
      --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --private-key <owner>

The owner key moves the capital and does not belong on a server; the operator
key signs prices and does. They must not be the same key.
