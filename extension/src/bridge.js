/* Xeet — the wallet bridge, running in the PAGE's world.
 *
 * A content script lives in an isolated world: it can see x.com's DOM and it
 * cannot see x.com's `window`. Every wallet a person has installed announces
 * itself on that window — `window.phantom.solana`, EIP-6963 events, and so on
 * — so the only way to reach one is from inside the page.
 *
 * This file is the entire surface. It discovers wallets, connects on an
 * explicit request, and passes a prepared transaction to whichever provider
 * the user chose. It never builds a transaction, never sees a key, and never
 * acts on its own: it does nothing until the panel asks, and every ask is
 * something the user just clicked.
 *
 * The panel talks to it over window.postMessage with a namespaced envelope.
 * Messages from any other source are ignored, and nothing here is exposed on
 * `window` for the page to call. */

(() => {
  "use strict";
  const NS = "__xeet_bridge";

  /* --------------------------------------------------------------- base58 */
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58encode(bytes) {
    if (!bytes.length) return "";
    const digits = [0];
    for (let i = 0; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = "";
    for (let i = 0; bytes[i] === 0 && i < bytes.length - 1; i++) out += "1";
    for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
    return out;
  }
  function b64decode(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* A signed Solana transaction is [compact-u16 count][64-byte sigs…][message].
     Wallets want the MESSAGE, so the signature block is measured and skipped —
     the same arithmetic web3.js does, without shipping web3.js to do it. */
  function messageOf(txBytes) {
    let i = 0, count = 0, shift = 0;
    for (;;) {
      const b = txBytes[i++];
      count |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 21) throw new Error("malformed transaction");
    }
    const start = i + count * 64;
    if (start > txBytes.length) throw new Error("malformed transaction");
    return txBytes.slice(start);
  }

  /* ---------------------------------------------------- wallet discovery */
  const evm = new Map();   // rdns → { info, provider }
  const svm = new Map();   // id   → { name, icon, provider }

  function noteEvm(detail) {
    if (!detail || !detail.info || !detail.provider) return;
    evm.set(detail.info.rdns || detail.info.name, { info: detail.info, provider: detail.provider });
  }

  window.addEventListener("eip6963:announceProvider", (e) => noteEvm(e.detail));
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch { /* fine */ }

  /* The Solana Wallet Standard.
   *
   * EIP-6963 is the EVM side's way for a wallet to announce itself, icon and
   * all. Solana has its own: the page says it is ready, and every wallet calls
   * back with its name, icon and features. Without it the only Solana wallets
   * we know are the ones hardcoded below, and none of them has an icon — which
   * is why Phantom sat in the list as the letter P next to MetaMask's fox.
   *
   * Only the names and icons are taken. Connecting still goes through the
   * provider objects below, which are the paths this file already knows how to
   * sign with. */
  const standard = new Map();   // name → icon

  function registerStandard(w) {
    if (!w || !w.name) return;
    if (w.icon && /^data:image\//.test(w.icon)) standard.set(w.name, w.icon);
  }

  let standardApi = null;

  (function listenForStandardWallets() {
    const api = {
      version: "1.0.0",
      get: () => [],
      on: () => () => {},
      register: (...ws) => { ws.flat().forEach(registerStandard); return () => {}; },
    };
    standardApi = api;
    try {
      window.addEventListener("wallet-standard:register-wallet", (e) => {
        try { e.detail(api); } catch { /* a wallet that cannot introduce itself is skipped */ }
      });
      askStandard();
    } catch { /* fine — the list simply has no icons */ }
  })();

  /* Say we are ready again. A wallet already loaded when we started answers the
     first call; one that loads later announces itself. A wallet that does
     neither — loaded in between, and only ever answers — would otherwise never
     be seen, so this is repeated whenever the list is actually asked for. */
  function askStandard() {
    if (!standardApi) return;
    try {
      window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: standardApi }));
    } catch { /* nothing to do */ }
  }

  /* Phantom's own icon, whichever way it announced itself. Names are how the
     same wallet is recognised across the two standards. */
  function brandIcon(name) {
    if (standard.has(name)) return standard.get(name);
    for (const [, w] of evm) if (w.info.name === name && w.info.icon) return w.info.icon;
    return null;
  }

  function scanSvm() {
    const seen = [
      ["phantom", "Phantom", window.phantom && window.phantom.solana],
      ["solflare", "Solflare", window.solflare],
      ["backpack", "Backpack", window.backpack],
      ["glow", "Glow", window.glow],
      ["coinbase-solana", "Coinbase Wallet", window.coinbaseSolana],
    ];
    for (const [id, name, p] of seen) {
      if (p && typeof p.connect === "function") svm.set(id, { id, name, provider: p });
    }
    const generic = window.solana;
    if (generic && typeof generic.connect === "function") {
      const id = generic.isPhantom ? "phantom" : generic.isSolflare ? "solflare" : "solana";
      if (!svm.has(id)) {
        svm.set(id, { id, name: generic.isPhantom ? "Phantom" : generic.isSolflare ? "Solflare" : "Solana Wallet", provider: generic });
      }
    }
  }

  /* Naming a provider from window.ethereum.
 *
 * isMetaMask is the ONE flag that cannot be trusted: Phantom, Rabby, Coinbase,
 * OKX, Trust and most others set it true so that dapps written against
 * MetaMask keep working. Asking about it first therefore labels whichever
 * wallet grabbed window.ethereum "MetaMask" — which is how tapping MetaMask
 * connected Phantom, and how a MetaMask row appeared for somebody who does not
 * have MetaMask installed. Every specific flag is asked first; isMetaMask is
 * the last resort, and only means MetaMask once nothing else has claimed it. */
function nameOf(p) {
    if (p.isPhantom) return "Phantom";
    if (p.isRabby) return "Rabby";
    if (p.isCoinbaseWallet || p.isCoinbaseBrowser) return "Coinbase Wallet";
    if (p.isBraveWallet) return "Brave Wallet";
    if (p.isTrust || p.isTrustWallet) return "Trust Wallet";
    if (p.isOkxWallet || p.isOKExWallet) return "OKX Wallet";
    if (p.isBackpack) return "Backpack";
    if (p.isZerion) return "Zerion";
    if (p.isRainbow) return "Rainbow";
    if (p.isExodus) return "Exodus";
    if (p.isFrame) return "Frame";
    if (p.isOneInchIOSWallet || p.isOneInchAndroidWallet) return "1inch Wallet";
    if (p.isMetaMask) return "MetaMask";
    return "Browser Wallet";
  }

  function legacyEvm() {
    const eth = window.ethereum;
    if (!eth) return;
    const list = eth.providers && eth.providers.length ? eth.providers : [eth];
    for (const p of list) {
      const name = nameOf(p);
      // EIP-6963 is the wallet naming itself; window.ethereum is whatever won
      // a race for one global. When a wallet has announced itself properly,
      // its legacy shim is the same wallet twice — and the copy is the one
      // that gets the name wrong.
      const known = [...evm.values()].some((w) => w.provider === p || w.info.name === name);
      if (!known) evm.set("legacy:" + name, { info: { rdns: "legacy:" + name, name, icon: null }, provider: p });
    }
  }

  function list() {
    askStandard();
    scanSvm();
    legacyEvm();
    const out = [];
    // EIP-6963 is where a wallet hands over its own icon. Solana has no
    // equivalent here, but the wallets that do both — Phantom, Backpack,
    // Coinbase — announce the same brand on the EVM side, so a name match
    // gives the Solana entry the wallet's real icon rather than a letter.
    for (const [id, w] of svm) {
      out.push({ id: "svm:" + id, kind: "svm", name: w.name, icon: brandIcon(w.name) });
    }
    // An EVM entry that came from window.ethereum rather than EIP-6963 has no
    // icon of its own — Phantom arrives that way whenever MetaMask holds the
    // global. Fall back to whatever that same brand announced elsewhere.
    for (const [rdns, w] of evm) {
      out.push({ id: "evm:" + rdns, kind: "evm", name: w.info.name,
                 icon: w.info.icon || brandIcon(w.info.name) });
    }
    return out;
  }

  const iconFor = brandIcon;

  function pick(id) {
    const [kind, rest] = [id.slice(0, 3), id.slice(4)];
    if (kind === "svm") { scanSvm(); const w = svm.get(rest); if (w) return { kind: "svm", w }; }
    if (kind === "evm") { legacyEvm(); const w = evm.get(rest); if (w) return { kind: "evm", w }; }
    throw new Error("that wallet is no longer available");
  }

  /* ------------------------------------------------------------ the ops */
  const OPS = {
    list: () => ({ wallets: list() }),

    async connect({ id }) {
      const sel = pick(id);
      if (sel.kind === "svm") {
        const res = await sel.w.provider.connect();
        const key = (res && res.publicKey) || sel.w.provider.publicKey;
        const address = key && (key.toString ? key.toString() : String(key));
        if (!address) throw new Error("wallet returned no address");
        return { kind: "svm", address, name: sel.w.name, icon: iconFor(sel.w.name) };
      }
      const accounts = await sel.w.provider.request({ method: "eth_requestAccounts" });
      const address = accounts && accounts[0];
      if (!address) throw new Error("wallet returned no address");
      const chainId = await sel.w.provider.request({ method: "eth_chainId" }).catch(() => null);
      // ALL of them, not just the first. A wallet with four accounts permitted
      // hands back four, and taking accounts[0] silently picked whichever one
      // happened to be selected in the wallet — with no way to say otherwise.
      return { kind: "evm", address, accounts: accounts.slice(), name: sel.w.info.name,
               chainId: chainId ? parseInt(chainId, 16) : null,
               icon: sel.w.info.icon || brandIcon(sel.w.info.name) };
    },

    /* Re-open the wallet's own account permission dialog. This is how somebody
       adds an account Xeet has never been shown, or takes one away: the list we
       can offer is only ever the accounts the wallet has already permitted. */
    async grantAccounts({ id }) {
      const sel = pick(id);
      if (sel.kind !== "evm") throw new Error("that wallet has one account here");
      try {
        await sel.w.provider.request({
          method: "wallet_requestPermissions",
          params: [{ eth_accounts: {} }],
        });
      } catch (e) {
        if (isRejection(e)) throw e;
        // Wallets that do not implement it still answer the plain request.
      }
      const accounts = await sel.w.provider.request({ method: "eth_requestAccounts" });
      return { accounts: (accounts || []).slice() };
    },

    async switchChain({ id, chainId, chainName, rpc, explorer, native }) {
      const sel = pick(id);
      if (sel.kind !== "evm") return { ok: true };
      const hex = "0x" + Number(chainId).toString(16);
      try {
        await sel.w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      } catch (e) {
        // 4902: the wallet has never heard of this chain. Offer to add it —
        // the wallet still shows its own confirmation, so this cannot be
        // slipped past anyone.
        if (e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
          await sel.w.provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hex, chainName,
              rpcUrls: [rpc],
              blockExplorerUrls: explorer ? [explorer.replace(/\/tx\/$/, "")] : undefined,
              nativeCurrency: { name: native.symbol, symbol: native.symbol, decimals: native.decimals },
            }],
          });
        } else throw e;
      }
      return { ok: true };
    },

    /* Solana. Phantom, Backpack and Solflare all accept the `request` form
       with a base58 message; the object form is the fallback for wallets that
       only implement the typed method. Both end at the same place: the
       wallet's own confirmation window. */
    async sendSvm({ id, transaction }) {
      const sel = pick(id);
      if (sel.kind !== "svm") throw new Error("that wallet cannot sign a Solana transaction");
      const p = sel.w.provider;
      const bytes = b64decode(transaction);
      const msg = messageOf(bytes);

      if (typeof p.request === "function") {
        try {
          const res = await p.request({
            method: "signAndSendTransaction",
            params: { message: b58encode(msg) },
          });
          const sig = res && (res.signature || res);
          if (sig) return { hash: String(sig) };
        } catch (e) {
          if (isRejection(e)) throw e;
        }
      }
      if (typeof p.signAndSendTransaction === "function") {
        const duck = { version: 0, message: { serialize: () => msg }, serialize: () => bytes };
        const res = await p.signAndSendTransaction(duck);
        const sig = res && (res.signature || res);
        if (sig) return { hash: String(sig) };
      }
      throw new Error("this wallet cannot send a Solana transaction");
    },

    async sendEvm({ id, tx }) {
      const sel = pick(id);
      if (sel.kind !== "evm") throw new Error("that wallet cannot sign an EVM transaction");
      const params = { from: tx.from, to: tx.to, data: tx.data };
      if (tx.value && tx.value !== "0x0" && tx.value !== "0") params.value = hex(tx.value);
      if (tx.gas) params.gas = hex(tx.gas);
      const hash = await sel.w.provider.request({ method: "eth_sendTransaction", params: [params] });
      return { hash };
    },

    async watchAsset({ id, address, symbol, decimals, image }) {
      const sel = pick(id);
      if (sel.kind !== "evm") return { ok: false };
      const ok = await sel.w.provider.request({
        method: "wallet_watchAsset",
        params: { type: "ERC20", options: { address, symbol: symbol.slice(0, 11), decimals, image } },
      });
      return { ok: !!ok };
    },
  };

  function hex(v) {
    if (typeof v === "string" && v.startsWith("0x")) return v;
    try { return "0x" + BigInt(v).toString(16); } catch { return "0x0"; }
  }

  function isRejection(e) {
    const c = e && (e.code ?? (e.data && e.data.code));
    const m = ((e && e.message) || "").toLowerCase();
    return c === 4001 ||
      (c === -32603 && m.includes("reject")) ||
      m.includes("user rejected") || m.includes("user denied") || m.includes("declined");
  }

  /* ------------------------------------------------------------ the wire */
  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.ns !== NS || d.dir !== "req") return;
    const fn = OPS[d.op];
    const post = (payload) => window.postMessage(Object.assign({ ns: NS, dir: "res", id: d.id }, payload), "*");
    if (!fn) return post({ ok: false, error: "unknown operation" });
    try {
      post({ ok: true, data: await fn(d.args || {}) });
    } catch (err) {
      post({
        ok: false,
        error: (err && err.message) || String(err),
        rejected: isRejection(err),
      });
    }
  });

  // Tell the panel a wallet turned up late (extensions inject asynchronously).
  const nudge = () => window.postMessage({ ns: NS, dir: "evt", op: "wallets" }, "*");
  window.addEventListener("eip6963:announceProvider", nudge);
  setTimeout(nudge, 900);
  setTimeout(nudge, 2600);
})();
