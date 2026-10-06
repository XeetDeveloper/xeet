/* Xeet — the one registry every other file reads.
 *
 * A chain is only listed here if all four questions have an answer: what
 * Dexscreener calls it, what GeckoTerminal calls it, how to read a balance,
 * and who builds the trade. A chain with no router is VIEW ONLY, and the panel
 * says so rather than offering a button that cannot work. */

(function (g) {
  "use strict";

  // 0.5% — one number, every chain. Both routers take it as an integrator
  // fee; neither can be applied without a collection address, so a deployment
  // with no FEE_ACCOUNT routes at cost rather than silently pretending.
  const FEE_BPS = 50;

  const FEE = {
    bps: FEE_BPS,
    pct: FEE_BPS / 10000,
    // How the fee is written wherever it is shown.
    label: (FEE_BPS / 100).toFixed(2).replace(/\.?0+$/, "") + "%",
    /* WHERE THE FEE GOES. Both blank by default, and blank means the build
       charges nothing — which is the truthful state until these are set up.
       Neither can be a plain wallet address; both are accounts you create.

       solanaFeeAccount — a REFERRAL TOKEN ACCOUNT from referral.jup.ag, not a
       wallet. Create a referral account there with your wallet, then create a
       token account for each mint you want to be paid in (the fee is taken in
       the token being bought, so SOL/wSOL and USDC cover most of it). Pasting
       a wallet address here does not fail loudly: Jupiter's API accepts it and
       returns a transaction that then reverts on chain with error 6025. The
       worker checks the account against each output mint before using it and
       routes without a fee when it does not match, so a wrong value here costs
       revenue rather than trades.

       evmIntegrator / evmFeeConfigured — LI.FI pays the wallet registered for
       this integrator at portal.li.fi. Registered and verified against live
       quotes: with the fee asked for, the output drops 0.501% on Robinhood
       Chain, Base and Ethereum alike, which is the cut arriving rather than
       merely an error going away. LI.FI reports its own 0.25% and this 0.5%
       as one combined line, so the quote alone does not prove it — the
       comparison against a fee-less quote does.

       No API key is carried here on purpose. A key shipped inside an extension
       is a key published: anyone can unzip it and spend the quota. The
       integrator string is not a secret; the key is, and it belongs on a
       server, which this product deliberately does not have. */
    /* Where the fee lands on Solana: a WRAPPED-SOL token account, owned by
       ERnrRUY327iFGyiA11rj2DruaqkbAjsArVLMc7DZ3FNz.

       One account, not one per token, because Jupiter takes the fee on
       whichever side of the swap this account's mint appears — verified by
       simulation against mainnet, both directions. Buys pay in SOL and sells
       receive it, so wrapped SOL is on one side of essentially every trade
       here. A per-output-mint account would have meant creating one for every
       memecoin anybody ever bought.

       Not an associated token account: Jupiter accepts any token account of
       the right mint, and a plain one needed no program-derived address to
       create. */
    solanaFeeAccount: "ANzsyQakr8ASHHKfRkiuLtELhhQ2ZPnAxyEP6JFdqqyW",
    evmIntegrator: "xeet",
    evmFeeConfigured: true,
    // Where LI.FI should pay out, once the integrator above is registered at
    // portal.li.fi. Recorded here so the two halves live in one place.
    evmFeeWallet: "0x3d53924b10089642906404349a5f46e7dafc7d20",
  };

  const CHAINS = {
    solana: {
      key: "solana", name: "Solana", kind: "svm",
      ds: "solana", gt: "solana",
      native: { symbol: "SOL", decimals: 9, mint: "So11111111111111111111111111111111111111112" },
      rpc: "https://solana-rpc.publicnode.com",
      explorer: "https://solscan.io/tx/",
      stables: [{ symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }],
      router: "jupiter",
    },
    ethereum: {
      key: "ethereum", name: "Ethereum", kind: "evm", id: 1,
      ds: "ethereum", gt: "eth",
      native: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://ethereum-rpc.publicnode.com",
      explorer: "https://etherscan.io/tx/",
      stables: [{ symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }, { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }],
      router: "lifi",
    },
    base: {
      key: "base", name: "Base", kind: "evm", id: 8453,
      ds: "base", gt: "base",
      native: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://base-rpc.publicnode.com",
      explorer: "https://basescan.org/tx/",
      stables: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }],
      router: "lifi",
    },
    arbitrum: {
      key: "arbitrum", name: "Arbitrum", kind: "evm", id: 42161,
      ds: "arbitrum", gt: "arbitrum",
      native: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://arbitrum-one-rpc.publicnode.com",
      explorer: "https://arbiscan.io/tx/",
      stables: [{ symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }, { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 }],
      router: "lifi",
    },
    optimism: {
      key: "optimism", name: "Optimism", kind: "evm", id: 10,
      ds: "optimism", gt: "optimism",
      native: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://optimism-rpc.publicnode.com",
      explorer: "https://optimistic.etherscan.io/tx/",
      stables: [{ symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 }],
      router: "lifi",
    },
    polygon: {
      key: "polygon", name: "Polygon", kind: "evm", id: 137,
      ds: "polygon", gt: "polygon_pos",
      native: { symbol: "POL", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://polygon-bor-rpc.publicnode.com",
      explorer: "https://polygonscan.com/tx/",
      stables: [{ symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 }],
      router: "lifi",
    },
    bsc: {
      key: "bsc", name: "BNB Chain", kind: "evm", id: 56,
      ds: "bsc", gt: "bsc",
      native: { symbol: "BNB", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://bsc-rpc.publicnode.com",
      explorer: "https://bscscan.com/tx/",
      stables: [{ symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 }, { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 }],
      router: "lifi",
    },
    avalanche: {
      key: "avalanche", name: "Avalanche", kind: "evm", id: 43114,
      ds: "avalanche", gt: "avax",
      native: { symbol: "AVAX", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://avalanche-c-chain-rpc.publicnode.com",
      explorer: "https://snowtrace.io/tx/",
      stables: [{ symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 }],
      router: "lifi",
    },
    abstract: {
      key: "abstract", name: "Abstract", kind: "evm", id: 2741,
      ds: "abstract", gt: "abstract",
      native: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://api.mainnet.abs.xyz",
      explorer: "https://abscan.org/tx/",
      stables: [],
      router: "lifi",
    },
    robinhood: {
      key: "robinhood", name: "Robinhood Chain", kind: "evm", id: 4663,
      // BOTH SLUGS VERIFIED AGAINST THE LIVE INDEXES, because guessing them
      // fails silently: Dexscreener calls this chain "robinhood", and the
      // registry said "robinhoodchain", so every Robinhood Chain token was
      // dropped by the chain filter and $PONS resolved to a pump.fun copy on
      // Solana instead of the real one.
      ds: "robinhood", gt: "robinhood",
      native: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      explorer: "https://explorer.mainnet.chain.robinhood.com/tx/",
      stables: [{ symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 }],
      router: "lifi",
    },
  };

  // Dexscreener's chainId is the join key for everything the panel shows.
  const BY_DS = {};
  for (const k in CHAINS) BY_DS[CHAINS[k].ds] = CHAINS[k];

  // GeckoTerminal's network slug is the join key for the fallback resolver.
  const BY_GT = {};
  for (const k in CHAINS) BY_GT[CHAINS[k].gt] = CHAINS[k];

  /* The venue for coins no exchange will list: a vault on Robinhood Chain
     that is the counterparty to every position in it. Empty until it is
     deployed — and while it is empty the panel says leverage is not live on
     these coins rather than pretending with paper positions.
     The contract and its tests are in vault/ at the root of this repo. */
  const VAULT = {
    chain: "robinhood",
    address: "",                                    // XeetVault, after deploy
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",   // 6 decimals, verified on chain 4663
    price: "https://xeet.click/api/price",          // the operator's signing service
  };

  /* The same venue on Solana, where the coins the panel actually sees live.
     `rpc`, `mint` and `vault` are filled in by whichever deployment is being
     used — vault-sol/local/wire-extension.sh writes the local one in, which is
     how a laptop run is driven from the panel itself. Empty means not live,
     and the panel says so rather than pretending. */
  const SVAULT = {
    chain: "solana",
    program: "EHwwa3q9WQd3s5NzWvUZjk83zuCyApDbXep6DPEjyMzx",
    rpc: "",                                 /* local-rpc */
    mint: "",                                /* local-mint */
    price: "https://xeet.click/api/price",   /* local-price */
  };

  const DEFAULTS = {
    on: true,
    slippageBps: 100,          // 1%
    buyPresets: [25, 50, 100], // USD
    // Positions are their own sizes: nobody opens leverage in the amount they
    // buy spot with, and a shared list made one of the two wrong.
    perpPresets: [5, 10, 25],  // USD of margin
    perpLeverage: 2,
  // Which face the deck opens on. Remembered rather than reset, because
  // somebody trading leverage is trading leverage all evening, and making
  // them tap PERPS again on every coin is the interface disagreeing with
  // what they are plainly doing.
  lastFace: "spot",
    sellPresets: [25, 50, 100],// percent of position
    hoverDelay: 130,           // ms before the panel opens
    scanCashtags: true,
    scanAddresses: true,
  };

  const API = {
    dsTokens: "https://api.dexscreener.com/latest/dex/tokens/",
    dsSearch: "https://api.dexscreener.com/latest/dex/search?q=",
    dsPairs: "https://api.dexscreener.com/latest/dex/pairs/",
    dsBoosts: "https://api.dexscreener.com/token-boosts/top/v1",
    gt: "https://api.geckoterminal.com/api/v2",
    jup: "https://lite-api.jup.ag",
    lifi: "https://li.quest/v1",
    goplus: "https://api.gopluslabs.io/api/v1",
  };

  g.XEET_CFG = { FEE, CHAINS, BY_DS, BY_GT, DEFAULTS, API, VAULT, SVAULT };
})(typeof self !== "undefined" ? self : window);
