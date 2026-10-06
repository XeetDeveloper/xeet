# Changelog

## 1.11.0

**PERPS face.** The deck has two faces now: SPOT for amounts, PERPS for leverage — position sizes and default leverage are their own settings, and the face you used last is the one the next coin opens on.

**Perps on Hyperliquid, for tickers with a market.** Leverage is set on the exchange before every order, open positions are read back with the exchange's own entry, PnL and liquidation price, and CLOSE sends a reduce-only order for exactly what is open. Not enough margin, no account, or an order under the $10 minimum is said on the face before anything is signed.

**The vault, for coins too young for any exchange.** A Solana program (`vault-sol/`, 26 tests) and an EVM contract (`vault/`, 28 tests with a solvency invariant): capped payouts, caps from pool depth, every position pre-funded, operator-signed prices that expire in two minutes, and an exit that needs nobody's permission if the operator goes quiet. Not yet deployed to mainnet — in this build, coins without an exchange market say so instead of offering buttons.

**Trade cards.** Turn a finished trade into an image made to be posted. Real numbers from your own trade; no address, no balance.

**Fixes**
- LONG/SHORT now respond to a real mouse click (a pressed-state animation was swallowing it).
- Settings are read on every open, so sizes and the remembered face always apply.
- A position counts as opened when the chain confirms it, not when a node accepts the transaction.

**Install:** download `xeet-1.11.0.zip`, unzip, then `chrome://extensions` → Developer mode → Load unpacked → the `xeet` folder.

## 1.8.0

Perps on the post, through Hyperliquid.

## 1.6.1

First release on GitHub.
