/* Xeet — the panel.
 *
 * One panel exists for the whole page. It is mounted once, moved to whatever
 * you are pointing at, and refilled; a card per cashtag would mean forty live
 * price loops in a screenful of timeline.
 *
 * The shape of a session:
 *
 *   point at a tag  →  resolve it  →  fill the intel card
 *                                  →  screen it, chart it, in parallel
 *   point at the button  →  the deck opens
 *   tap an amount  →  quote  →  the card FLIPS to review  →  your wallet
 *                              signs  →  confirm on chain  →  the finish
 *
 * The flip is the whole point of the object: the front is a claim about a
 * token and the back is a claim about your money, and they are never on
 * screen at the same time.
 *
 * Everything written into the card from a third-party index — a token name, a
 * website URL — is set with textContent or validated as a URL first. A token
 * called `<img onerror=…>` is a real thing that exists on Solana today. */

(function (g) {
  "use strict";

  /* Which build of the page-side code this is.
   *
   * There are three copies of Xeet running at any moment and they can all be
   * different ages. The popup is re-read from disk every time it opens. The
   * service worker lives until the extension is reloaded. And THIS — the code
   * injected into an X tab — lives until that tab is reloaded, which is how
   * somebody ends up looking at a panel from two releases ago while the popup
   * beside it is current. The popup already checks itself against the worker;
   * this checks the page against the worker, and between them there is nowhere
   * left for a stale copy to hide.
   *
   * A literal, kept in step with the manifest by build.sh, which refuses to
   * build when they disagree. */
  const BUILD = "1.8.0";

  const { CHAINS, FEE } = g.XEET_CFG;
  const F = g.XEET_FMT;
  const W = g.XEET_WALLET;
  const MARKS = g.XEET_MARKS || {};
  const CHAIN_SVG = g.XEET_CHAINS || {};

  /* Reloading or updating the extension kills every content script already
     running in an open tab. This one keeps its listeners and its markup, so
     the tags still highlight and the panel still opens — and then every single
     thing it asks for fails, silently, forever, until the page is reloaded.
     That is indistinguishable from the product being broken, and it is what
     the popup's own "Reload Xeet" button does to whatever X tab is open.

     So: notice it, say it once, and say what fixes it. */
  let orphaned = false;
  let orphanText = "";
  /* Both messages are the same bar: an old page and a dead page are the same
     problem to whoever is looking at it, and the same key press fixes them. */
  const say2 = (text) => { orphanText = text; announceOrphan(); };
  /* Three ways Chrome says the same thing, and the third does not say it at
     all: when a page is orphaned by a reload, newer Chrome does not invalidate
     the context with a message — it takes `chrome.runtime` away entirely, and
     the call dies as "Cannot read properties of undefined (reading
     'sendMessage')". That TypeError was reaching the card as the token's
     status, which reads as the product being broken rather than as a page that
     needs refreshing. */
  const isOrphaned = (msg) =>
    /extension context invalidated|receiving end does not exist|message port closed/i.test(msg || "")
    || /cannot read propert(?:y|ies) of (?:undefined|null)[^]*sendMessage/i.test(msg || "")
    || /chrome is not defined/i.test(msg || "");

  // The same condition, asked before the call rather than after it. This is not
  // the chrome.runtime.id pre-check that broke the panel once: an extension
  // page without a sendMessage FUNCTION cannot talk to the worker by any route,
  // so there is nothing this could wrongly disable.
  const unreachable = () =>
    typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function";

  const send = (msg) => new Promise((resolve, reject) => {
    let done = false;
    const fail = (e) => {
      if (isOrphaned(e.message)) {
        orphaned = true;
        announceOrphan();
        // Rejecting with the browser's own words puts "Extension context
        // invalidated." on the card where a token's name goes. Every caller
        // shows what it is handed, so the sentence is fixed here, once, rather
        // than in each of them.
        const friendly = new Error("Extension reloaded");
        friendly.orphaned = true;
        return reject(friendly);
      }
      reject(e);
    };
    if (unreachable()) {
      orphaned = true;
      announceOrphan();
      const friendly = new Error("Extension reloaded");
      friendly.orphaned = true;
      return reject(friendly);
    }

    try {
      // No pre-flight check on chrome.runtime.id. An invalidated context makes
      // sendMessage throw or set lastError with that very phrase, which the
      // paths below already catch — while a pre-check turns any environment
      // that does not expose `id` into a panel where nothing works at all.
      chrome.runtime.sendMessage(msg, (res) => {
        if (done) return;
        done = true;
        const le = chrome.runtime.lastError;
        if (le) return fail(new Error(le.message));
        if (!res) return fail(new Error("no answer from the extension"));
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      });
    } catch (e) { fail(e); }
  });

  /* Is the page running the same Xeet as the extension?
     Asked once per page, quietly: the answer only matters when it is no. */
  let buildChecked = false;
  async function checkBuild() {
    if (buildChecked) return;
    buildChecked = true;
    try {
      const r = await send({ type: "buildId" });
      if (r && r.build && r.build !== BUILD) announceStale(r.build);
    } catch { /* an unreachable worker is the orphan case, already handled */ }
  }

  function announceStale(workerBuild) {
    // Name both, claim no direction. In the extension the page is always the
    // older half — the worker is replaced by the update while open tabs keep
    // what they were injected with — but "was updated to 1.4.1" is nonsense
    // the one time it is not, and the two numbers say it plainly either way.
    say2("Xeet is now " + workerBuild + "; this page is " + BUILD + " — refresh to catch up.");
  }

  /* One line, once, on the panel itself — where somebody is already looking. */
  function announceOrphan() {
    if (!root || root.querySelector(".xeet-orphan")) return;
    // The empty card already carries the message and the button. A second copy
    // of both, behind it, is what this was doing.
    if (root.querySelector(".xeet-empty")) return;
    const bar = document.createElement("div");
    bar.className = "xeet-orphan";
    bar.textContent = orphanText || "Xeet was reloaded — refresh this page to use it here.";
    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Refresh";
    go.addEventListener("click", (e) => { e.stopPropagation(); location.reload(); });
    bar.appendChild(go);
    // Into the front face, where the wallet picker goes. Appending to the root
    // put it underneath every absolutely positioned face on the card.
    (root.querySelector(".face.front") || root).appendChild(bar);
    sizePanel();
  }

  /* --------------------------------------------------------------- state */
  let host = null, root = null, loupe = null, back = null;
  let el = {};                 // data-el lookup
  let session = null;          // the token currently on screen
  let settings = { slippageBps: 100, buyPresets: [25, 50, 100], sellPresets: [25, 50, 100] };
  let pinned = false;
  let overPanel = false, overAnchor = false;
  let closeTimer = null, refreshTimer = null;
  let openToken = 0;           // guards against a slow answer for a stale hover

  send({ type: "settings" }).then((s) => { settings = s; }).catch(() => {});
  let turbo = { settings: { on: false }, account: null, svm: null };

  /* The trading account that can sign on THIS chain. There is one per family
     and they are different keys, so everything that asks "is one-click on"
     has to ask about a chain, never in general. */
  function turboAcct(chain) {
    const c = chain || (session && session.chain);
    if (!c) return null;
    if (c.key === "robinhood") return turbo.account || null;
    if (c.key === "solana") return turbo.svm || null;
    return null;
  }
  const refreshTurbo = () => send({ type: "turboInfo" })
    .then((t) => { turbo = t; }).catch(() => {});
  refreshTurbo();

  /* ------------------------------------------------------------- mounting */
  function mount() {
    if (host) return;
    host = document.createElement("div");
    host.className = "xeet-host xeet-hidden";
    root = document.createElement("div");
    root.className = "xeet-lp";
    root.innerHTML = g.XEET_PANEL_HTML;
    host.appendChild(root);
    document.body.appendChild(host);

    loupe = root.querySelector(".loupe");
    back = root.querySelector(".face.back");
    el = {};
    root.querySelectorAll("[data-el]").forEach((n) => { el[n.dataset.el] = n; });

    host.addEventListener("mouseenter", () => { overPanel = true; cancelClose(); });
    host.addEventListener("mouseleave", () => { overPanel = false; maybeClose(); });
    // A click inside the panel is for the panel — it must not reach x.com's
    // own document-level handlers, which close menus and route navigations.
    //
    // BUBBLE phase, not capture. Capturing at the host and stopping there
    // means the event never descends to the button that was clicked, so every
    // control inside the panel goes dead: the wallet picker, the tiles, the
    // range buttons, all of them. Stopping on the way back up leaves the
    // panel's own handlers intact and still keeps the click off the page.
    host.addEventListener("click", (e) => e.stopPropagation());
    host.addEventListener("mousedown", (e) => e.stopPropagation());

    wireStatic();
  }

  /* Handlers that belong to the panel itself and survive every token. */
  function wireStatic() {
    // THE DECK IS OPEN. It used to unfold when the pointer reached the button,
    // which put a gesture between seeing a token and buying it — on a product
    // whose entire claim is that the trade happens where you already are. The
    // sizes are on screen the moment the panel is, so the first tap is the
    // trade.
    loupe.classList.add("open");

    // BUY | SELL. A half arms that direction; it does not trade. Nothing here
    // trades without a tap on an amount, and the wallet's own window after it.
    const arm = (side) => () => {
      if (!session || session.viewOnly) return;
      setSide(side);
    };
    if (el.halfbuy) {
      el.halfbuy.addEventListener("mouseenter", arm("buy"));
      el.halfbuy.addEventListener("click", arm("buy"));
    }
    if (el.halfsell) {
      el.halfsell.addEventListener("mouseenter", arm("sell"));
      el.halfsell.addEventListener("click", arm("sell"));
    }

    if (el.range) {
      el.range.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-r]");
        if (!b || !session) return;
        el.range.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        session.range = b.dataset.r;
        drawChart();
      });
    }

    if (el.denom) {
      el.denom.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-d]");
        if (!b || !session) return;
        el.denom.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        session.denom = b.dataset.d;
        drawChart();
      });
    }

    if (el.seal) {
      el.seal.addEventListener("mouseenter", () => showTip(el.seal, sealLines()));
      el.seal.addEventListener("mouseleave", hideTip);
      el.seal.addEventListener("click", (e) => { e.preventDefault(); showTip(el.seal, sealLines()); });
    }

    if (el.pincorner) {
      el.pincorner.hidden = false;
      el.pincorner.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/></svg>';
      el.pincorner.title = "Keep this panel open";
      el.pincorner.addEventListener("click", () => {
        pinned = !pinned;
        el.pincorner.classList.toggle("on", pinned);
        if (!pinned) maybeClose();
      });
    }

    // A way out that does not depend on moving the mouse somewhere else. The
    // panel closes on leave, but once it is pinned — or once a menu inside it
    // is open — leaving is no longer enough, and there was nothing to press.
    if (el.closecorner) {
      el.closecorner.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      el.closecorner.addEventListener("click", (e) => {
        e.stopPropagation();
        pinned = false;
        closeMenus();
        close();
      });
    }

    bindChartHover();
    checkBuild();

    if (el.cacopy) el.cacopy.addEventListener("click", () => copyCA(el.cacopy, session && session.token && session.token.address));
    if (el.segs) el.segs.addEventListener("click", () => slippageMenu(el.segs));
    if (el.rsegs) el.rsegs.addEventListener("click", () => slippageMenu(el.rsegs));
    if (el.segt) el.segt.addEventListener("click", () => payWithMenu(el.segt));
    // Tapping the row again closes the picker instead of building a second
    // one — a control that only ever opens has no way back out.
    if (el.segw) el.segw.addEventListener("click", () => {
      if (root.querySelector(".wpick")) { closeMenus(); sizePanel(); return; }
      walletMenu();
    });
    if (el.swapbtn) el.swapbtn.addEventListener("click", onSwapBtn);
    if (el.fwin) el.fwin.addEventListener("click", cycleFlowWindow);
  }

  /* The wallet that signs for whatever is on screen. Empty object rather than
     null so a caller can read .address without guarding every use. */
  function wallet() {
    return (session && W.forChain(session.chain)) || {};
  }

  /* The account whose money is on screen. With one-click armed that is the
     trading account — it is what buys, what ends up holding the position, and
     therefore what must be shown. Reading the main wallet's balance while
     spending a different account's money was the hole here: the panel said
     you held two SOL when the account about to pay held none of it, and a
     position bought this way had nothing to sell it with. */
  function holder() {
    if (armed()) return turboAcct().address;
    return wallet().address || null;
  }

  /* Where a sale would come from. With one-click armed there can be two
     accounts holding the same token, and every part of the panel — the SELL
     half, the percentage tiles, the trade itself — has to agree about which
     one it means, or the tiles size a sale against a balance the signer does
     not have. The trading account wins when it holds any, because that is
     the position one tap can close without a prompt. */
  function sellBal() {
    const mine = session && session.balances && session.balances.token;
    if (mine > 0 && holder()) return { amount: mine, owner: holder(), viaTurbo: armed() };
    const w = session && session.walletBalances && session.walletBalances.token;
    if (w > 0 && wallet().address) return { amount: w, owner: wallet().address, viaTurbo: false };
    return { amount: 0, owner: null, viaTurbo: false };
  }

  /* Is the tap going to trade on its own? Everything downstream — the button,
     the wallet row, the tiles — has to agree about this, because a person
     must never learn that one-click was on by watching a trade happen. */
  function armed() {
    return !!(session && session.chain && turbo.settings.on
      && turboAcct(session.chain) && !session.viewOnly);
  }

  /* ------------------------------------------------------------- geometry */
  /* The card is pinned by its TOP so the deck can only ever grow downward —
     growth that moved the top edge would slide the card out from under the
     cursor that opened it. */
  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const W_ = 360, GAP = 12;
    const sx = window.scrollX, sy = window.scrollY;

    let left = r.left + r.width / 2 - W_ / 2;
    left = Math.max(10, Math.min(left, document.documentElement.clientWidth - W_ - 10));

    // The deck no longer unfolds — the card is its full height from the first
    // frame, so the room it needs is that height, not the old collapsed one.
    // Measured when there is a card to measure; the constant is the fallback
    // for the frame before the first layout.
    const need = (root && root.offsetHeight > 200) ? root.offsetHeight + 16 : 560;
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const top = (below >= need || below >= above) ? r.bottom + GAP : Math.max(8, r.top - need - GAP);

    host.style.left = Math.round(left + sx) + "px";
    host.style.top = Math.round(top + sy) + "px";
  }

  /* --intelh drives the deck offset and both card heights, so it is measured
     from real content rather than assumed. A row that appears (a risk bar, a
     holders cell) moves the whole stack instead of overlapping it. */
  function sizePanel() {
    if (!root) return;
    const intel = root.querySelector(".intel");
    const deck = root.querySelector(".deck");
    if (!intel || !deck) return;

    let h = 16; // .intel padding-top
    for (const child of intel.children) {
      if (child.hidden || child.offsetParent === null && child.offsetHeight === 0) continue;
      const cs = getComputedStyle(child);
      if (cs.display === "none") continue;
      h += child.offsetHeight + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0);
    }
    h += 13; // the card breathes below its last row
    root.style.setProperty("--intelh", Math.round(h) + "px");

    // Both deck heights, measured with transitions muted so the numbers are
    // the resting ones rather than whatever frame the animation is on.
    const drawer = el.drawer, amounts = root.querySelector(".amounts");
    // The deck has one height now, because it is always open. Measuring a
    // closed state that never renders was how --deckh and --deckh-open drifted
    // apart and the card jumped on the first hover.
    const muted = [loupe, deck, drawer, amounts].filter(Boolean);
    muted.forEach((n) => { n.style.transition = "none"; });
    loupe.classList.add("open");
    const deckH = deck.offsetHeight;
    root.style.setProperty("--deckh", deckH + "px");
    root.style.setProperty("--deckh-open", deckH + "px");
    requestAnimationFrame(() => muted.forEach((n) => { n.style.transition = ""; }));
  }

  /* The back face is content-sized: grow the card to the review, never squash
     the review into the card. */
  function fitBack() {
    const inner = back.firstElementChild;
    if (!inner) return;
    const h = inner.scrollHeight + 36;
    root.style.setProperty("--intelh", Math.max(240, h) + "px");
    root.style.setProperty("--deckh", "0px");
    root.style.setProperty("--deckh-open", "0px");
  }

  /* --------------------------------------------------------------- open */
  async function open(anchor, spec) {
    mount();
    const my = ++openToken;
    cancelClose();
    overAnchor = true;

    session = {
      anchor, spec, token: null, range: "24h", side: "buy",
      pay: null, screening: null, flowWindow: "m5", quoting: false, viewOnly: false,
    };
    resetFaces();
    skeleton(spec);
    host.classList.remove("xeet-hidden");
    place(anchor);

    let res;
    try {
      res = await send({ type: "resolve", query: spec.query, chainHint: spec.chainHint });
    } catch (e) {
      if (my !== openToken) return;
      empty(spec, e.message);
      return;
    }
    if (my !== openToken || !session) return;

    session.token = res.token;
    session.candidates = res.candidates || [];
    await fill();
    if (my !== openToken) return;
    place(anchor);
    startRefresh();
  }

  function close() {
    if (!host) return;
    openToken++;
    host.classList.add("xeet-hidden");
    hideTip();
    stopRefresh();
    clearTimeout(dismissTimer);
    if (loupe) loupe.classList.remove("confirmed", "flipping", "finishing");
    if (session && session.anchor) session.anchor.classList.remove("xeet-live");
    session = null;
    pinned = false;
    if (el.pincorner) el.pincorner.classList.remove("on");
  }

  function cancelClose() { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } }

  function maybeClose() {
    if (pinned) return;
    // A trade in flight owns the panel until it resolves.
    if (session && session.busy) return;
    cancelClose();
    closeTimer = setTimeout(() => { if (!overPanel && !overAnchor) close(); }, 260);
  }

  function leaveAnchor() { overAnchor = false; maybeClose(); }

  /* ------------------------------------------------------- empty states */
  function resetFaces() {
    loupe.classList.remove("confirmed", "flipping", "finishing", "isstock");
    loupe.classList.add("open");
    root.classList.remove("selling", "needsapprove", "hasrisk", "danger", "warn", "unscreened");
    root.classList.add("safe");
    back.innerHTML = '<div class="review" data-el="review"></div>';
    const chip = root.querySelector(".xeet-anchor");
    if (chip) chip.remove();
    root.querySelectorAll(".xeet-pickwrap").forEach((n) => n.remove());
    el.review = back.firstElementChild;
    if (el.riskbar) el.riskbar.hidden = true;
    if (el.split) el.split.hidden = true;
  }

  /* empty() guts the intel card to say "nothing trades under that name". The
     next hover has to put the card back before it writes anything into it,
     or the skeleton fills nodes that are no longer in the document and the
     panel shows the previous failure while it loads. */
  function ensureMarkup() {
    if (root.querySelector(".ihead")) return;
    root.innerHTML = g.XEET_PANEL_HTML;
    el = {};
    root.querySelectorAll("[data-el]").forEach((n) => { el[n.dataset.el] = n; });
    loupe = root.querySelector(".loupe");
    back = root.querySelector(".face.back");
    root.querySelector(".deck").style.display = "";
    wireStatic();
  }

  function skeleton(spec) {
    ensureMarkup();
    const label = spec.query.startsWith("$") ? spec.query : "$" + (spec.symbol || "…");
    setText("tksym", label.replace(/^\$?/, "$"));
    setText("name", "looking it up");
    el.name.classList.add("xeet-skel");
    setText("price", "$0.0000");
    el.price.classList.add("xeet-skel");
    setText("chg", "+0.00%");
    el.chg.classList.add("xeet-skel");
    for (const k of ["mcap", "liq", "vol"]) { setText(k, "—"); el[k].classList.add("xeet-skel"); }
    if (el.holders_s) el.holders_s.hidden = true;
    if (el.bezel) el.bezel.textContent = "";
    if (el.chartsvg) el.chartsvg.classList.remove("in");
    if (el.swapbtn) { el.swapbtn.className = "swapbtn"; el.swapbtn.textContent = "…"; }
    if (el.flowrow) el.flowrow.hidden = true;
    if (el.tiles) el.tiles.innerHTML = "";
    sizePanel();
  }

  function empty(spec, why) {
    const intel = root.querySelector(".intel");
    intel.innerHTML = '<div class="xeet-empty"><b></b><span></span></div>';
    const card = intel.firstElementChild;
    card.querySelector("b").textContent = spec.query.startsWith("0x") || spec.query.length > 20
      ? F.shortAddr(spec.query, 6, 6)
      : "$" + spec.query.replace(/^\$/, "").toUpperCase();

    // Never a raw internal string: an error meant for a console reads as the
    // product breaking in a way nobody can act on. The flag, not the wording —
    // the message handed here was already made human, so matching on the
    // browser's phrasing would no longer catch it.
    const stale = orphaned || isOrphaned(why);
    card.querySelector("span").textContent = stale
      ? "Xeet was reloaded. Refresh the page to use it here."
      : (why || "Nothing trading under that name.");

    // The fix belongs on the card, not on a separate bar floating behind it.
    // The panel's faces are absolutely positioned and cover anything appended
    // to the root, which is how the explanation ended up half-hidden under an
    // otherwise empty card.
    if (stale) {
      // The bar is made the moment a request fails, which is before this card
      // exists — so guarding the bar against the card was checking too early.
      // The card supersedes it: same message, same button, one object.
      const bar = root.querySelector(".xeet-orphan");
      if (bar) bar.remove();

      const go = document.createElement("button");
      go.type = "button";
      go.className = "xeet-empty-go";
      go.textContent = "Refresh";
      go.addEventListener("click", (e) => { e.stopPropagation(); location.reload(); });
      card.appendChild(go);
    }

    root.querySelector(".deck").style.display = "none";
    root.style.setProperty("--intelh", stale ? "150px" : "120px");
    root.style.setProperty("--deckh", "0px");
    root.style.setProperty("--deckh-open", "0px");
  }

  /* ------------------------------------------------------------- filling */
  function setText(key, v) { const n = el[key]; if (n) { n.textContent = v; n.classList.remove("xeet-skel"); } }

  async function fill() {
    const t = session.token;
    const chain = CHAINS[t.chain];
    session.chain = chain;
    // Two different reasons a token can be readable but not tradable, and the
    // panel says which. A coin still on its launchpad curve is in no
    // aggregator's routes — offering a size and failing at the quote is worse
    // than not offering one.
    if (!chain || !chain.router) {
      session.viewOnly = true;
      session.viewOnlyWhy = `No router covers ${chain ? chain.name : "this chain"} yet`;
    } else if (t.launchpad && !t.launchpad.completed) {
      session.viewOnly = true;
      session.viewOnlyWhy = `Still on the launchpad curve · ${Math.round(t.launchpad.graduation)}% graduated`;
    } else {
      session.viewOnly = false;
      session.viewOnlyWhy = null;
    }

    ensureMarkup();

    setupDenom(t);

    setText("tksym", "$" + (t.symbol || "?").toUpperCase());
    setText("name", t.name || t.symbol || "");
    el.name.title = t.name || "";
    setText("price", F.price(t.priceUsd));
    // A missing change is a dash. "+0.0%" is a claim that nothing moved, and
    // an index with no figure for this pair has not made that claim.
    const raw = t.change.h24 ?? t.change.h1;
    const chg = raw == null ? null : Number(raw);
    setText("chg", chg === null ? F.DASH : F.pct(chg));
    el.chg.classList.toggle("up", chg !== null && chg >= 0);
    el.chg.classList.toggle("dn", chg !== null && chg < 0);
    root.classList.toggle("pricedown", chg !== null && chg < 0);

    if (el.tkage) el.tkage.textContent = t.createdAt ? F.age(t.createdAt) : "";
    if (el.chainbadge) {
      el.chainbadge.innerHTML = CHAIN_SVG[t.chain] || "";
      el.chainbadge.title = "On " + (chain ? chain.name : t.chain);
    }
    if (el.bezel) {
      // The initial is the real fallback, not a placeholder: a token with no
      // art still has a letter, and a letter is better than a grey square.
      el.bezel.textContent = (t.symbol || "?").slice(0, 1).toUpperCase();
      if (t.image) {
        send({ type: "art", url: t.image }).then((dataUrl) => {
          if (!session || session.token !== t) return;
          const img = new Image();
          img.alt = "";
          img.onload = () => {
            if (!session || session.token !== t) return;
            el.bezel.textContent = "";
            el.bezel.appendChild(img);
          };
          img.src = dataUrl;
        }).catch(() => { /* the letter stands */ });
      }
    }

    setText("mcap", F.usdShort(t.marketCap));
    setText("liq", F.usdShort(t.liquidity));
    setText("vol", F.usdShort(t.volume && t.volume.h24));
    if (el["holders-s"]) el["holders-s"].hidden = true;

    links(t);
    flowBar();
    marketsChip();

    // Re-read one-click before the deck is drawn, every time. Reading it once
    // at load meant a toggle flipped in the popup did not reach a panel that
    // was already open — and the deck's promise about whether a tap will
    // prompt has to be true at the moment the tap happens, not at load.
    await refreshTurbo();

    // Chart, screening and the mint's decimals are independent; none of them
    // blocks the card, and all three land before anyone can tap an amount.
    drawChart();
    runScreen();
    send({ type: "decimals", chain: t.chain, address: t.address })
      .then((d) => {
        if (!session || session.token !== t || d == null) return;
        session.tokenDecimals = d;
        tiles();
      })
      .catch(() => {});

    await deck();
    sizePanel();
  }

  function links(t) {
    const row = el.linkrow;
    if (!row) return;
    row.innerHTML = "";
    const add = (href, title, svg) => {
      if (!href || !/^https?:\/\//i.test(href)) return;
      const a = document.createElement("a");
      a.className = "lnk";
      a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.title = title;
      a.innerHTML = svg;
      row.appendChild(a);
    };
    add(t.website, "Website", MARKS.website);
    add(t.x, "X", MARKS.x);
    add(t.telegram, "Telegram", MARKS.telegram);
    add(t.discord, "Discord", MARKS.discord);
    add(t.url, "Dexscreener", MARKS.website && chartGlyph());
  }

  /* -------------------------------------------------- the other markets */
  /* A cashtag is not a token. "$MOON" is four tokens on three chains, and
     picking the deepest one silently is how somebody buys the wrong one.
     Xeet opens the best market and says how many others there are — the
     ambiguity is visible without costing a click on every hover. */
  function marketsChip() {
    const old = root.querySelector(".xeet-anchor");
    if (old) old.remove();
    const list = session.candidates || [];
    if (list.length < 2) return;
    const chip = document.createElement("button");
    chip.className = "xeet-anchor";
    chip.type = "button";
    chip.textContent = `${list.length} markets for $${(session.token.symbol || "").toUpperCase()}`;
    chip.addEventListener("click", (e) => { e.stopPropagation(); showPicker(); });
    root.appendChild(chip);
  }

  function showPicker() {
    closeMenus();
    const list = session.candidates || [];
    const wrap = document.createElement("div");
    wrap.className = "xeet-pickwrap";
    const card = document.createElement("div");
    card.className = "xeet-pick";
    card.innerHTML =
      '<div class="xeet-pick-head"><div class="xeet-pick-title"></div><div class="xeet-pick-sub"></div></div>' +
      '<div class="xeet-pick-list"></div>';
    card.querySelector(".xeet-pick-title").textContent = "$" + (session.token.symbol || "").toUpperCase();
    card.querySelector(".xeet-pick-sub").textContent =
      `${list.length} tokens trade under this name. Ranked by tradable depth.`;

    const rows = card.querySelector(".xeet-pick-list");
    list.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "xeet-pick-row";
      b.type = "button";
      const logo = document.createElement("span");
      logo.className = "xeet-pick-logo";
      logo.textContent = (c.symbol || "?").slice(0, 1).toUpperCase();
      const main = document.createElement("span");
      main.className = "xeet-pick-main";
      const sym = document.createElement("span");
      sym.className = "xeet-pick-sym";
      const nm = document.createElement("span");
      nm.textContent = c.name || c.symbol;
      const badge = document.createElement("span");
      badge.className = "xeet-pick-chain";
      badge.innerHTML = CHAIN_SVG[c.chain] || "";
      sym.append(nm, badge);
      if (i === 0) {
        const tag = document.createElement("span");
        tag.className = "xeet-pick-tag";
        tag.textContent = "PICKED";
        sym.appendChild(tag);
      }
      if (c.liquidity < 25000) {
        const tag = document.createElement("span");
        tag.className = "xeet-pick-tag warn";
        tag.textContent = "THIN";
        sym.appendChild(tag);
      }
      const stats = document.createElement("span");
      stats.className = "xeet-pick-stats";
      stats.textContent = `${c.chainName} · ${F.usdShort(c.liquidity)} liq · ${F.usdShort(c.volume && c.volume.h24)} 24h · ${F.shortAddr(c.address, 4, 4)}`;
      main.append(sym, stats);
      const car = document.createElement("span");
      car.className = "xeet-pick-car";
      car.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
      b.append(logo, main, car);
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        wrap.remove();
        session.token = c;
        await fill();
        place(session.anchor);
      });
      rows.appendChild(b);
    });

    wrap.appendChild(card);
    root.querySelector(".face.front").appendChild(wrap);
    const off = (e) => {
      if (wrap.contains(e.target)) return;
      wrap.remove();
      document.removeEventListener("click", off, true);
    };
    setTimeout(() => document.addEventListener("click", off, true), 0);
  }

  function chartGlyph() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18M6 16l4-5 3.5 3L20 6"/></svg>';
  }

  /* ------------------------------------------------------------ the chart */
  /* What the last drawn chart was made of, for the crosshair to read. */
  let chartRead = null;

  /* The coin the pair is quoted in — the real symbol, not a friendlier one:
     WETH and ETH are the same money here, but only one of them is what the
     pool actually holds. */
  function quoteUnit() {
    const t = session && session.token;
    return (t && t.quoteSymbol) || "";
  }

  const STABLE = /^(USD[TCGE]?|USDG|DAI|FDUSD|PYUSD|TUSD|USDS|USD1|EUR[CS]?)$/i;

  /* Offer the choice only where it is one. Against WETH a token can be flat in
     ETH while its dollar line rides ETH's own move, and those are different
     facts. Against a stablecoin the two lines are the same line, so the toggle
     would be a control that does nothing. */
  function setupDenom(t) {
    if (!el.denom) return;
    const q = (t && t.quoteSymbol) || "";
    const useful = !!q && !STABLE.test(q);
    el.denom.hidden = !useful;
    if (!useful) {
      session.denom = "usd";
      return;
    }
    if (el.denomtok) el.denomtok.textContent = q.toUpperCase();
    const d = session.denom || "usd";
    el.denom.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.d === d));
  }

  /* Reading a price off the chart.
   *
   * The pointer lands somewhere along a box that is 360 units wide however
   * many pixels it happens to be; the nearest point is found in that unit
   * space, and its own stored price and timestamp are shown. Nothing is
   * interpolated: every figure on screen is one that actually traded. */
  function bindChartHover() {
    const box = el.chartbox, svg = el.chartsvg;
    if (!box || !svg || box.dataset.bound === "1") return;
    box.dataset.bound = "1";

    const hide = () => {
      if (el.xrule) el.xrule.hidden = true;
      if (el.xdot) el.xdot.hidden = true;
      if (el.readout) el.readout.hidden = true;
    };

    const move = (e) => {
      if (!chartRead || chartRead.points.length < 2) return hide();
      const r = svg.getBoundingClientRect();
      if (!r.width) return hide();
      const u = ((e.clientX - r.left) / r.width) * 360;      // pixels -> the box's own units
      const { points, X, Y } = chartRead;

      let best = 0, bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = Math.abs(X(i) - u);
        if (d < bestD) { bestD = d; best = i; }
      }
      const p = points[best];
      const x = X(best), y = Y(p.c);

      el.xrule.setAttribute("x1", x.toFixed(1));
      el.xrule.setAttribute("x2", x.toFixed(1));
      el.xrule.hidden = false;
      el.xdot.setAttribute("cx", x.toFixed(1));
      el.xdot.setAttribute("cy", y.toFixed(1));
      el.xdot.setAttribute("fill", chartRead.up ? "#FFFFFF" : "#8A9199");
      el.xdot.hidden = false;

      // F.price is the panel's own price format — sub-digit notation and all —
      // so the readout and the headline figure agree.
      // Two children, made once. Writing textContent would wipe them both and
      // run the price and the time together into one string.
      // Exactly two, not "at least one": the thin-window message leaves a single
      // child behind, and then the price and the time were written into the
      // same node — the time overwrote the price.
      if (el.readout.childElementCount !== 3) {
        el.readout.replaceChildren(document.createElement("b"),
          Object.assign(document.createElement("i"), { className: "cap" }),
          document.createElement("i"));
      }
      const [priceEl, capEl, timeEl] = el.readout.children;
      const inToken = chartRead.denom === "token";
      priceEl.textContent = inToken ? F.qty(p.c) + " " + chartRead.unit : F.price(p.c);
      // Priced in the same money as the line above it: a cap in dollars beside
      // a price in ETH would be two different questions on one row.
      capEl.textContent = chartRead.supply
        ? (inToken ? F.qty(p.c * chartRead.supply) + " " + chartRead.unit
                   : F.usdShort(p.c * chartRead.supply))
        : "";
      timeEl.textContent = ago(p.t);
      el.readout.hidden = false;
      // Follow the pointer, but never past the edges of the chart.
      const w = el.readout.offsetWidth || 76;
      const left = Math.max(0, Math.min(r.width - w, (x / 360) * r.width - w / 2));
      el.readout.style.left = left.toFixed(0) + "px";
    };

    box.addEventListener("pointermove", move);
    box.addEventListener("pointerleave", hide);
    box.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  /* How long ago, said the way somebody reads a chart: seconds near the live
     end, days out at the far one. */
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  async function drawChart() {
    const t = session && session.token;
    if (!t || !el.chartsvg) return;
    const line = el.line, area = el.area, dot = el.dot;
    el.chartsvg.classList.remove("in");
    const range = session.range;
    const denom = session.denom || "usd";
    let points = [];
    try {
      const r = await send({ type: "chart", chain: t.chain, pool: t.pairAddress, range, denom });
      points = r.points || [];
    } catch { /* a chart is not the panel */ }
    if (!session || session.token !== t || session.range !== range
        || (session.denom || "usd") !== denom) return;

    if (points.length < 3) {
      line.setAttribute("d", "");
      area.setAttribute("d", "");
      if (dot) dot.setAttribute("r", "0");
      chartRead = null;
      // A thirty-second window on a token that trades twice a minute is not a
      // chart, and drawing two points as if it were would be a lie about how
      // much is happening.
      if (el.readout && (range === "30s" || range === "5m")) {
        el.readout.replaceChildren(
          Object.assign(document.createElement("b"), {
            textContent: points.length ? "too few trades to draw" : "no trades in this window",
          }));   // one child; the hover rebuilds all three when it needs them
        el.readout.hidden = false;
        el.readout.style.left = "0px";
      }
      return;
    }
    if (el.readout) el.readout.hidden = true;
    const ys = points.map((p) => p.c);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const span = hi - lo || hi || 1;
    // 5..39 of the 44-unit box: the endpoint dot needs headroom or it reads as
    // a line cropped by the frame rather than a price near its high.
    const X = (i) => (i / (points.length - 1)) * 360;
    const Y = (v) => 44 - (5 + ((v - lo) / span) * 34);
    const d = "M" + points.map((p, i) => `${X(i).toFixed(1)} ${Y(p.c).toFixed(1)}`).join(" L");
    line.setAttribute("d", d);
    area.setAttribute("d", `${d} L360,44 L0,44 Z`);
    if (dot) {
      dot.setAttribute("r", "2.6");
      dot.setAttribute("cx", X(points.length - 1).toFixed(1));
      dot.setAttribute("cy", Y(ys[ys.length - 1]).toFixed(1));
    }
    // Direction, without hue: a gain is drawn at full white, a loss at the
    // muted step. The two fills differ too (xeetg / xeetgr), so the shape under
    // the line reads even where a single hairline would not.
    const up = ys[ys.length - 1] >= ys[0];
    line.setAttribute("stroke", up ? "#FFFFFF" : "#8A9199");
    area.setAttribute("fill", up ? "url(#xeetg)" : "url(#xeetgr)");
    if (dot) dot.setAttribute("fill", up ? "#FFFFFF" : "#8A9199");

    // Hand the hover the same numbers the line was drawn from. Reading a price
    // back out of pixel coordinates would be a rounded-off guess at a figure
    // we already have exactly.
    // Market cap at a point on the line, not just the price. The supply is
    // whatever reconciles today's cap with today's price, so the right-hand end
    // of the chart necessarily agrees with the MCAP box below it — and the rest
    // of the line is that same supply at the price it traded at.
    //
    // It is held constant across the window, which is true enough over minutes
    // and a simplification over a week: a token that minted or burned in that
    // time had a different supply then. Nothing here can know that, so the
    // figure is offered on the short ranges' terms.
    const supply = (t.marketCap > 0 && t.priceUsd > 0) ? t.marketCap / t.priceUsd : 0;
    chartRead = { points, X, Y, up, denom, unit: quoteUnit(), supply };
    el.chartsvg.classList.add("in");
  }

  /* ------------------------------------------------------------ screening */
  async function runScreen() {
    const t = session.token;
    root.classList.remove("safe", "warn", "danger", "unscreened");
    root.classList.add("unscreened");
    setSealGlyph("?");
    let r;
    try {
      r = await send({ type: "screen", chain: t.chain, address: t.address });
    } catch { r = { verdict: "unknown", findings: [] }; }
    if (!session || session.token !== t) return;
    session.screening = r;

    root.classList.remove("safe", "warn", "danger", "unscreened");
    root.classList.add(
      r.verdict === "safe" ? "safe" : r.verdict === "danger" ? "danger" : r.verdict === "caution" ? "warn" : "unscreened"
    );
    setSealGlyph(r.verdict === "safe" ? "check" : r.verdict === "danger" ? "x" : r.verdict === "caution" ? "!" : "?");

    // A scam-grade finding is a sentence across the card, not a coloured dot.
    const bad = (r.findings || []).find((f) => f.level === "bad");
    if (bad && el.riskbar) {
      el.riskbar.hidden = false;
      el.riskbar.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v5M12 17.5v.5"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg><span></span>';
      el.riskbar.querySelector("span").textContent = bad.text;
      root.classList.add("hasrisk");
    } else if (el.riskbar) {
      el.riskbar.hidden = true;
      root.classList.remove("hasrisk");
    }
    sizePanel();
  }

  function setSealGlyph(kind) {
    if (!el.seal) return;
    const g_ = {
      check: '<path d="M5 12.5 10 17.5 19 7"/>',
      x: '<path d="M6 6l12 12M18 6 6 18"/>',
      "!": '<path d="M12 6v8M12 17.5v.5"/>',
      "?": '<path d="M9 9a3 3 0 1 1 4 2.8V14M12 17.5v.5"/>',
    }[kind] || "";
    el.seal.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${g_}</svg>`;
    el.seal.setAttribute("aria-label", "Safety screening");
  }

  function sealLines() {
    const s = session && session.screening;
    if (!s) return ["Screening…"];
    if (s.verdict === "unknown") return ["Not screened", "No screener could reach this token. Absence of a finding is not a clean bill."];
    if (!s.findings.length) return ["Screened clean", "No honeypot, no live mint authority, no transfer tax."];
    return [s.verdict === "danger" ? "Do not trade this" : "Screened with findings"]
      .concat(s.findings.map((f) => f.text));
  }

  function showTip(anchorEl, lines) {
    const box = el.tipbox;
    if (!box) return;
    box.hidden = false;
    box.innerHTML = "";
    lines.forEach((l, i) => {
      const d = document.createElement("div");
      d.className = "xeettip-l";
      if (i === 0) d.style.fontWeight = "750";
      d.textContent = l;
      box.appendChild(d);
    });
    const a = anchorEl.getBoundingClientRect();
    const p = root.getBoundingClientRect();
    box.style.left = Math.max(6, Math.min(a.left - p.left - 8, 360 - 258)) + "px";
    box.style.top = (a.bottom - p.top + 8) + "px";
  }
  function hideTip() { if (el.tipbox) el.tipbox.hidden = true; }

  /* ------------------------------------------------------------ flow bar */
  const WINDOWS = [["m5", "5M"], ["h1", "1H"], ["h6", "6H"], ["h24", "24H"]];

  function cycleFlowWindow(e) {
    e.stopPropagation();
    const i = WINDOWS.findIndex(([k]) => k === session.flowWindow);
    session.flowWindow = WINDOWS[(i + 1) % WINDOWS.length][0];
    flowBar();
  }

  /* Stage is flow, not price. A token up 40% on eleven trades is thin, not
     running, and calling it running is the panel lying to make itself
     exciting. */
  function flowBar() {
    const bar = el.flowrow;
    const t = session && session.token;
    if (!bar || !t) return;
    const key = session.flowWindow;
    const tx = t.txns[key] || { buys: 0, sells: 0 };
    const total = (tx.buys || 0) + (tx.sells || 0);
    const label = (WINDOWS.find(([k]) => k === key) || [])[1] || "5M";
    bar.hidden = false;

    if (!total) {
      bar.dataset.stage = "quiet";
      el.fico.innerHTML = "";
      el.fstage.textContent = "QUIET";
      el.ftags.innerHTML = "";
      el.fnums.innerHTML = '<span class="fnone">no trades</span>';
      el.fwin.textContent = label;
      return;
    }

    const buyShare = (tx.buys || 0) / total;
    const minutes = { m5: 5, h1: 60, h6: 360, h24: 1440 }[key];
    const perMin = total / minutes;
    const chg = Number(t.change[key] ?? 0);
    const stage = stageFor(t, key);

    bar.dataset.stage = stage;
    el.fico.innerHTML = flameSvg(stage);
    el.fstage.textContent = stage.toUpperCase();

    const tags = [];
    // A coin still on a launchpad curve is the whole reason the older index
    // has never heard of it. Saying how far it has graduated turns "why is
    // there no data" into a fact about the token.
    if (t.launchpad) tags.push(["t-new", `curve ${Math.round(t.launchpad.graduation)}%`]);
    const ageMs = t.createdAt ? Date.now() - t.createdAt : null;
    if (ageMs !== null && ageMs < 36e5 * 24) tags.push(["t-new", "new"]);
    if (t.liquidity < 25000) tags.push(["t-thin", "thin"]);
    if (buyShare > 0.72) tags.push(["t-heating", "one-sided"]);
    if (buyShare < 0.32) tags.push(["t-selling", "selling"]);
    if (t.volume && t.liquidity && t.volume.h24 / t.liquidity > 12) tags.push(["t-churn", "churn"]);
    el.ftags.innerHTML = "";
    tags.slice(0, 3).forEach(([cls, text]) => {
      const i = document.createElement("i");
      i.className = "ftag " + cls;
      i.textContent = text;
      el.ftags.appendChild(i);
    });

    el.fnums.innerHTML =
      `<span class="fpressure"><i style="--p:${Math.round(buyShare * 100)}%"></i></span>` +
      `<span class="fpct"></span><span class="frate"></span>`;
    el.fnums.querySelector(".fpct").textContent = F.pct(chg);
    el.fnums.querySelector(".frate").textContent =
      perMin >= 1 ? `${perMin.toFixed(perMin >= 10 ? 0 : 1)}/min` : `${total} trades`;
    el.fwin.textContent = label;
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

  function flameSvg(stage) {
    if (stage === "quiet") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 12h16"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.6 4.2-2.2 5.3-3.4 7.4A5.9 5.9 0 0 0 8 12.6C8 16 10 18 12 18s4-2 4-5.4c0-2-.8-3.4-1.8-4.8-.7 1-1.4 1.6-2.1 1.9.6-2.6.6-5.3 0-7.7Z"/><path d="M12 22c-3.3 0-6-2.4-6-5.6 0 0 1.3 2.2 3.2 2.9C8.6 20.6 10.2 22 12 22Z" opacity=".55"/></svg>';
  }

  /* ------------------------------------------------------------- the deck */
  async function deck() {
    // There is no deck without a token. Two states have none: the moment
    // between opening on a tag and the token resolving, and the panel the
    // popup opens purely to connect a wallet, which never gets one. Reading
    // t.symbol below threw on both — "Cannot read properties of null" — and
    // because the throw happened AFTER the wallet was already stored, the
    // picker reported a failure for a connection that had in fact succeeded.
    if (!session || !session.token) return;
    const t = session.token, chain = session.chain;
    await W.restore();

    setSide(session.side);

    // Does this ticker have a perp at all? Asked once, quietly; the strip
    // only exists if the answer is yes.
    if (session.perp === undefined) {
      session.perp = null;
      send({ type: "perpMarket", symbol: t.symbol })
        .then((m) => { if (session && session.token === t) { session.perp = m || null; perpStrip(); } })
        .catch(() => {});
    }

    setText("bname", (t.symbol || "?").toUpperCase());
    setText("bca", F.shortAddr(t.address, 5, 5));
    setText("slp", (settings.slippageBps / 100).toFixed(settings.slippageBps % 100 ? 2 : 1).replace(/\.0$/, "") + "%");
    setText("rslp", (settings.slippageBps / 100).toFixed(settings.slippageBps % 100 ? 2 : 1).replace(/\.0$/, "") + "%");
    setText("rname", chain ? chain.native.symbol : "—");
    setText("sname", (t.symbol || "?").toUpperCase());

    // What you pay with. Native by default; the chain's stables are the only
    // alternatives offered, because a router quote is only as good as its
    // liquidity and those are the pairs that have it.
    if (!session.pay) session.pay = chain ? nativeToken(chain) : null;
    setText("tname", session.pay ? session.pay.symbol : "—");
    if (el.tchain) {
      el.tchain.hidden = false;
      el.tchain.innerHTML = CHAIN_SVG[t.chain] || "";
    }

    const w = W.forChain(chain) || {};
    if (armed()) {
      // Say which account is about to spend, and that it will not ask.
      setText("wname", "Xeet 1-click");
      if (el.waddr) el.waddr.textContent = F.shortAddr(turboAcct().address, 4, 4);
    } else {
      setText("wname", w.address ? (w.name || "Wallet") : "Not connected");
      if (el.waddr) el.waddr.textContent = w.address ? F.shortAddr(w.address, 4, 4) : "";
    }
    // With one-click armed the deck's main button becomes the two trade halves,
    // so the CONNECT WALLET face never appears — and this row was the only way
    // left to reach the picker while looking like a label. Anyone who turned
    // one-click on could no longer connect a wallet at all, which also meant
    // no destination for "send it home". The row says so now.
    if (el.wtag) {
      const needs = !w.address;
      el.wtag.hidden = !needs;
      el.wtag.textContent = "CONNECT";
      // Armed, the row already carries the account name and a NO PROMPT badge;
      // a third thing overflows and gets clipped at the edge. The trading
      // address is in the popup either way — the missing wallet is the news.
      if (needs && el.waddr) el.waddr.textContent = "";
    }
    setText("rwname", w.address ? (w.name || "Wallet") : "Not connected");
    if (el.rwaddr) el.rwaddr.textContent = w.address ? F.shortAddr(w.address, 4, 4) : "";
    root.classList.toggle("armed", armed());

    swapButton();
    tiles();
    if (w.address || armed()) refreshBalances();
  }

  function nativeToken(chain) {
    return chain.kind === "svm"
      ? { symbol: chain.native.symbol, address: chain.native.mint, decimals: chain.native.decimals, native: true }
      : { symbol: chain.native.symbol, address: chain.native.address, decimals: chain.native.decimals, native: true };
  }

  function setSide(side) {
    if (!session) return;
    session.side = side;
    root.classList.toggle("selling", side === "sell");
    if (el.halfbuy) el.halfbuy.classList.toggle("on", side === "buy");
    if (el.halfsell) el.halfsell.classList.toggle("on", side === "sell");
    if (el.sellbox) el.sellbox.hidden = side !== "sell";
    swapButton();
    tiles();
    sizePanel();
  }

  /* THE SPLIT OR THE SENTENCE, never both.
   *
   * Direction is a choice of two and lives in the split; everything else the
   * deck can say — connect, approve, view only — is a sentence and lives in
   * the button. Showing both puts "BUY" on screen twice, once as a
   * choice and once as an instruction, and the pair reads as a bug. */
  function swapButton() {
    const b = el.swapbtn;
    if (!b || !session || !session.token) return;
    b.className = "swapbtn";
    b.hidden = false;
    if (el.split) el.split.hidden = true;

    if (session.viewOnly) {
      b.classList.add("viewonly");
      b.innerHTML = "VIEW ONLY<small>" + esc(session.viewOnlyWhy || "No route for this token") + "</small>";
      return;
    }
    if (!wallet().address && !armed()) {
      b.classList.add("connect");
      b.innerHTML = "CONNECT WALLET<small>Your keys never leave your wallet</small>";
      return;
    }
    if (session.needsApproval) {
      b.classList.add("approve");
      b.innerHTML = "APPROVE " + esc((session.token.symbol || "").toUpperCase()) + "<small>One-time, exact amount</small>";
      return;
    }

    // Nothing to say: the split takes over. The words are the actions, not
    // instructions for reaching them — the sizes are already on screen.
    b.hidden = true;
    if (!el.split) return;
    el.split.hidden = false;
    // Solo while there is nothing to sell — half a control offering an action
    // that must fail is worse than no control. "Nothing to sell" means no
    // account we can sign for holds any: the trading account when armed, the
    // wallet when connected, either of them when both are.
    const holds = sellBal().amount > 0;
    el.halfsell.hidden = !holds;
    el.halfbuy.classList.toggle("solo", !holds);
    el.halfbuy.textContent = "BUY";
    el.halfsell.textContent = "SELL";
    if (!holds && session.side === "sell") setSide("buy");
  }

  /* ----------------------------------------------------------- perps */
  /* Most tokens on a timeline have no perp market, so this row exists only
     when one does: the strip is built and removed, never hidden, so a token
     without a market cannot show a disabled control nobody can use.
     Leverage multiplies the size, not the risk disclosure — the liquidation
     price comes from the exchange after the fill, in the popup. */
  const LEVERAGE = [2, 5, 10, 20];

  function perpStrip() {
    const host = el.tiles && el.tiles.parentElement;
    const old = host && host.querySelector(".perpstrip");
    if (old) old.remove();
    if (!host || !session || session.viewOnly || session.side === "sell") return;

    /* No exchange market? Then the coin is young, which is exactly the case
       the capped product exists for — see src/micro.js for why the caps are
       the product rather than a restriction on it. */
    if (!session.perp) return microStrip(host);

    const m = session.perp;
    const lev = session.perpLev || Math.min(5, m.maxLeverage || 5);
    const row = document.createElement("div");
    row.className = "perpstrip";

    const label = document.createElement("span");
    label.className = "perplbl";
    label.textContent = "PERP " + m.name;

    const levBtn = document.createElement("button");
    levBtn.className = "perplev";
    levBtn.type = "button";
    levBtn.textContent = lev + "x";
    levBtn.title = "Leverage — up to " + (m.maxLeverage || "?") + "x";
    levBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const options = LEVERAGE.filter((v) => v <= (m.maxLeverage || 20));
      session.perpLev = options[(options.indexOf(lev) + 1) % options.length];
      perpStrip();
    });

    const mk = (side) => {
      const b = document.createElement("button");
      b.className = "perpbtn " + side;
      b.type = "button";
      b.textContent = side.toUpperCase();
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        perpTrade(side === "long", session.perpLev || lev);
      });
      return b;
    };

    row.append(label, levBtn, mk("long"), mk("short"));
    host.appendChild(row);
  }

  /* ------------------------------- leverage on a coin with no exchange */
  /* The strip appears only when the pool can carry it, and says what it can
     carry: a pool too thin for any honest size says so instead of offering a
     button that would rob whoever took it. */
  async function microStrip(host) {
    const t = session.token;
    const liq = Number(t && t.liquidity) || 0;
    const lim = await send({ type: "microLimits", liquidityUsd: liq }).catch(() => null);
    if (!lim || !lim.ok || !session || session.token !== t) return;

    const row = document.createElement("div");
    row.className = "perpstrip";

    const label = document.createElement("span");
    label.className = "perplbl";
    label.textContent = "LEVERAGE · PAPER";
    label.title = `This pool allows $${lim.maxPosition} per position at up to ${lim.maxLeverage}x. `
      + `Moving its price 10% costs about $${lim.costToMove10}, and the whole book cannot pay more than that.`;

    const lev = session.microLev || 2;
    const levBtn = document.createElement("button");
    levBtn.className = "perplev";
    levBtn.type = "button";
    levBtn.textContent = lev + "x";
    levBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const steps = [2, 3, 5].filter((v) => v <= lim.maxLeverage);
      session.microLev = steps[(steps.indexOf(lev) + 1) % steps.length];
      perpStrip();
    });

    const mk = (isLong) => {
      const b = document.createElement("button");
      b.className = "perpbtn " + (isLong ? "long" : "short");
      b.type = "button";
      b.textContent = isLong ? "LONG" : "SHORT";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        microOpen(isLong, session.microLev || lev, lim);
      });
      return b;
    };

    row.append(label, levBtn, mk(true), mk(false));
    host.appendChild(row);
  }

  async function microOpen(isLong, leverage, lim) {
    const t = session.token;
    const usd = Math.min(lim.maxPosition, (settings.buyPresets && settings.buyPresets[0]) || 5);
    try {
      const pos = await send({
        type: "microOpen",
        chain: t.chain, address: t.address, symbol: t.symbol,
        isLong, usd, leverage, entry: t.priceUsd, liquidityUsd: t.liquidity,
      });
      flipTo(reviewCard(
        (isLong ? "Long opened" : "Short opened") + " · paper",
        `$${usd} at ${leverage}x · liquidation ${F.price(pos.liq)}`,
      ));
      dismissLater();
    } catch (e) {
      flipTo(failCard("Not allowed", e.message || "rejected", false, null));
    }
  }

  /* One order, start to finish: the worker prices and packs it, the wallet
     signs the typed data, the worker posts it to the exchange. Xeet never
     holds anything — the margin lives in the user's own exchange account. */
  async function perpTrade(isBuy, leverage) {
    if (session.busy) return;
    const t = session.token;
    const usd = (settings.buyPresets && settings.buyPresets[0]) || 25;
    const w = wallet();
    if (!w.address) return walletMenu();

    session.busy = true;
    pinned = true;
    flipTo(reviewCard(
      (isBuy ? "Going long" : "Going short"),
      `${t.symbol} · $${usd} at ${leverage}x`,
    ));

    try {
      /* One approval, then taps.
         The agent may trade this account and may not move money out of it, so
         the wallet is asked once — here — and never again. After that an order
         is a tap, the way a swap is on Robinhood Chain. */
      const agent = await send({ type: "perpAgent", address: w.address }).catch(() => null);
      if (!agent || !agent.live) {
        flipTo(reviewCard("One approval first", "Your wallet authorises Xeet to place orders — it can never withdraw"));
        const ap = await send({ type: "perpAgentApproval" });
        const { signature: approval } = await W.signTyped(ap.typedData);
        await send({ type: "perpAgentConfirm", action: ap.action, nonce: ap.nonce, signature: approval });
        flipTo(reviewCard(isBuy ? "Going long" : "Going short", `${t.symbol} · $${usd} at ${leverage}x`));
      }

      const res = await send({
        type: "perpTap",
        symbol: t.symbol, isBuy, usd, leverage,
        slippagePct: (settings.slippageBps || 100) / 100,
      });
      const filled = (((res || {}).response || {}).data || {}).statuses || [];
      const px = (filled[0] && filled[0].filled && filled[0].filled.avgPx) || null;
      flipTo(reviewCard(
        isBuy ? "Long opened" : "Short opened",
        px ? `${t.symbol} at ${px}` : `${t.symbol} · ${leverage}x`,
      ));
      dismissLater();
    } catch (e) {
      flipTo(failCard("The order did not go through", e.message || "Rejected", false, null));
    } finally {
      session.busy = false;
    }
  }

  /* The tiles. Three presets and a custom field — the fourth cell is the
     field, not a fourth preset. */
  function tiles() {
    const box = el.tiles;
    if (!box) return;
    box.innerHTML = "";
    if (session.viewOnly) return;
    const sell = session.side === "sell";
    const presets = sell ? settings.sellPresets : settings.buyPresets;

    presets.forEach((v) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      const cap = document.createElement("span");
      cap.className = "cap";
      cap.textContent = sell ? v + "%" : "$" + v;
      const est = document.createElement("span");
      est.className = "est";
      est.textContent = estimateFor(v, sell);
      tile.append(cap, est);
      // A tile you cannot afford is struck through rather than hidden: the
      // sizes must stay in the same places, or the one you meant to tap moves
      // between hovers.
      if (!sell && session.payBalance != null && session.payUsd) {
        if (session.payBalance * session.payUsd < v) tile.classList.add("short");
      }
      if (sell && !sellBal().amount) tile.classList.add("short");
      tile.addEventListener("click", () => {
        if (tile.classList.contains("short")) return;
        tile.classList.add("fired");
        setTimeout(() => tile.classList.remove("fired"), 460);
        execute(v, sell);
      });
      box.appendChild(tile);
    });

    perpStrip();

    // The custom tile: a field, not a button. The dollar sign is a sibling so
    // the caret can never land in front of it.
    const c = document.createElement("div");
    c.className = "tile custom";
    c.innerHTML = sell
      ? '<span class="cap">%</span><span class="chint">custom</span>'
      : '<span class="cap">$</span><span class="chint">custom</span>';
    c.addEventListener("click", () => startCustom(c, sell));
    box.appendChild(c);
  }

  function estimateFor(v, sell) {
    const t = session.token;
    if (!t || !t.priceUsd) return "";
    if (sell) {
      const bal = sellBal().amount;
      if (!bal) return "—";
      return F.qty(bal * v / 100) + " " + (t.symbol || "").toUpperCase();
    }
    return F.qty(v / t.priceUsd) + " " + (t.symbol || "").toUpperCase();
  }

  function startCustom(tile, sell) {
    if (tile.classList.contains("typing")) return;
    tile.classList.add("typing");
    tile.innerHTML = '<span class="cwrap"><span class="cpre"></span><input class="cin" inputmode="decimal" size="1"></span>';
    tile.querySelector(".cpre").textContent = sell ? "" : "$";
    const input = tile.querySelector(".cin");
    input.addEventListener("input", () => { input.style.width = Math.max(1, input.value.length) + "ch"; });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const v = parseFloat(input.value);
        if (v > 0) { tile.classList.add("fired"); execute(v, sell); }
      }
      if (e.key === "Escape") { tile.classList.remove("typing"); tiles(); }
    });
    input.focus();
  }

  /* --------------------------------------------------------- the balances */
  async function refreshBalances() {
    const t = session.token, chain = session.chain;
    const owner = holder();
    if (!t || !chain || !owner) return;
    const pay = session.pay || nativeToken(chain);

    // Three questions, one round trip each: what you hold of the token, what
    // the native coin is worth, and — only when you are paying with something
    // other than the native coin — what you hold of that. Skipping the third
    // is what left the Selling row blank with USDC selected, which reads as
    // the panel failing rather than as a balance it never asked for.
    // Armed, with a wallet also connected, there are two accounts that could
    // hold this token. Ask both: the trading account is what one-click sells,
    // and the wallet is what it falls back to when the position was bought
    // somewhere else. Offering only one of them is how a position becomes
    // invisible to the panel that is supposed to close it.
    const other = armed() && wallet().address && wallet().address !== owner ? wallet().address : null;
    const [bal, nUsd, payBal, otherBal] = await Promise.all([
      send({ type: "balances", chain: t.chain, owner, token: t.address }).catch(() => null),
      send({ type: "nativeUsd", chain: t.chain }).catch(() => null),
      pay.native ? Promise.resolve(null)
        : send({ type: "balances", chain: t.chain, owner, token: pay.address }).catch(() => null),
      other ? send({ type: "balances", chain: t.chain, owner: other, token: t.address }).catch(() => null)
            : Promise.resolve(null),
    ]);
    if (!session || session.token !== t) return;
    session.walletBalances = otherBal;
    session.balances = bal;
    session.nativeUsd = nUsd;
    session.payUsd = pay.native ? nUsd : 1;
    session.payBalance = pay.native ? (bal && bal.native) : (payBal && payBal.token);
    if (bal && bal.tokenDecimals != null) session.tokenDecimals = bal.tokenDecimals;

    const have = session.payBalance;
    if (el.tbal) el.tbal.textContent = have != null ? F.qty(have) : "";
    if (el.tfiat) el.tfiat.textContent = have != null && session.payUsd ? F.usdShort(have * session.payUsd) : "";
    // The selling row has to name the position the SELL half would actually
    // spend, which is not always the account paying for buys.
    const s = sellBal().amount;
    if (el.sbal) el.sbal.textContent = F.qty(s);
    if (el.sfiat) el.sfiat.textContent = t.priceUsd ? F.usdShort(s * t.priceUsd) : "";
    swapButton();
    tiles();
    sizePanel();
  }

  /* ------------------------------------------------------------ the menus */
  function menu(anchorEl, items) {
    closeMenus();
    const m = document.createElement("div");
    m.className = "xeet-lp-menu";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "xeet-lp-mi";
      const a = document.createElement("span");
      a.textContent = it.label;
      const b = document.createElement("span");
      b.className = "mb";
      b.textContent = it.hint || "";
      row.append(a, b);
      row.addEventListener("click", (e) => { e.stopPropagation(); closeMenus(); it.onPick(); });
      m.appendChild(row);
    });
    anchorEl.classList.add("open");
    anchorEl.parentElement.style.position = "relative";
    anchorEl.parentElement.appendChild(m);
    const off = (e) => {
      if (m.contains(e.target)) return;
      closeMenus();
      document.removeEventListener("click", off, true);
    };
    setTimeout(() => document.addEventListener("click", off, true), 0);
  }

  function closeMenus() {
    root.querySelectorAll(".xeet-lp-menu").forEach((n) => n.remove());
    root.querySelectorAll(".seg.open").forEach((n) => n.classList.remove("open"));
    root.querySelectorAll(".wpick").forEach((n) => n.remove());
  }

  function slippageMenu(anchorEl) {
    const opts = [50, 100, 300, 500, 1000];
    menu(anchorEl, opts.map((bps) => ({
      label: (bps / 100).toString().replace(/\.0$/, "") + "%",
      hint: bps <= 100 ? "tight" : bps >= 1000 ? "very loose" : bps >= 500 ? "loose" : "",
      onPick: async () => {
        settings.slippageBps = bps;
        await send({ type: "saveSettings", patch: { slippageBps: bps } }).catch(() => {});
        setText("slp", (bps / 100).toString().replace(/\.0$/, "") + "%");
        setText("rslp", (bps / 100).toString().replace(/\.0$/, "") + "%");
      },
    })));
  }

  function payWithMenu(anchorEl) {
    const chain = session.chain;
    if (!chain) return;
    const opts = [nativeToken(chain)].concat(chain.stables || []);
    menu(anchorEl, opts.map((o) => ({
      label: o.symbol,
      hint: o.native ? "native" : "stable",
      onPick: () => {
        session.pay = o;
        setText("tname", o.symbol);
        refreshBalances();
      },
    })));
  }

  /* Which account, once the wallet has offered more than one. Replaces the
     wallet list in the same box rather than opening a second thing on top. */
  function accountMenu(box, w, say) {
    const ul = box.querySelector(".wpick-list");
    const head = box.querySelector(".wpick-h");
    if (!ul || !head) return;
    // The wallet answered; "Waiting for it to open its window" is no longer true.
    const status = box.querySelector(".wpick-status");
    if (status) { status.hidden = true; status.textContent = ""; }
    head.innerHTML = (w.accounts && w.accounts.length > 1)
      ? "Which account? <span>— " + esc(w.name) + "</span>"
      : "Trading from <span>— " + esc(w.name) + "</span>";
    ul.innerHTML = "";
    if (!w.accounts || w.accounts.length < 2) {
      say(w.name + " has only shared this one account. To use a different one, "
        + "open its own picker below and tick the accounts Xeet may see.");
    }

    (w.accounts && w.accounts.length ? w.accounts : [w.address]).forEach((addr, i) => {
      const b = document.createElement("button");
      b.className = "wpick-opt";
      b.type = "button";
      const glyph = document.createElement(w.icon && /^data:image\//.test(w.icon) ? "img" : "span");
      glyph.className = "wpick-glyph";
      if (glyph.tagName === "IMG") { glyph.src = w.icon; glyph.alt = ""; }
      else glyph.textContent = String(i + 1);
      const name = document.createElement("span");
      name.className = "wpick-name";
      name.textContent = F.shortAddr(addr, 6, 6);
      const go = document.createElement("span");
      go.className = "wpick-go";
      const isCurrent = addr.toLowerCase() === (w.address || "").toLowerCase();
      if (isCurrent) { b.classList.add("current"); go.textContent = "IN WALLET"; }
      b.append(glyph, name, go);
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await W.use(w.kind, addr);
          if (!session || !session.token) {
            say("Connected " + (w.name || "wallet") + " — " + F.shortAddr(addr, 4, 4));
            setTimeout(() => { pinned = false; close(); }, 1400);
            return;
          }
          box.remove();
          await deck();
          sizePanel();
        } catch (err) {
          say(err.message || "Could not use that account.");
        }
      });
      ul.appendChild(b);
    });

    // The list is only ever the accounts the wallet already permits. Adding one
    // it has never been shown is the wallet's own dialog, not ours.
    const more = document.createElement("button");
    more.className = "wpick-cancel";
    more.type = "button";
    more.textContent = "Choose different accounts in " + w.name;
    more.addEventListener("click", async (e) => {
      e.stopPropagation();
      more.textContent = "Waiting for " + w.name + "…";
      try {
        const next = await W.grant(w.kind);
        accountMenu(box, next, say);
      } catch (err) {
        say(err.rejected ? "You closed " + w.name + "." : (err.message || "That did not work."));
        more.textContent = "Choose different accounts in " + w.name;
      }
    });
    const old = box.querySelector(".wpick-cancel");
    if (old) old.replaceWith(more); else box.appendChild(more);
    sizePanel();
  }

  /* The wallet picker: an explicit choice, in the panel, before anything is
     requested from a provider. */
  let menuSeq = 0;
  async function walletMenu() {
    closeMenus();
    // Reading the wallet list is a round trip, and closeMenus() ran before it.
    // Two taps in that gap both pass the check and both append, so the boxes
    // stack: the top one takes the click, the ones under it stay forever and
    // are revealed when it closes — which looks exactly like the tap having
    // done nothing, and invites another tap. That is the loop this ends.
    const mine = ++menuSeq;
    // Re-read what is connected, not just what is available. Forgetting a
    // wallet from the popup writes storage; a panel already open would keep
    // marking it CONNECTED until something else happened to refresh.
    const [list] = await Promise.all([W.wallets(), W.restore()]);
    if (mine !== menuSeq) return;      // a newer tap owns the panel now
    closeMenus();                      // nothing may survive into the new one
    const box = document.createElement("div");
    box.className = "wpick";
    const head = document.createElement("div");
    head.className = "wpick-h";
    head.innerHTML = "Connect a wallet <span>— Xeet never sees your keys</span>";
    box.appendChild(head);

    // One line that carries whatever the attempt has to say. It goes under the
    // header rather than at the foot of the box: the foot sits behind the deck,
    // which is where the Cancel button has always quietly been hiding.
    const status = document.createElement("div");
    status.className = "wpick-status";
    status.hidden = true;
    const say = (text) => { status.hidden = false; status.textContent = text; sizePanel(); };
    box.appendChild(status);

    const ul = document.createElement("div");
    ul.className = "wpick-list";
    if (!list.length) {
      const p = document.createElement("div");
      p.className = "wpick-name";
      p.style.padding = "10px 2px";
      p.textContent = "No wallet found in this browser.";
      ul.appendChild(p);
    }
    list.forEach((w) => {
      const b = document.createElement("button");
      b.className = "wpick-opt";
      b.type = "button";
      const glyph = document.createElement(w.icon && /^data:image\//.test(w.icon) ? "img" : "span");
      glyph.className = "wpick-glyph";
      if (glyph.tagName === "IMG") { glyph.src = w.icon; glyph.alt = ""; }
      else glyph.textContent = w.name.slice(0, 1);
      const name = document.createElement("span");
      name.className = "wpick-name";
      name.textContent = w.name;
      const go = document.createElement("span");
      go.className = "wpick-go";
      // Say which one is already connected. A wallet that has been granted this
      // origin before returns from connect() without opening a window, so
      // choosing it looks like nothing happened — or like something connected
      // on its own. Naming the current one makes the list a choice again.
      const current = W.state[w.kind === "svm" ? "svm" : "evm"];
      const isCurrent = !!(current && current.id === w.id);
      if (isCurrent) b.classList.add("current");
      go.textContent = isCurrent ? "CONNECTED" : (w.kind === "svm" ? "SOL" : "EVM");
      b.append(glyph, name, go);
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        // "failed" in eight-pixel type at the end of a row is not a report —
        // a wallet that never opens and a wallet that threw look identical,
        // and neither says which. Say what happened, in the box, in words.
        go.textContent = "…";
        say("Waiting for " + w.name + " to open its window…");
        const slow = setTimeout(() => {
          say(w.name + " has not answered yet. If its window did not open, it may be "
            + "locked, or blocked from opening over this page — open " + w.name
            + " from the toolbar, unlock it, and try again.");
        }, 6000);
        try {
          const got = await W.connect(w.id);
          clearTimeout(slow);

          // Always ask on EVM, even when only one account came back — and one
          // is the usual answer. MetaMask reveals only the accounts it has
          // already permitted, so "no choice offered" was not the absence of
          // other accounts, it was the absence of a way to reach them. The step
          // below lists what is permitted AND opens the wallet's own picker.
          if (got.kind === "evm") return accountMenu(box, got, say);
          // Opened from the popup with no token in view: there is nothing to
          // trade here, so say it worked and get out of the way.
          if (!session || !session.token) {
            [...box.querySelectorAll(".wpick-opt")].forEach((n) => { n.disabled = true; });
            say("Connected " + (got.name || "wallet") + " — " + F.shortAddr(got.address, 4, 4));
            setTimeout(() => { pinned = false; close(); }, 1400);
            return;
          }
          box.remove();
          await deck();
          sizePanel();
        } catch (err) {
          clearTimeout(slow);
          go.textContent = err.rejected ? "declined" : "failed";
          say(err.rejected
            ? "You declined the request in " + w.name + "."
            : (err.message || "The wallet did not answer."));
          console.warn("[xeet] connect failed:", w.id, err);
        }
      });
      ul.appendChild(b);
    });
    box.appendChild(ul);

    const here = wallet();

    // Changing account later, without disconnecting first. Only shown when the
    // wallet actually permitted more than one — otherwise it is a control that
    // opens a list of length one.
    if (here.address && here.kind === "evm") {
      const switcher = document.createElement("button");
      switcher.className = "wpick-cancel";
      switcher.type = "button";
      switcher.textContent = "Switch account — " + F.shortAddr(here.address, 4, 4);
      switcher.addEventListener("click", (e) => {
        e.stopPropagation();
        accountMenu(box, here, say);
      });
      box.appendChild(switcher);
    }

    const cancel = document.createElement("button");
    cancel.className = "wpick-cancel";
    cancel.type = "button";
    cancel.textContent = here.address ? "Disconnect " + F.shortAddr(here.address, 4, 4) : "Cancel";
    cancel.addEventListener("click", async (e) => {
      e.stopPropagation();
      // Forgetting a public address is all a disconnect is — nothing was ever
      // granted to us in the wallet that could need revoking.
      if (here.address) { await W.forget(here.kind); await deck(); }
      box.remove();
    });
    box.appendChild(cancel);

    root.querySelector(".face.front").appendChild(box);
  }

  function onSwapBtn(e) {
    e.stopPropagation();
    if (session.viewOnly) return;
    if (!wallet().address) return walletMenu();
    if (session.needsApproval) return approve();
  }

  /* ----------------------------------------------------------- the trade */
  /* Every path through here ends on the back face: a review while the wallet
     is deciding, then a result. Nothing is ever signed without the wallet's
     own confirmation window, which Xeet cannot draw, suppress, or pre-fill. */
  async function execute(value, sell) {
    if (session.busy) return;
    const t = session.token, chain = session.chain;
    if (!chain) return;

    // ONE CLICK, when it is switched on and this trade is inside its caps.
    // A sale goes this way only when the position is actually in the trading
    // account: one-click cannot sign for your wallet, and a tap that silently
    // sold from a different account than the one on screen would be worse
    // than a prompt. When the wallet is the one holding it, fall through.
    const mine = sell ? sellBal().viaTurbo : true;
    if (mine && turbo.settings.on && turboAcct(chain) && !session.viewOnly) {
      const gate = await send({ type: "turboAllow", chain: t.chain, usd: value, sell }).catch(() => null);
      if (gate && gate.ok) return oneClickTrade(value, sell);
    }

    if (!wallet().address) return walletMenu();

    session.busy = true;
    pinned = true;
    flipTo(reviewCard("Building the route", `${sell ? "Selling" : "Buying"} ${t.symbol} on ${chain.name}`));

    try {
      await W.ensureChain(chain);

      const tokenLeg = { address: t.address, decimals: session.tokenDecimals ?? (chain.kind === "svm" ? 9 : 18), symbol: t.symbol };
      let from, to, amount;
      if (sell) {
        const bal = sellBal().amount;
        if (!bal) throw new Error(`You hold no ${t.symbol} in this wallet`);
        from = tokenLeg;
        to = nativeToken(chain);
        amount = bal * (value / 100);
      } else {
        const pay = session.pay || nativeToken(chain);
        const usd = pay.native ? (session.nativeUsd || await send({ type: "nativeUsd", chain: t.chain })) : 1;
        if (!usd) throw new Error(`Could not price ${pay.symbol}`);
        from = pay;
        to = tokenLeg;
        amount = value / usd;
      }

      const q = await send({
        type: "quote", chain: t.chain, owner: wallet().address,
        from: { address: from.address, decimals: from.decimals },
        to: { address: to.address, decimals: to.decimals },
        amount, slippageBps: settings.slippageBps,
      });

      if (q.needsApproval) {
        session.needsApproval = true;
        session.pendingApproval = { spender: q.approvalAddress, amount: q.approvalAmount, token: from.address };
        session.pendingTrade = { value, sell };
        root.classList.add("needsapprove");
        swapButton();
        return flipBack(() => {
          session.busy = false;
          pinned = false;
        });
      }

      flipTo(reviewCard(
        "Confirm in your wallet",
        `${F.qty(q.inAmount)} ${from.symbol} → ${F.qty(q.outAmount)} ${to.symbol}`,
        { q, from, to }
      ));

      const built = await send({ type: "build", chain: t.chain, owner: wallet().address, quote: q });
      const sent = built.kind === "svm"
        ? await W.send.svm(built.transaction)
        : await W.send.evm(built.tx);

      flipTo(reviewCard("Sent — waiting for the chain", F.shortAddr(sent.hash, 8, 8), { q, from, to }));

      const res = await send({ type: "confirm", chain: t.chain, hash: sent.hash });
      const usdValue = sell ? (q.outAmount * (session.nativeUsd || 0)) : (t.priceUsd ? q.outAmount * t.priceUsd : null);

      await send({
        type: "record",
        entry: {
          at: Date.now(), chain: t.chain, hash: sent.hash, side: sell ? "sell" : "buy",
          symbol: t.symbol, address: t.address, image: t.image || null,
          inAmount: q.inAmount, inSymbol: from.symbol,
          outAmount: q.outAmount, outSymbol: to.symbol,
          usd: usdValue, status: res.ok === true ? "confirmed" : res.ok === false ? "failed" : "pending",
        },
      }).catch(() => {});

      if (res.ok === false) {
        flipTo(failCard("It did not go through", res.reason || "The transaction failed on chain", false, sent.hash));
      } else {
        flipTo(finishCard(q, from, to, sent.hash, res.ok === null));
        // The celebration is a moment, not a state. Left alone it turns and
        // recedes — the panel was pinned for the trade and must not stay
        // pinned once the trade is over.
        dismissLater();
      }
      refreshBalances();
    } catch (err) {
      const rejected = err && err.rejected;
      flipTo(failCard(
        rejected ? "You cancelled it" : "That did not work",
        rejected ? "Nothing was sent, and nothing was spent." : (err.message || "Unknown error"),
        rejected
      ));
    } finally {
      session.busy = false;
    }
  }

  /* The tap IS the trade. No wallet window, because the account signing is
     one this extension generated and holds — see src/turbo.js for what that
     account is allowed to do and how little it is allowed to hold.

     Both directions come through here. A buy is priced in dollars; a sell is
     a share of the position, the same as everywhere else in the panel. */
  async function oneClickTrade(value, sell) {
    const t = session.token, chain = session.chain;
    session.busy = true;
    pinned = true;

    // The fallback has to follow the chain: eighteen places on Robinhood and
    // nine on Solana. One default for both sizes every trade on the other
    // chain a billion times wrong.
    const dec = session.tokenDecimals ?? (chain.kind === "svm" ? 9 : 18);
    const native = nativeToken(chain);
    const tokenLeg = { address: t.address, symbol: t.symbol, decimals: dec };
    const from = sell ? tokenLeg : native;
    const to = sell ? native : tokenLeg;

    flipTo(reviewCard(
      sell ? "Selling" : "Buying",
      (sell ? `${value}% of your ${t.symbol}` : `$${value} of ${t.symbol}`) + " · one click"
    ));

    try {
      const payUsd = session.nativeUsd || await send({ type: "nativeUsd", chain: t.chain });
      if (!payUsd) throw new Error("could not price " + chain.native.symbol);

      let amount, usd;
      if (sell) {
        const bal = sellBal().amount;
        if (!bal) throw new Error(`The trading account holds no ${t.symbol}`);
        amount = bal * (value / 100);
        // Only for the caps and the history row; the trade itself is priced
        // by the router, not by this number.
        usd = t.priceUsd ? amount * t.priceUsd : 0;
      } else {
        amount = value / payUsd;
        usd = value;
      }

      const res = await send({
        type: "oneClick", chain: t.chain, usd, sell,
        from: { address: from.address, decimals: from.decimals },
        to: { address: to.address, decimals: to.decimals },
        amount, slippageBps: settings.slippageBps,
      });

      flipTo(reviewCard("Sent — waiting for the chain", F.shortAddr(res.hash, 8, 8), { q: res.quote, from, to }));
      const done = await send({ type: "confirm", chain: t.chain, hash: res.hash });
      await send({
        type: "record",
        entry: {
          at: Date.now(), chain: t.chain, hash: res.hash, side: sell ? "sell" : "buy",
          symbol: t.symbol, address: t.address, image: t.image || null,
          inAmount: res.quote.inAmount, inSymbol: from.symbol,
          outAmount: res.quote.outAmount, outSymbol: to.symbol,
          usd, status: done.ok === true ? "confirmed" : done.ok === false ? "failed" : "pending",
          oneClick: true,
        },
      }).catch(() => {});
      if (done.ok === false) {
        flipTo(failCard("It did not go through", done.reason || "The transaction failed on chain", false, res.hash));
      } else {
        flipTo(finishCard(res.quote, from, to, res.hash, done.ok === null));
        dismissLater();
      }
      refreshTurbo();
      refreshBalances();
    } catch (err) {
      flipTo(failCard("One-click could not run", err.message || "", false));
    } finally {
      session.busy = false;
    }
  }

  async function approve() {
    const p = session.pendingApproval;
    if (!p) return;
    session.busy = true;
    pinned = true;
    flipTo(reviewCard("Approve in your wallet", `Letting the router move exactly ${session.token.symbol}`));
    try {
      const built = await send({
        type: "approval", chain: session.token.chain, owner: wallet().address,
        token: p.token, spender: p.spender, amount: p.amount,
      });
      const sent = await W.send.evm(built.tx);
      await send({ type: "confirm", chain: session.token.chain, hash: sent.hash });
      session.needsApproval = false;
      session.pendingApproval = null;
      root.classList.remove("needsapprove");
      swapButton();
      flipBack(() => {
        session.busy = false;
        pinned = false;
        const pt = session.pendingTrade;
        session.pendingTrade = null;
        if (pt) execute(pt.value, pt.sell);
      });
    } catch (err) {
      session.busy = false;
      flipTo(failCard(err.rejected ? "You cancelled it" : "Approval failed", err.message || "", !!err.rejected));
    }
  }

  /* ------------------------------------------------------- the back face */
  function flipTo(node) {
    back.innerHTML = "";
    back.appendChild(node);
    loupe.classList.add("flipping", "confirmed");
    fitBack();
  }

  /* .finishing is loupe.css's own dismissal: the card keeps its turn, shrinks
     and fades, so the success screen never flashes its reverse on the way
     out. Hovering the card cancels it — reading your own receipt should not
     be a race. */
  let dismissTimer = null;
  function dismissLater(ms) {
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      if (!session || !loupe.classList.contains("confirmed")) return;
      // The pointer is still on the card — they are reading the receipt, and
      // a receipt that vanishes while you read it is worse than one that
      // lingers. Ask again shortly.
      if (overPanel) return dismissLater(4000);
      loupe.classList.add("finishing");
      setTimeout(() => { pinned = false; close(); }, 460);
    }, ms || 7000);
  }

  function flipBack(after) {
    loupe.classList.remove("confirmed");
    setTimeout(() => {
      loupe.classList.remove("flipping");
      back.innerHTML = '<div class="review"></div>';
      loupe.classList.add("open");
      sizePanel();
      if (after) after();
    }, 560);
  }

  function reviewCard(title, sub, ctx) {
    const d = document.createElement("div");
    d.className = "review";
    d.innerHTML = '<div class="rh"><div class="spin"></div><div class="rt"><div class="t"></div><div class="st"></div></div></div>';
    d.querySelector(".t").textContent = title;
    d.querySelector(".st").textContent = sub;
    if (ctx && ctx.q) {
      const legs = document.createElement("div");
      legs.style.cssText = "margin-top:14px;display:flex;flex-direction:column;gap:9px";
      legs.append(leg("You pay", F.qty(ctx.q.inAmount) + " " + ctx.from.symbol, false),
        leg("You receive", F.qty(ctx.q.outAmount) + " " + ctx.to.symbol, true));
      d.appendChild(legs);
      const foot = document.createElement("div");
      foot.className = "fin-meta";
      foot.style.marginTop = "auto";
      foot.innerHTML = "<span></span><span class='dot'>·</span><span></span>";
      const spans = foot.querySelectorAll("span");
      spans[0].textContent = "via " + ctx.q.via;
      spans[2].textContent = "min " + F.qty(ctx.q.minOut) + " " + ctx.to.symbol;
      d.appendChild(foot);
    }
    return d;
  }

  function leg(label, amount, recv) {
    const b = document.createElement("div");
    b.className = "legbox";
    b.innerHTML = '<div><div class="lbl"></div><div class="amt"></div></div>';
    b.querySelector(".lbl").textContent = label;
    const a = b.querySelector(".amt");
    a.textContent = amount;
    if (recv) a.classList.add("recv");
    return b;
  }

  function finishCard(q, from, to, hash, pending) {
    const d = document.createElement("div");
    d.className = "fin";
    d.innerHTML =
      '<button class="fin-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
      '<div class="fin-badge"><span class="fin-ring"></span><span class="fin-ring d2"></span>' +
      '<span class="fin-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7"/></svg></span></div>' +
      '<div class="fin-title"></div><div class="fin-sub"></div>' +
      '<div class="fin-recv"><div class="fin-recv-lbl">You received</div><div class="fin-recv-amt"></div><div class="fin-recv-fiat"></div></div>' +
      '<div class="fin-actions"></div>' +
      '<div class="fin-meta"><span></span><span class="dot">·</span><span></span></div>';

    d.querySelector(".fin-title").textContent = pending ? "Sent" : "Done";
    d.querySelector(".fin-sub").textContent = pending
      ? "Still confirming — it is on its way"
      : `${F.qty(q.inAmount)} ${from.symbol} swapped`;
    d.querySelector(".fin-recv-amt").textContent = F.qty(q.outAmount) + " " + to.symbol;
    const usd = session.token.priceUsd && to.address === session.token.address
      ? q.outAmount * session.token.priceUsd
      : (session.nativeUsd && to.native ? q.outAmount * session.nativeUsd : null);
    d.querySelector(".fin-recv-fiat").textContent = usd ? "≈ " + F.usdShort(usd) : "";

    const actions = d.querySelector(".fin-actions");
    const chain = session.chain;

    const view = document.createElement("button");
    view.className = "fin-watch";
    view.type = "button";
    view.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg><span>View on explorer</span>';
    view.addEventListener("click", () => window.open(chain.explorer + hash, "_blank", "noopener"));
    actions.appendChild(view);

    // EVM tokens do not show up in a wallet on their own; one tap makes the
    // balance you just bought visible where you keep it.
    if (chain.kind === "evm" && to.address === session.token.address) {
      const watch = document.createElement("button");
      watch.className = "fin-watch";
      watch.type = "button";
      watch.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><span>Add to wallet</span>';
      watch.addEventListener("click", async () => {
        watch.disabled = true;
        try {
          await W.watchAsset({
            address: session.token.address, symbol: session.token.symbol,
            decimals: session.tokenDecimals ?? 18, image: session.token.image,
          });
          watch.classList.add("done");
          watch.querySelector("span").textContent = "Added";
        } catch { watch.disabled = false; }
      });
      actions.appendChild(watch);
    }

    /* The card. Offered on every finished trade, because the moment somebody
       wants to show a trade is the moment it lands — not later, from a list.
       The multiple is computed from THIS device's history and appears only
       when that history covers the whole position; see src/card.js. */
    if (window.XEET_CARD) {
      const share = document.createElement("button");
      share.className = "fin-watch";
      share.type = "button";
      share.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 14l4.5-4.5 4 4 3-3L21 15"/></svg><span>Trade card</span>';
      share.addEventListener("click", async () => {
        const label = share.querySelector("span");
        share.disabled = true;
        label.textContent = "Drawing…";
        try {
          const history = await send({ type: "history" }).catch(() => []);
          const entry = {
            // which way round it went, read off the legs rather than passed in
            at: Date.now(),
            side: from.address === session.token.address ? "sell" : "buy",
            address: session.token.address,
            inAmount: q.inAmount, outAmount: q.outAmount, usd: usd || 0,
          };
          const blob = await window.XEET_CARD.drawCard({
            side: entry.side,
            symbol: session.token.symbol,
            chainName: chain.name,
            inAmount: q.inAmount, inSymbol: from.symbol,
            outAmount: q.outAmount, outSymbol: to.symbol,
            usd,
            multiple: window.XEET_CARD.multipleFrom(history, entry),
          }, chrome.runtime.getURL("icons/icon128.png"),
             chrome.runtime.getURL("assets/shards.jpg"));
          const how = await window.XEET_CARD.deliver(
            blob, `xeet-${(session.token.symbol || "trade").toLowerCase()}.png`);
          share.classList.add("done");
          label.textContent = how === "copied" ? "Copied — paste it in a post" : "Saved to downloads";
        } catch (e) {
          label.textContent = "Could not draw it";
        } finally {
          setTimeout(() => { share.disabled = false; }, 400);
        }
      });
      actions.appendChild(share);
    }

    const meta = d.querySelectorAll(".fin-meta span");
    meta[0].textContent = "via " + q.via;
    meta[2].textContent = FEE.solanaFeeAccount || FEE.evmIntegrator
      ? FEE.label + " fee" : "no fee taken";

    d.querySelector(".fin-close").addEventListener("click", () => { pinned = false; close(); });
    return d;
  }

  function failCard(title, msg, cancelled, hash) {
    const d = document.createElement("div");
    d.className = "fin fail" + (cancelled ? " cancelled" : "");
    d.innerHTML =
      '<div class="fin-badge"><span class="fin-ring"></span>' +
      '<span class="fin-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></span></div>' +
      '<div class="fin-title"></div>' +
      '<div class="fail-reason" style="margin-top:12px;padding:10px 12px;border:1px solid rgba(242, 244, 243,.3);border-radius:11px;background:rgba(242, 244, 243,.07);width:100%">' +
      '<div class="fail-reason-lbl" style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:rgba(242, 244, 243,.95)">Reason</div>' +
      '<div class="fail-reason-msg" style="font-size:11.5px;color:#FFFFFF;margin-top:3px"></div></div>' +
      '<div class="fin-actions"></div>';
    d.querySelector(".fin-title").textContent = title;
    d.querySelector(".fail-reason-msg").textContent = msg;

    const actions = d.querySelector(".fin-actions");
    const back_ = document.createElement("button");
    back_.className = "fin-watch";
    back_.type = "button";
    back_.innerHTML = "<span>Back to the token</span>";
    back_.addEventListener("click", () => { pinned = false; session && (session.busy = false); flipBack(); });
    actions.appendChild(back_);
    if (hash && session && session.chain) {
      const v = document.createElement("button");
      v.className = "fin-watch";
      v.type = "button";
      v.innerHTML = "<span>View on explorer</span>";
      v.addEventListener("click", () => window.open(session.chain.explorer + hash, "_blank", "noopener"));
      actions.appendChild(v);
    }
    return d;
  }

  /* ----------------------------------------------------------- utilities */
  function copyCA(btn, address) {
    if (!address) return;
    navigator.clipboard.writeText(address).then(
      () => { btn.classList.add("copied"); setTimeout(() => btn.classList.remove("copied"), 1200); },
      () => {}
    );
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* A price on screen goes stale in seconds. The refresh is cheap (one cached
     lookup) and stops the moment the panel closes. */
  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(async () => {
      if (!session || !session.token || session.busy || loupe.classList.contains("confirmed")) return;
      try {
        const r = await send({ type: "resolve", query: session.token.address, chainHint: session.token.chain });
        if (!session || !r.token || r.token.address !== session.token.address) return;
        session.token = r.token;
        setText("price", F.price(r.token.priceUsd));
        const c = Number(r.token.change.h24 ?? 0);
        setText("chg", F.pct(c));
        el.chg.classList.toggle("up", c >= 0);
        el.chg.classList.toggle("dn", c < 0);
        setText("mcap", F.usdShort(r.token.marketCap));
        setText("liq", F.usdShort(r.token.liquidity));
        setText("vol", F.usdShort(r.token.volume && r.token.volume.h24));
        flowBar();
      } catch { /* a stale price is better than a broken panel */ }
    }, 12000);
  }
  function stopRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  /* Scroll fires far more often than the screen redraws, and place() reads
     getBoundingClientRect and offsetHeight before it writes — a forced layout
     every single event, on a timeline that is already expensive to lay out.
     One reposition per frame is all a frame can show anyway. */
  let placing = false;
  function reposition() {
    if (placing) return;
    placing = true;
    requestAnimationFrame(() => {
      placing = false;
      if (session && session.anchor && host && !host.classList.contains("xeet-hidden")) place(session.anchor);
    });
  }
  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && session) { pinned = false; close(); }
  });

  /* Opening the wallet picker with no token in view: the popup asks for this
     when somebody taps Connect there. The panel mounts against the middle of
     the page and shows the picker alone. */
  let ghostAnchor = null;
  function connectWallet() {
    mount();
    // One anchor, reused. A fresh span per tap left a zero-size element in the
    // page for every time somebody pressed Connect.
    const ghost = ghostAnchor || (ghostAnchor = document.createElement("span"));
    ghost.style.cssText = "position:fixed;left:50%;top:140px;width:0;height:0";
    if (!ghost.isConnected) document.body.appendChild(ghost);
    cancelClose();
    overAnchor = true;
    pinned = true;
    session = session || { anchor: ghost, spec: {}, token: null, range: "24h", side: "buy" };
    session.anchor = ghost;
    host.classList.remove("xeet-hidden");
    place(ghost);
    walletMenu();
  }

  g.XEET_PANEL = {
    open, close, leaveAnchor, connectWallet,
    enterAnchor: () => { overAnchor = true; cancelClose(); },
    isOpen: () => !!session,
    current: () => session && session.token,
    setSettings: (s) => { settings = Object.assign(settings, s); },
    stageFor,
  };
})(window);
