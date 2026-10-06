/* Xeet — the popup.
 *
 * Four panes behind a bottom bar, in the order the questions get asked: what
 * is moving, what do I own, what did I do, how is this set up. Every number on
 * the first three is a live read; everything on the fourth writes straight to
 * storage, so a change is in force on the next hover with no Save button to
 * forget to press.
 *
 * Nothing here invents a figure. Where a value cannot be had — a token with no
 * price, an EVM wallet whose full token list needs an indexer this extension
 * does not ask permission for — the pane says so instead of filling the gap. */

(() => {
  "use strict";
  const F = window.XEET_FMT;
  const { CHAINS, FEE, DEFAULTS } = window.XEET_CFG;
  const CHAIN_SVG = window.XEET_CHAINS || {};
  const $ = (s) => document.querySelector(s);

  const send = (msg) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const le = chrome.runtime.lastError;
      if (le) return reject(new Error(le.message));
      if (!res) return reject(new Error("no answer"));
      res.ok ? resolve(res.data) : reject(new Error(res.error));
    });
  });

  let settings = Object.assign({}, DEFAULTS);
  let board = [];
  let lane = "m5";
  const loaded = { now: false, holdings: false, history: false };

  /* ------------------------------------------------------------- chrome */
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    show(b.dataset.tab);
  });

  function show(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === name));
    document.querySelector("main").scrollTop = 0;
    if (name === "holdings" && !loaded.holdings) loadHoldings();
    if (name === "history" && !loaded.history) renderTrades();
  }

  $("#power").addEventListener("click", async () => {
    settings.on = !settings.on;
    $("#power").setAttribute("aria-checked", String(settings.on));
    await send({ type: "saveSettings", patch: { on: settings.on } });
  });

  $("#lanes").addEventListener("click", (e) => {
    const b = e.target.closest(".lane");
    if (!b) return;
    document.querySelectorAll(".lane").forEach((l) => l.classList.toggle("on", l === b));
    lane = b.dataset.w;
    renderBoard();
  });

  function spinning(btn, p) {
    btn.classList.add("spin");
    return p.finally(() => setTimeout(() => btn.classList.remove("spin"), 700));
  }
  $("#reload").addEventListener("click", () => spinning($("#reload"), loadBoard(true)));
  $("#reload-hold").addEventListener("click", () => spinning($("#reload-hold"), loadHoldings(true)));

  /* -------------------------------------------------------- shared bits */
  const STAGE_BARS = { warm: 1, running: 2, sending: 3 };

  /* The product's own three-bar meter. Filled bars carry the reading; the
     unfilled ones stay visible at low opacity so the scale is always there to
     read the value against. */
  function barsSvg(filled) {
    const g = [{ x: 1, y: 7.5, h: 3.5 }, { x: 4.7, y: 4.5, h: 6.5 }, { x: 8.4, y: 1, h: 10 }];
    return '<svg viewBox="0 0 12 12" aria-hidden="true">' +
      g.map((b, i) => `<rect x="${b.x}" y="${b.y}" width="2.6" height="${b.h}" rx="1" fill="currentColor"${i < filled ? "" : ' opacity=".2"'}/>`).join("") +
      "</svg>";
  }

  function face(el, symbol, image) {
    el.textContent = (symbol || "?").slice(0, 1).toUpperCase();
    if (!image || !/^https:\/\//.test(image)) return;
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    img.onload = () => { el.textContent = ""; el.appendChild(img); };
    img.src = image;
  }

  /* A SPARKLINE FROM MEASURED POINTS, not a drawn squiggle.
     Dexscreener reports the move over four windows; with the current price
     that is five real prices — 24h ago, 6h, 1h, 5m, now — and the line joins
     exactly those. It is coarse, and it is the token's actual shape. */
  function sparkline(t) {
    const now = Number(t.priceUsd) || 0;
    if (!now) return "";
    const back = (pct) => {
      const c = Number(pct);
      return Number.isFinite(c) ? now / (1 + c / 100) : null;
    };
    const pts = [back(t.change.h24), back(t.change.h6), back(t.change.h1), back(t.change.m5), now]
      .map((v) => (Number.isFinite(v) && v > 0 ? v : null));
    const known = pts.filter((v) => v !== null);
    if (known.length < 2) return "";
    // carry the last known value forward through gaps so the line stays whole
    let last = known[0];
    const filled = pts.map((v) => (v === null ? last : (last = v)));
    const lo = Math.min(...filled), hi = Math.max(...filled);
    const span = hi - lo || hi || 1;
    const W = 46, H = 22, PAD = 3;
    const d = filled.map((v, i) => {
      const x = (i / (filled.length - 1)) * W;
      const y = H - PAD - ((v - lo) / span) * (H - PAD * 2);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    const up = filled[filled.length - 1] >= filled[0];
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}" stroke="${up ? "#FFFFFF" : "#8A9199"}"/></svg>`;
  }

  /* ------------------------------------------------------ find a token */
  /* Resolve first, show what it is, and only then open it. */
  $("#find").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#findq").value.trim();
    if (!q) return;
    const form = $("#find"), rows = $("#findrows"), note = $("#find-note");
    form.classList.add("busy");
    rows.innerHTML = "";
    note.hidden = false;
    note.textContent = "Looking it up…";
    try {
      const res = await send({ type: "resolve", query: q });
      const hits = [res.token].concat((res.candidates || []).filter((c) => c.address !== res.token.address));
      note.hidden = hits.length < 2;
      note.textContent = hits.length > 1
        ? `${hits.length} tokens answer to that. Ranked by tradable depth.` : "";
      hits.slice(0, 5).forEach((t) => rows.appendChild(findRow(t)));
    } catch (err) {
      note.hidden = false;
      note.textContent = err.message || "Nothing trades under that name.";
    } finally {
      form.classList.remove("busy");
    }
  });

  function findRow(t) {
    const li = document.createElement("li");
    li.className = "row";
    li.title = `${t.name || t.symbol} · ${t.chainName}`;

    const fc = document.createElement("span");
    fc.className = "face";
    face(fc, t.symbol, t.image);

    const copy = document.createElement("span");
    copy.className = "copy";
    const symline = document.createElement("span");
    symline.className = "symline";
    const sym = document.createElement("span");
    sym.className = "sym";
    sym.textContent = (t.symbol || "?").toUpperCase() + " · " + (t.name || "");
    symline.appendChild(sym);
    const sub = document.createElement("span");
    sub.className = "sub";
    const cn = document.createElement("span");
    cn.className = "stage";
    cn.textContent = t.chainName;
    const ad = document.createElement("span");
    ad.className = "chainname";
    ad.textContent = F.shortAddr(t.address, 5, 5);
    sub.append(cn, ad);
    copy.append(symline, sub);

    const col = document.createElement("span");
    col.className = "numcol";
    const cap = document.createElement("span");
    cap.className = "cap";
    cap.textContent = F.usdShort(t.marketCap);
    const liq = document.createElement("span");
    liq.className = "chg";
    liq.style.color = "var(--muted)";
    liq.textContent = F.usdShort(t.liquidity) + " liq";
    col.append(cap, liq);

    li.append(fc, copy, col);
    li.addEventListener("click", () => openToken(t));
    return li;
  }

  /* --------------------------------------------------------------- NOW */
  function skeletons(host, n) {
    host.innerHTML = Array.from({ length: n },
      () => '<li class="skel"><i></i><i></i><i></i></li>').join("");
  }

  function stageFor(t, key) {
    const tx = t.txns[key] || { buys: 0, sells: 0 };
    const total = (tx.buys || 0) + (tx.sells || 0);
    if (!total) return "quiet";
    const minutes = { m5: 5, h1: 60, h6: 360, h24: 1440 }[key];
    const per5 = (total / minutes) * 5;
    const base = t.txns.h24 ? ((t.txns.h24.buys || 0) + (t.txns.h24.sells || 0)) / 288 : per5;
    const accel = base > 0 ? per5 / base : 1;
    const chg = Number(t.change[key] ?? 0);
    const buyShare = (tx.buys || 0) / total;
    if (per5 >= 25 && accel >= 1.6 && chg > 6 && buyShare > 0.58) return "sending";
    if (per5 >= 10 && accel >= 1.15 && chg > 1.5) return "running";
    if (per5 >= 4 && (chg > 0.4 || buyShare > 0.55)) return "warm";
    return "quiet";
  }

  function renderBoard() {
    const host = $("#rows");
    host.innerHTML = "";
    const rank = { sending: 3, running: 2, warm: 1, quiet: 0 };
    const rows = board
      .map((t) => Object.assign({}, t, { stage: stageFor(t, lane) }))
      .sort((a, b) => (rank[b.stage] - rank[a.stage]) ||
        (Number(b.change[lane] || 0) - Number(a.change[lane] || 0)))
      .slice(0, 14);

    if (!rows.length) {
      $("#now-note").textContent = "Nothing is moving hard enough to call a runner.";
      return;
    }
    $("#now-note").textContent = "";

    for (const t of rows) {
      const li = document.createElement("li");
      li.className = "row";
      li.title = `${t.name || t.symbol} · ${t.chainName}`;

      const fc = document.createElement("span");
      fc.className = "face";
      face(fc, t.symbol, t.image);

      const copy = document.createElement("span");
      copy.className = "copy";
      const symline = document.createElement("span");
      symline.className = "symline";
      const sym = document.createElement("span");
      sym.className = "sym";
      sym.textContent = (t.symbol || "?").toUpperCase();
      symline.appendChild(sym);
      // "new" is the pair's age, not a guess: under a day old gets the badge
      if (t.createdAt && Date.now() - t.createdAt < 24 * 3600 * 1000) {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = "NEW";
        symline.appendChild(b);
      }
      const sub = document.createElement("span");
      sub.className = "sub";
      const stage = document.createElement("span");
      stage.className = "stage " + t.stage;
      stage.innerHTML = barsSvg(STAGE_BARS[t.stage] || 0);
      stage.append(document.createTextNode(t.stage));
      sub.appendChild(stage);
      if (t.createdAt) {
        const age = document.createElement("span");
        age.className = "age";
        age.textContent = F.age(t.createdAt);
        sub.appendChild(age);
      }
      copy.append(symline, sub);

      const nums = document.createElement("span");
      nums.className = "nums";
      const sp = sparkline(t);
      if (sp) {
        const holder = document.createElement("span");
        holder.innerHTML = sp;
        nums.appendChild(holder.firstElementChild);
      }
      const col = document.createElement("span");
      col.className = "numcol";
      const cap = document.createElement("span");
      cap.className = "cap";
      cap.textContent = F.usdShort(t.marketCap);
      const chg = document.createElement("span");
      const c = Number(t.change[lane] || 0);
      chg.className = "chg";
      chg.style.color = c < 0 ? "var(--muted)" : "var(--core)";
      chg.textContent = F.pct(c);
      col.append(cap, chg);
      nums.append(col);

      li.append(fc, copy, nums);
      // ⌘-click asks X about it instead of opening the panel — the second
      // gesture the hint row promises
      li.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey) {
          chrome.tabs.create({ url: "https://x.com/search?q=" + encodeURIComponent("$" + (t.symbol || "")) });
          window.close();
        } else openToken(t);
      });
      host.appendChild(li);
    }
  }

  /* A token belongs on X — that is where the panel lives.
     If the tab in front of you is a timeline, the panel opens on it. If it is
     not, a timeline is opened and the request is left in storage for the
     content script to pick up when it boots, so pasting a contract into the
     popup ends at the same panel either way. */
  async function openToken(t) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "openToken", query: t.address, chain: t.chain });
        window.close();
        return;
      } catch { /* not a timeline: fall through */ }
    }
    await chrome.storage.local.set({
      pendingOpen: { query: t.address, chain: t.chain, at: Date.now() },
    });
    await chrome.tabs.create({ url: "https://x.com/home" });
    window.close();
  }

  async function loadBoard(force) {
    if (force) board = [];
    skeletons($("#rows"), 7);
    $("#now-note").textContent = "Reading the tape…";
    try {
      board = await send({ type: "trending", limit: 16 });
      loaded.now = true;
    } catch {
      board = [];
      $("#now-note").textContent = "Could not reach the tape. Try again in a moment.";
    }
    renderBoard();
  }

  /* ---------------------------------------------------------- HOLDINGS */
  async function loadHoldings(force) {
    const host = $("#holdrows"), note = $("#hold-note"), total = $("#hold-total");
    skeletons(host, 5);
    note.textContent = "";
    let data;
    try {
      data = await send({ type: "holdings" });
    } catch (e) {
      host.innerHTML = "";
      note.textContent = e.message || "Could not read the wallet.";
      return;
    }
    loaded.holdings = true;
    host.innerHTML = "";

    if (!data.wallet) {
      total.hidden = true;
      note.textContent = "No wallet connected. Open the panel on X and connect one — the wallet's own window is the only thing that authorises anything.";
      return;
    }

    total.hidden = false;
    $("#hold-sum").textContent = F.usdShort(data.total);
    const pill = $("#valuepill");
    pill.hidden = false;
    pill.textContent = F.usdShort(data.total);

    // dust is hidden, not deleted: a wallet with 130 dead mints in it is not
    // a list anybody reads
    const rows = data.rows.filter((r) => (r.usd || 0) >= 1 || r.native);
    const hidden = data.rows.length - rows.length;

    for (const r of rows) {
      const li = document.createElement("li");
      li.className = "row";
      li.title = `${r.name || r.symbol} · ${r.chainName}`;

      const fc = document.createElement("span");
      fc.className = "face";
      face(fc, r.symbol, r.image);

      const copy = document.createElement("span");
      copy.className = "copy";
      const symline = document.createElement("span");
      symline.className = "symline";
      const sym = document.createElement("span");
      sym.className = "sym";
      sym.textContent = (r.symbol || "?").toUpperCase();
      symline.appendChild(sym);
      // Two accounts, one list — a row has to say which account it is in, or
      // "send it home" and "sell this" become guesses.
      if (r.oneClick) {
        const tag = document.createElement("span");
        tag.className = "viatag";
        tag.textContent = "1-click";
        tag.title = "Held by the one-click trading account, not your wallet";
        symline.appendChild(tag);
      }
      const sub = document.createElement("span");
      sub.className = "sub";
      const amt = document.createElement("span");
      amt.className = "amt";
      amt.textContent = F.qty(r.amount) + " " + (r.symbol || "").toUpperCase();
      const ch = document.createElement("span");
      ch.className = "chainname";
      ch.textContent = r.chainName;
      sub.append(amt, ch);
      copy.append(symline, sub);

      const col = document.createElement("span");
      col.className = "numcol";
      const usd = document.createElement("span");
      usd.className = "cap";
      usd.textContent = r.usd != null ? F.usdShort(r.usd) : F.DASH;
      const pr = document.createElement("span");
      pr.className = "chg";
      pr.style.color = "var(--muted)";
      pr.textContent = r.price != null ? F.price(r.price) : "no price";
      col.append(usd, pr);

      li.append(fc, copy, col);
      li.addEventListener("click", () => openToken({ address: r.address, chain: r.chain }));
      host.appendChild(li);
    }

    const notes = [];
    if (!rows.length) notes.push("Nothing priceable in this wallet yet.");
    if (rows.some((r) => r.oneClick)) {
      notes.push("Rows marked 1-click are on the trading account, not in your wallet. Settings \u2192 One-click trading \u2192 Send it home moves its balance back.");
    }
    if (hidden > 0) notes.push(`${hidden} position${hidden > 1 ? "s" : ""} under $1 hidden.`);
    if (data.partial) {
      notes.push("On EVM this lists the native coin and what you have traded through Xeet — reading every token an address holds needs an indexer this extension does not ask permission for.");
    }
    note.textContent = notes.join(" ");
  }

  /* ----------------------------------------------------------- HISTORY */
  async function renderTrades() {
    const list = await send({ type: "history" }).catch(() => []);
    loaded.history = true;
    const host = $("#trades");
    host.innerHTML = "";
    if (!list.length) {
      $("#trades-note").textContent = "No swaps yet. Hover a cashtag on X and pick a size.";
      return;
    }
    $("#trades-note").textContent = "";
    for (const s of list.slice(0, 40)) {
      const li = document.createElement("li");
      li.className = "row trade";

      const fc = document.createElement("span");
      fc.className = "face";
      face(fc, s.symbol, s.image);

      const copy = document.createElement("span");
      copy.className = "copy";
      const symline = document.createElement("span");
      symline.className = "symline";
      const sym = document.createElement("span");
      sym.className = "sym";
      sym.textContent = `${(s.symbol || "").toUpperCase()} · ${F.qty(s.outAmount)} ${s.outSymbol}`;
      symline.appendChild(sym);
      const sub = document.createElement("span");
      sub.className = "sub";
      const dir = document.createElement("b");
      dir.className = "dir " + s.side;
      dir.textContent = s.side;
      const when = document.createElement("span");
      when.className = "age";
      when.textContent = F.age(s.at) + " ago";
      sub.append(dir, when);
      copy.append(symline, sub);

      const col = document.createElement("span");
      col.className = "numcol";
      const amt = document.createElement("span");
      amt.className = "cap";
      amt.textContent = s.usd ? F.usdShort(s.usd) : F.qty(s.inAmount) + " " + s.inSymbol;
      const st = document.createElement("span");
      st.className = "st " + s.status;
      st.textContent = s.status;
      col.append(amt, st);

      /* A card for any trade, not only the one that just happened: the day
         somebody wants to show a win is rarely the day they made it. */
      const card = document.createElement("button");
      card.className = "cardbtn";
      card.type = "button";
      card.title = "Trade card";
      card.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 14l4.5-4.5 4 4 3-3L21 15"/></svg>';
      card.addEventListener("click", async (e) => {
        e.stopPropagation();                      // the row itself opens the explorer
        card.disabled = true;
        try {
          const blob = await window.XEET_CARD.drawCard({
            side: s.side,
            symbol: s.symbol,
            chainName: (CHAINS[s.chain] || {}).name || s.chain,
            inAmount: s.inAmount, inSymbol: s.inSymbol,
            outAmount: s.outAmount, outSymbol: s.outSymbol,
            usd: s.usd,
            multiple: window.XEET_CARD.multipleFrom(list, s),
          }, chrome.runtime.getURL("icons/icon128.png"),
             chrome.runtime.getURL("assets/shards.jpg"));
          const how = await window.XEET_CARD.deliver(
            blob, `xeet-${(s.symbol || "trade").toLowerCase()}.png`);
          card.classList.add("done");
          card.title = how === "copied" ? "Copied — paste it in a post" : "Saved to downloads";
          setTimeout(() => { card.classList.remove("done"); card.title = "Trade card"; }, 2000);
        } catch { card.title = "Could not draw it"; }
        card.disabled = false;
      });

      li.append(fc, copy, col, card);
      const chain = CHAINS[s.chain];
      if (chain && s.hash) li.addEventListener("click", () => chrome.tabs.create({ url: chain.explorer + s.hash }));
      host.appendChild(li);
    }
  }

  /* ---------------------------------------------------------- SETTINGS */
  function chips(host, values, current, label, onPick) {
    host.innerHTML = "";
    values.forEach((v) => {
      const b = document.createElement("button");
      b.className = "chip" + (v === current ? " on" : "");
      b.type = "button";
      b.textContent = label(v);
      b.addEventListener("click", async () => {
        await onPick(v);
        chips(host, values, v, label, onPick);
      });
      host.appendChild(b);
    });
  }

  function presetInputs(host, key) {
    host.innerHTML = "";
    settings[key].forEach((v, i) => {
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.value = key === "sellPresets" ? v + "%" : "$" + v;
      input.addEventListener("focus", () => { input.value = String(settings[key][i]); });
      input.addEventListener("blur", () => {
        const n = parseFloat(input.value);
        if (!(n > 0)) { input.value = key === "sellPresets" ? settings[key][i] + "%" : "$" + settings[key][i]; return; }
        const next = settings[key].slice();
        next[i] = n;
        settings[key] = next;
        input.value = key === "sellPresets" ? n + "%" : "$" + n;
        send({ type: "saveSettings", patch: { [key]: next } }).catch(() => {});
      });
      host.appendChild(input);
    });
  }

  function renderSetup() {
    $("#power").setAttribute("aria-checked", String(!!settings.on));

    chips($("#slip"), [50, 100, 300, 500, 1000], settings.slippageBps,
      (v) => (v / 100).toString().replace(/\.0$/, "") + "%",
      async (v) => { settings.slippageBps = v; await send({ type: "saveSettings", patch: { slippageBps: v } }); });

    chips($("#delay"), [0, 130, 300, 600], settings.hoverDelay,
      (v) => (v === 0 ? "instant" : v + "ms"),
      async (v) => { settings.hoverDelay = v; await send({ type: "saveSettings", patch: { hoverDelay: v } }); });

    presetInputs($("#buys"), "buyPresets");
    presetInputs($("#sells"), "sellPresets");

    for (const k of ["scanCashtags", "scanAddresses"]) {
      const box = $("#" + k);
      box.checked = !!settings[k];
      box.addEventListener("change", async () => {
        settings[k] = box.checked;
        await send({ type: "saveSettings", patch: { [k]: box.checked } });
      });
    }

    // Say which chains, because right now they differ. Jupiter pays into a token
    // account, which exists; LI.FI pays an integrator registered in its portal,
    // which is not set up yet — so a flat "on every chain" would be false on
    // nine of the ten. An integrator string alone collects nothing.
    const onSol = !!FEE.solanaFeeAccount, onEvm = !!FEE.evmFeeConfigured;
    $("#feeline").textContent =
      onSol && onEvm
        ? `${FEE.label} per swap, on every chain Xeet routes. Nothing else is charged, and nothing is charged on a trade that fails.`
      : onSol
        ? `${FEE.label} per swap on Solana. Every other chain routes at cost for now. Nothing is charged on a trade that fails.`
      : onEvm
        ? `${FEE.label} per swap on the EVM chains. Solana routes at cost for now.`
        : "This build routes at cost — Xeet takes no fee. You still pay the router's own spread and the network's gas.";

    for (const [id, chain] of [["evm", "robinhood"], ["svm", "solana"]]) {
      const el = document.querySelector(`#wcard-${id} .wchain`);
      // renderWallet paints this too, and swaps in the wallet's own icon once
      // one is connected. This is only the state before that answer arrives.
      if (el && !el.firstChild) el.innerHTML = CHAIN_SVG[chain] || "";
      document.querySelector(`#wcard-${id}`).addEventListener("click", async () => {
        const { wallets } = await chrome.storage.local.get({ wallets: null });
        const connected = wallets && wallets[id];
        if (connected) {
          // Disconnecting is local and instant: the extension forgets a public
          // address. Nothing is revoked in the wallet itself, and nothing
          // needs to be — it never held an approval from us.
          const next = Object.assign({ svm: null, evm: null }, wallets);
          next[id] = null;
          await chrome.storage.local.set({ wallets: next });
          renderWallet();
          loaded.holdings = false;
          $("#valuepill").hidden = !(next.svm || next.evm);
          return;
        }
        // Connecting is the panel's job — it is the surface the wallet's own
        // window opens over, and the only one that can ask.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          try { await chrome.tabs.sendMessage(tab.id, { type: "connectWallet", kind: id }); window.close(); return; } catch { /* */ }
        }
        // No panel in front of us — the message above went nowhere. Leave the
        // request where the freshly opened tab will find it, the same way the
        // board hands over a token. Without this the tab just opened X and sat
        // there, which read as connecting being broken.
        await chrome.storage.local.set({ pendingConnect: { kind: id, at: Date.now() } });
        await chrome.tabs.create({ url: "https://x.com/home" });
        window.close();
      });
    }
  }

  async function renderWallet() {
    const { wallets, walletIcons } = await chrome.storage.local.get({ wallets: null, walletIcons: {} });
    for (const id of ["svm", "evm"]) {
      const w = wallets && wallets[id];
      const card = $(`#wcard-${id}`);
      const on = !!(w && w.address);
      card.classList.toggle("on", on);

      // Once a wallet is connected the card should show THAT WALLET, not the
      // chain it signs for — a Robinhood leaf above the word "MetaMask" tells
      // you nothing you did not already know. The icon is the one the wallet
      // announces about itself (EIP-6963), never a redrawing of someone's
      // logo. Unconnected, the chain glyph stays: there it is the answer to
      // "what should I bring?".
      const slot = card.querySelector(".wchain");
      // `x && /re/.test(x)` is a BOOLEAN, not x — writing it that way set every
      // icon's src to the string "true" and drew two broken images.
      const own = on && w.icon && /^data:image\//.test(w.icon) ? w.icon : null;
      const icon = on ? (own || walletIcons[w.name] || null) : null;
      if (icon) {
        slot.innerHTML = "";
        const img = document.createElement("img");
        img.src = icon;
        img.alt = "";
        slot.appendChild(img);
      } else {
        slot.innerHTML = CHAIN_SVG[slot.dataset.chain] || "";
      }
      $(`#wname-${id}`).textContent = on ? (w.name || "Wallet") : "Connect";
      const label = $(`#waddr-${id}`);
      label.classList.toggle("prompt", !on);
      label.textContent = on
        ? F.shortAddr(w.address, 5, 5)
        : (id === "svm" ? "A SOLANA WALLET" : "A ROBINHOOD CHAIN WALLET");
      let drop = card.querySelector(".drop");
      if (on && !drop) {
        drop = document.createElement("span");
        drop.className = "drop";
        card.appendChild(drop);
      }
      if (drop) drop.textContent = on ? "Tap to disconnect" : "";
      if (!on && drop) drop.remove();
    }
    // Only worth offering when there is something to forget.
    $("#forgetrow").hidden = !(wallets && (wallets.svm || wallets.evm));
  }

  /* Forgetting is local and complete: Xeet holds nothing but public addresses,
     so this is the whole of it. Two taps, because it is not worth doing by
     accident to two wallets at once. */
  $("#forget-all").addEventListener("click", async () => {
    const b = $("#forget-all");
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "Forget both — you will reconnect";
      setTimeout(() => { b.dataset.armed = "0"; b.textContent = "Forget every wallet"; }, 4000);
      return;
    }
    b.dataset.armed = "0";
    b.textContent = "Forget every wallet";
    await chrome.storage.local.set({ wallets: { svm: null, evm: null } });
    loaded.holdings = false;
    $("#valuepill").hidden = true;
    await renderWallet();
    await readHome();
  });

  // A wallet can connect while this popup is open — the panel writes it to
  // storage and the cards have to notice.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.wallets) { renderWallet(); readHome(); loaded.holdings = false; }
    if (area === "sync") for (const k in changes) settings[k] = changes[k].newValue;
  });

  /* --------------------------------------------------- one-click trading */
  let turbo = { settings: { on: false }, account: null };

  async function renderTurbo() {
    turbo = await send({ type: "turboInfo" }).catch(() => turbo);
    const t = turbo.settings || {};
    $("#turbo-on").setAttribute("aria-checked", String(!!t.on));
    $("#turbo-body").hidden = !t.on;
    $("#turbo-svm-card").hidden = !t.on;

    const has = !!turbo.account;
    $("#turbo-acct").hidden = !has;
    $("#turbo-make").hidden = has;
    $("#turbo-bring").hidden = has;
    if (has) { $("#turbo-bring-box").hidden = true; $("#turbo-secret").value = ""; }
    for (const id of ["#turbo-copy", "#turbo-refresh", "#turbo-home", "#turbo-wipe"]) $(id).hidden = !has;
    // Second line of defence, in case a build check is somehow passed by a
    // worker that still writes Solana accounts: a base58 address under a
    // heading about ETH is not a cosmetic problem.
    if (has && !/^0x[0-9a-fA-F]{40}$/.test(turbo.account.address)) {
      $("#turbo-addr").textContent = "—";
      $("#turbo-warn").textContent =
        "This account was made by an older version and is not on Robinhood Chain. Reload Xeet, then delete it and create a new one.";
    } else if (has) {
      $("#turbo-addr").textContent = turbo.account.address;
    }
    if (has) renderTurboHolds(); else $("#turbo-holds").innerHTML = "";
    renderHomeNote();
    renderSvm();

    chips($("#turbo-per"), [10, 25, 50, 100, 250], t.perTradeUsd,
      (v) => "$" + v,
      async (v) => { await send({ type: "turboSettings", patch: { perTradeUsd: v } }); renderTurbo(); });
    chips($("#turbo-day"), [50, 100, 250, 500, 1000], t.dailyUsd,
      (v) => "$" + v,
      async (v) => { await send({ type: "turboSettings", patch: { dailyUsd: v } }); renderTurbo(); });
    $("#turbo-spent").textContent = `$${(t.spent || 0).toFixed(2)} used today · resets at midnight`;

    // Said plainly, because it is the thing somebody would be angry to learn
    // later: on this chain the key is readable by this extension.
    $("#turbo-note").textContent = (has
      ? "This account's key is stored on your device as bytes, and Xeet can read it — Ethereum's signing curve has no unreadable-key support in the browser, unlike Solana's. Keep here only what you would shrug at losing, and use Send it home when you are done."
      : "The account is created on your device and your own wallet never signs for it. But on Robinhood Chain the key has to be stored as readable bytes — Xeet can read it, and so could a bad update. Fund it with what you are willing to risk, and nothing more.")
      + " Solana's key is not readable this way — the browser can hold that one unexportable. One-click works on those two chains; trades on every other chain keep going through your wallet's own window.";
  }

  /* What the trading account is holding. Money you put in a second account is
     money you can forget about, so it is listed here rather than left to be
     discovered on an explorer. */
  let turboHolds = { rows: [], total: 0 };
  async function renderTurboHolds() {
    const box = $("#turbo-holds");
    turboHolds = await send({ type: "turboHoldings" }).catch(() => ({ rows: [], total: 0 }));
    const rows = (turboHolds.rows || []).filter((r) => !r.native);
    box.innerHTML = "";
    // Symbols come off a public index and are attacker-chosen text. They go
    // in as text nodes, never as markup.
    for (const r of rows) {
      const li = document.createElement("li");
      li.className = "row mini";
      const cell = (cls, text) => {
        const n = document.createElement("span");
        n.className = cls;
        n.textContent = text;
        li.appendChild(n);
      };
      cell("sym", (r.symbol || "").toUpperCase());
      cell("amt", F.qty(r.amount));
      cell("usd", r.usd ? F.usdShort(r.usd) : "");
      box.appendChild(li);
    }
    renderHomeNote();
  }

  /* The one sentence that decides whether pressing the button is a good idea. */
  function renderHomeNote() {
    const note = $("#turbo-home-note");
    const btn = $("#turbo-home");
    if (!turbo.account) { note.hidden = true; return; }
    const positions = (turboHolds.rows || []).filter((r) => !r.native && r.amount > 0).length;
    note.hidden = false;
    if (!homeTo) {
      note.textContent = "Connect an EVM wallet above and the balance goes back to it.";
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    note.textContent = positions
      ? `Sends the ETH to ${F.shortAddr(homeTo, 5, 5)}. ${positions} position${positions > 1 ? "s" : ""} would stay on the account with no gas left to sell ${positions > 1 ? "them" : "it"} — sell first, then send.`
      : `Sends everything except the gas for the transfer to ${F.shortAddr(homeTo, 5, 5)}.`;
  }

  // Two destinations, because there are two accounts: the Robinhood account
  // goes home to the connected EVM wallet and the Solana one to a Solana
  // wallet. Neither can be typed in.
  let homeTo = null, homeSvm = null;
  async function readHome() {
    const { wallets } = await chrome.storage.local.get({ wallets: null });
    homeTo = (wallets && wallets.evm && wallets.evm.address) || null;
    homeSvm = (wallets && wallets.svm && wallets.svm.address) || null;
    renderHomeNote();
    renderSvmHome();
  }

  $("#turbo-on").addEventListener("click", async () => {
    const next = !(turbo.settings && turbo.settings.on);
    await send({ type: "turboSettings", patch: { on: next } });
    await renderTurbo();
  });

  $("#turbo-make").addEventListener("click", async () => {
    $("#turbo-make").textContent = "Generating…";
    try { await send({ type: "turboCreate" }); } catch (e) { $("#turbo-note").textContent = e.message; }
    $("#turbo-make").textContent = "Create the account";
    await renderTurbo();
  });

  /* Importing a key. The field is built to be used once and forgotten: it is
     cleared the moment the worker has the key, and what was typed is never put
     anywhere else — not in storage, not in a log, not left in the DOM. */
  $("#turbo-bring").addEventListener("click", () => {
    $("#turbo-bring-box").hidden = false;
    $("#turbo-bring-note").textContent = "";
    $("#turbo-secret").focus();
  });

  const closeBring = () => {
    $("#turbo-secret").value = "";
    $("#turbo-bring-box").hidden = true;
    $("#turbo-bring-note").textContent = "";
  };
  $("#turbo-bring-cancel").addEventListener("click", closeBring);

  $("#turbo-bring-do").addEventListener("click", async () => {
    const field = $("#turbo-secret");
    const secret = field.value;
    if (!secret.trim()) { $("#turbo-bring-note").textContent = "Paste a private key first."; return; }
    const btn = $("#turbo-bring-do");
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const acc = await send({ type: "turboImport", secret });
      field.value = "";           // gone before anything else redraws
      closeBring();
      await renderTurbo();
      await readHome();
    } catch (e) {
      $("#turbo-bring-note").textContent = e.message || "That key could not be imported.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Import it";
    }
  });

  $("#turbo-copy").addEventListener("click", async () => {
    if (!turbo.account) return;
    await navigator.clipboard.writeText(turbo.account.address).catch(() => {});
    const b = $("#turbo-copy"); const was = b.textContent;
    b.textContent = "Copied"; setTimeout(() => { b.textContent = was; }, 1200);
  });

  $("#turbo-refresh").addEventListener("click", async () => {
    $("#turbo-bal").textContent = "…";
    try {
      const p = await send({ type: "turboBalance" });
      $("#turbo-bal").textContent = F.qty(p.amount) + " ETH";
    } catch { $("#turbo-bal").textContent = "—"; }
  });

  /* --------------------------------------------------- the Solana account */
  /* The same six things the Robinhood account offers, against a different key
     with a different guarantee: this one was generated — or imported — as a
     handle that cannot be exported, so Xeet signs with it and cannot read it.
     The card is its own, because merging the two would mean one sentence
     describing two security stories, and only one of them is the good one. */
  let svmHolds = { rows: [], total: 0 };

  async function renderSvm() {
    const has = !!turbo.svm;
    $("#svm-acct").hidden = !has;
    $("#svm-make").hidden = has;
    $("#svm-bring").hidden = has;
    if (has) { $("#svm-bring-box").hidden = true; $("#svm-secret").value = ""; }
    for (const id of ["#svm-copy", "#svm-refresh", "#svm-home", "#svm-wipe"]) $(id).hidden = !has;
    if (has) {
      $("#svm-addr").textContent = turbo.svm.address;
      renderSvmHolds();
    } else {
      $("#svm-holds").innerHTML = "";
      $("#svm-home-note").hidden = true;
    }
  }

  async function renderSvmHolds() {
    const box = $("#svm-holds");
    svmHolds = await send({ type: "turboHoldings", kind: "svm" }).catch(() => ({ rows: [], total: 0 }));
    box.innerHTML = "";
    for (const r of (svmHolds.rows || []).filter((x) => !x.native)) {
      const li = document.createElement("li");
      li.className = "row mini";
      const cell = (cls, text) => {
        const n = document.createElement("span");
        n.className = cls;
        n.textContent = text;
        li.appendChild(n);
      };
      // Attacker-chosen text from a public index: nodes, never markup.
      cell("sym", (r.symbol || "").toUpperCase());
      cell("amt", F.qty(r.amount));
      cell("usd", r.usd ? F.usdShort(r.usd) : "");
      box.appendChild(li);
    }
    renderSvmHome();
  }

  function renderSvmHome() {
    const note = $("#svm-home-note");
    const btn = $("#svm-home");
    if (!turbo.svm) { note.hidden = true; return; }
    note.hidden = false;
    if (!homeSvm) {
      note.textContent = "Connect a Solana wallet above and the balance goes back to it.";
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    const positions = (svmHolds.rows || []).filter((r) => !r.native && r.amount > 0).length;
    note.textContent = positions
      ? `Sends the SOL to ${F.shortAddr(homeSvm, 5, 5)}. ${positions} position${positions > 1 ? "s" : ""} would stay on the account with nothing left to sell ${positions > 1 ? "them" : "it"} — sell first, then send.`
      : `Sends everything except the fee for the transfer to ${F.shortAddr(homeSvm, 5, 5)}.`;
  }

  $("#svm-make").addEventListener("click", async () => {
    const b = $("#svm-make");
    b.textContent = "Generating…";
    try { await send({ type: "turboCreate", kind: "svm" }); }
    catch (e) { $("#svm-warn").textContent = e.message; }
    b.textContent = "Create the account";
    await renderTurbo();
  });

  $("#svm-bring").addEventListener("click", () => {
    $("#svm-bring-box").hidden = false;
    $("#svm-bring-note").textContent = "";
    $("#svm-secret").focus();
  });

  const closeSvmBring = () => {
    $("#svm-secret").value = "";
    $("#svm-bring-box").hidden = true;
    $("#svm-bring-note").textContent = "";
  };
  $("#svm-bring-cancel").addEventListener("click", closeSvmBring);

  $("#svm-bring-do").addEventListener("click", async () => {
    const field = $("#svm-secret");
    const secret = field.value;
    if (!secret.trim()) { $("#svm-bring-note").textContent = "Paste a private key first."; return; }
    const btn = $("#svm-bring-do");
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      await send({ type: "turboImport", kind: "svm", secret });
      field.value = "";           // gone before anything else redraws
      closeSvmBring();
      await renderTurbo();
      await readHome();
    } catch (e) {
      $("#svm-bring-note").textContent = e.message || "That key could not be imported.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Import it";
    }
  });

  $("#svm-copy").addEventListener("click", async () => {
    if (!turbo.svm) return;
    await navigator.clipboard.writeText(turbo.svm.address).catch(() => {});
    const b = $("#svm-copy"); const was = b.textContent;
    b.textContent = "Copied"; setTimeout(() => { b.textContent = was; }, 1200);
  });

  $("#svm-refresh").addEventListener("click", async () => {
    $("#svm-bal").textContent = "…";
    try {
      const p = await send({ type: "turboBalance", kind: "svm" });
      $("#svm-bal").textContent = F.qty(p.sol) + " SOL";
    } catch { $("#svm-bal").textContent = "—"; }
    renderSvmHolds();
  });

  $("#svm-home").addEventListener("click", async () => {
    const b = $("#svm-home");
    if (!homeSvm || b.disabled) return;
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "Send to " + F.shortAddr(homeSvm, 4, 4) + "?";
      setTimeout(() => {
        if (b.dataset.armed !== "1") return;
        b.dataset.armed = "0"; b.textContent = "Send it home";
      }, 5000);
      return;
    }
    b.dataset.armed = "0"; b.disabled = true; b.textContent = "Sending…";
    try {
      const r = await send({ type: "turboSweep", kind: "svm", to: homeSvm });
      $("#svm-home-note").textContent = "Sent " + F.qty(r.sol) + " SOL — " + F.shortAddr(r.hash, 6, 6);
      $("#svm-bal").textContent = "0 SOL";
    } catch (e) {
      $("#svm-home-note").textContent = e.message || "It did not go through";
    } finally {
      b.disabled = false; b.textContent = "Send it home";
    }
  });

  $("#svm-wipe").addEventListener("click", async () => {
    const b = $("#svm-wipe");
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "Delete — anything left is lost";
      setTimeout(() => { b.dataset.armed = "0"; b.textContent = "Delete it"; }, 4000);
      return;
    }
    await send({ type: "turboWipe", kind: "svm" });
    b.dataset.armed = "0"; b.textContent = "Delete it";
    await renderTurbo();
  });

  /* Sending it home. Irreversible and typed by nobody — the destination is
     the wallet already connected, never a field, because a field is exactly
     where an address gets pasted wrong once and the money is gone. */
  $("#turbo-home").addEventListener("click", async () => {
    const b = $("#turbo-home");
    if (!homeTo || b.disabled) return;
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "Send to " + F.shortAddr(homeTo, 4, 4) + "?";
      setTimeout(() => {
        if (b.dataset.armed !== "1") return;
        b.dataset.armed = "0"; b.textContent = "Send it home";
      }, 5000);
      return;
    }
    b.dataset.armed = "0";
    b.disabled = true;
    b.textContent = "Sending…";
    try {
      const res = await send({ type: "turboSweep", to: homeTo });
      b.textContent = "Sent " + F.qty(res.amount) + " ETH";
      $("#turbo-bal").textContent = "0 ETH";
      $("#turbo-home-note").textContent = "Sent — " + F.shortAddr(res.hash, 6, 6);
    } catch (e) {
      b.textContent = "Send it home";
      $("#turbo-home-note").textContent = e.message || "It did not go through";
    } finally {
      b.disabled = false;
      setTimeout(() => { b.textContent = "Send it home"; renderHomeNote(); }, 4000);
    }
  });

  $("#turbo-wipe").addEventListener("click", async () => {
    const b = $("#turbo-wipe");
    // Two taps, because the key cannot be recovered and anything left on the
    // account goes with it.
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "Delete — funds on it are lost";
      setTimeout(() => { b.dataset.armed = "0"; b.textContent = "Delete it"; }, 4000);
      return;
    }
    await send({ type: "turboWipe" });
    b.dataset.armed = "0";
    b.textContent = "Delete it";
    $("#turbo-bal").textContent = "—";
    await renderTurbo();
  });

  /* Is the background the same build as this popup?
     Chrome reloads popup files from disk on every open and keeps the service
     worker until the extension is reloaded, so the two can drift a whole
     release apart — and everything on screen then describes code that is not
     running. Ask, rather than assume. */
  async function checkBuild() {
    const want = chrome.runtime.getManifest().version;
    let got = null;
    try { got = (await send({ type: "buildId" })).build; } catch { got = null; }
    if (got === want) return true;
    // Text first, then reveal. Setting it after unhiding meant that if this
    // line ever threw, the banner appeared as a bare headline with a button
    // and no explanation — which is how it looked in the wild.
    const box = $("#stale");
    const why = $("#stale-why");
    if (why) why.textContent = got
      ? `These settings are version ${want}; the part doing the work is still ${got}. Until it restarts, what you do here goes to the old one.`
      : `These settings are version ${want}; the part doing the work is from an earlier release. Until it restarts, what you do here goes to the old one.`;
    box.hidden = false;
    return false;
  }

  $("#stale-go").addEventListener("click", async () => {
    // Restarting the extension is the actual fix, and it is one call — nobody
    // should have to be sent to chrome://extensions for this.
    //
    // But restarting orphans the content script in every X tab already open:
    // the panel stays on screen and every request it makes fails from then on,
    // until that page is reloaded. So reload those tabs first. No new
    // permission is needed — the manifest already holds x.com and twitter.com.
    try {
      const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
      await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id).catch(() => {})));
    } catch { /* worst case they refresh the tab themselves, and it says so */ }
    chrome.runtime.reload();
    window.close();
  });

  /* --------------------------------------------------------------- boot */
  (async function boot() {
    await checkBuild();
    settings = await send({ type: "settings" }).catch(() => settings);
    renderSetup();
    renderWallet();
    await readHome();
    renderTurbo();
    loadBoard();
  })();
})();
