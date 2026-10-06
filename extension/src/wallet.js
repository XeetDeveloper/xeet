/* Xeet — the panel's side of the wallet bridge.
 *
 * The bridge (bridge.js) is in the page; this is the half in the extension's
 * world. It keeps one fact — which wallet is connected and to what address —
 * and it persists only what is public: the address and the wallet's name. No
 * key, no signature, no seed ever crosses this boundary, because none of them
 * is ever asked for.
 *
 * Connection is explicit and per-wallet. Xeet does not call eth_accounts on
 * page load to see whether it recognises you; a wallet's permission is
 * something you grant, not something a timeline discovers. */

(function (g) {
  "use strict";
  const NS = "__xeet_bridge";
  const waiting = new Map();
  let seq = 0;
  const listeners = new Set();

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.ns !== NS) return;
    if (d.dir === "evt") { listeners.forEach((f) => { try { f(d.op); } catch { /* */ } }); return; }
    if (d.dir !== "res") return;
    const slot = waiting.get(d.id);
    if (!slot) return;
    waiting.delete(d.id);
    clearTimeout(slot.timer);
    if (d.ok) slot.resolve(d.data);
    else {
      const err = new Error(d.error || "wallet error");
      err.rejected = !!d.rejected;
      slot.reject(err);
    }
  });

  function call(op, args, timeout) {
    return new Promise((resolve, reject) => {
      const id = "xeet" + (++seq) + ":" + Date.now();
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("the wallet did not answer"));
      }, timeout || 180000);
      waiting.set(id, { resolve, reject, timer });
      window.postMessage({ ns: NS, dir: "req", id, op, args: args || {} }, "*");
    });
  }

  /* ------------------------------------------------------- the connection */
  /* ONE WALLET PER WORLD, not one wallet.
   *
   * A person trading from a timeline has a Solana wallet and an EVM wallet,
   * and the token under the cursor decides which one signs. Holding a single
   * "connected wallet" meant every Solana token in front of a MetaMask user
   * ended at "Wrong wallet" — a dead end for a state the product could simply
   * have kept. Both stay connected; the chain picks. */
  const state = { svm: null, evm: null };

  async function restore() {
    const got = await chrome.storage.local.get({ wallets: null, wallet: null });
    if (got.wallets) Object.assign(state, got.wallets);
    // migrate the single-wallet shape a previous version stored
    else if (got.wallet && got.wallet.address && got.wallet.kind) {
      state[got.wallet.kind] = got.wallet;
      await remember();
      await chrome.storage.local.remove("wallet");
    }
    return state;
  }

  async function remember() {
    await chrome.storage.local.set({ wallets: { svm: state.svm, evm: state.evm } });
  }

  /* Every icon this page has seen a wallet announce, kept by name.
     The popup has no page to discover wallets in — it cannot see window.ethereum
     at all — so without this it can only draw a chain glyph next to a wallet it
     knows the name of. Written whenever the picker lists wallets, which means
     a wallet connected before this existed gets its icon the next time the
     panel opens rather than never. */
  async function rememberIcons(list) {
    const seen = {};
    for (const w of list) if (w.icon && /^data:image\//.test(w.icon)) seen[w.name] = w.icon;
    if (!Object.keys(seen).length) return;
    const { walletIcons } = await chrome.storage.local.get({ walletIcons: {} });
    const next = Object.assign({}, walletIcons, seen);
    // Only write when something changed; this runs on every picker open.
    if (JSON.stringify(next) !== JSON.stringify(walletIcons)) {
      await chrome.storage.local.set({ walletIcons: next });
    }
  }

  /* The wallet that can sign for a chain, or null. */
  function forChain(chain) {
    if (!chain) return null;
    return state[chain.kind === "svm" ? "svm" : "evm"];
  }
  const any = () => state.svm || state.evm;

  async function forget(kind) {
    if (kind) state[kind] = null;
    else { state.svm = null; state.evm = null; }
    await remember();
  }

  async function wallets() {
    const r = await call("list", {}, 4000).catch(() => ({ wallets: [] }));
    const list = r.wallets || [];
    rememberIcons(list).catch(() => {});
    return list;
  }

  async function connect(id) {
    // Three minutes of nothing is indistinguishable from a broken button. A
    // wallet that has not answered in ninety seconds is not about to.
    const r = await call("connect", { id }, 90000);
    const w = { id, kind: r.kind, address: r.address, name: r.name, chainId: r.chainId || null,
                icon: r.icon || null, accounts: r.accounts || null };
    state[r.kind] = w;
    await remember();
    return w;
  }

  /* Which of the wallet's accounts signs. The wallet decides which accounts
     Xeet may see; this decides which of those it uses, and it is a local
     choice — nothing is re-requested and no window opens. */
  async function use(kind, address) {
    const w = state[kind];
    if (!w) throw new Error("no wallet connected");
    const list = w.accounts || [w.address];
    const found = list.find((a) => a.toLowerCase() === String(address).toLowerCase());
    if (!found) throw new Error("that account is not one this wallet offered");
    w.address = found;
    await remember();
    return w;
  }

  /* Ask the wallet to show its own account picker, then take the new list. */
  async function grant(kind) {
    const w = state[kind];
    if (!w) throw new Error("no wallet connected");
    const r = await call("grantAccounts", { id: w.id }, 90000);
    w.accounts = r.accounts || w.accounts;
    if (w.accounts && w.accounts.length && !w.accounts.some((a) => a.toLowerCase() === w.address.toLowerCase())) {
      w.address = w.accounts[0];     // the one we were using is no longer permitted
    }
    await remember();
    return w;
  }

  /* An EVM trade must be signed on the chain the token lives on. Asking is
     cheap; guessing is how a swap gets built against the wrong pool. */
  async function ensureChain(chain) {
    const w = forChain(chain);
    if (!w || w.kind !== "evm" || chain.kind !== "evm") return;
    await call("switchChain", {
      id: w.id, chainId: chain.id, chainName: chain.name,
      rpc: chain.rpc, explorer: chain.explorer, native: chain.native,
    });
    w.chainId = chain.id;
    await remember();
  }

  const send = {
    svm: (transaction) => call("sendSvm", { id: (state.svm || {}).id, transaction }),
    evm: (tx) => call("sendEvm", { id: (state.evm || {}).id, tx }),
  };

  // Perps: the wallet signs a message rather than a transaction.
  const signTyped = (typedData) =>
    call("signTypedEvm", { id: (state.evm || {}).id, typedData }, 120000);

  const watchAsset = (opts) => call("watchAsset", Object.assign({ id: (state.evm || {}).id }, opts), 60000);

  g.XEET_WALLET = {
    state, restore, wallets, connect, forget, forChain, any, ensureChain, use, grant,
    send, signTyped, watchAsset,
    onChange: (fn) => listeners.add(fn),
  };
})(window);
