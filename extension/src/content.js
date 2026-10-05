/* Xeet — the scanner.
 *
 * x.com is one long React tree that rewrites itself constantly, so this file
 * assumes nothing survives. It marks what it can see now, watches for what
 * arrives next, and treats its own marks as disposable: if a re-render wipes
 * them, the next pass puts them back.
 *
 * What it reads: post text, and only post text. Not your timeline as a whole,
 * not the accounts you follow, not your DMs — the selectors below are the
 * entire surface, and nothing read here is sent anywhere. A symbol is looked
 * up by name; the lookup carries no identity.
 *
 * What it writes: a class on a cashtag, and a span around a contract address.
 * Nothing else on the page is touched. */

(() => {
  "use strict";

  const P = window.XEET_PANEL;
  const CFG = window.XEET_CFG;

  let settings = { on: true, hoverDelay: 130, scanCashtags: true, scanAddresses: true };

  const send = (msg) => new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(le.message));
        if (!res) return reject(new Error("no answer"));
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      });
    } catch (e) { reject(e); }
  });

  send({ type: "settings" }).then((s) => {
    settings = s;
    P.setSettings(s);
    if (!settings.on) unmarkAll();
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k in changes) settings[k] = changes[k].newValue;
    P.setSettings(settings);
    if (!settings.on) { unmarkAll(); P.close(); } else scan();
  });

  /* ------------------------------------------------------------- patterns */
  // A cashtag: $ then a letter, then up to 14 more. Bounded on both sides so
  // "$5" and "US$" never match, and neither does the middle of a URL.
  const RE_CASH = /(^|[^A-Za-z0-9_$/])\$([A-Za-z][A-Za-z0-9_]{1,14})\b/g;
  const RE_EVM = /\b0x[a-fA-F0-9]{40}\b/g;
  // Base58 has no 0, O, I or l. A 32+ character run of the rest, carrying both
  // a digit and a capital, is an address and not an English word.
  const RE_SOL = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

  // Tickers that are common words, currency codes, or X's own furniture. A
  // panel that opens on "$IF" or "$USD" trains people to ignore the panel.
  const SKIP = new Set([
    "USD", "EUR", "GBP", "JPY", "CNY", "RUB", "CAD", "AUD", "CHF", "INR", "BRL",
    "IF", "IT", "IS", "IN", "ON", "OR", "AT", "TO", "BE", "SO", "NO", "OK",
    "THE", "AND", "FOR", "YOU", "ARE", "NOT", "BUT", "ALL", "CAN", "GET", "WHY",
    "K", "M", "B", "T", "X", "USDX",
  ]);

  // A digit and a capital. Base58 excludes 0, O, I and l, so a 32+ character
  // run of the rest carrying both is an address; requiring a capital is what
  // keeps it off long lowercase words, and dropping the old lowercase
  // requirement is what stops it missing the mints that have none.
  function isSolAddr(s) {
    return s.length >= 32 && /[0-9]/.test(s) && /[A-Z]/.test(s);
  }

  /* --------------------------------------------------------------- marks */
  const MARK = "xeet-tag";
  const seenSymbols = new Map(); // SYMBOL → { stage, at }
  const STAGE_TTL = 3 * 60 * 1000;

  function markLink(a) {
    if (a.dataset.xeet) return;
    const text = (a.textContent || "").trim();
    const m = /^\$([A-Za-z][A-Za-z0-9_]{1,14})$/.exec(text);
    if (!m) return;
    const sym = m[1].toUpperCase();
    if (SKIP.has(sym)) return;
    a.dataset.xeet = "1";
    a.dataset.xeetQuery = "$" + sym;
    a.classList.add(MARK);
    attach(a);
    watchStage(a, sym);
  }

  /* Wrapping a text node inside someone else's React tree is a borrowed
     seat: the moment X re-renders that post the wrapper is gone. That is
     fine — scan() runs again and puts it back — but it must never throw, so
     every mutation here is guarded and reverts cleanly on failure. */
  function markText(node) {
    const text = node.nodeValue;
    if (!text || text.length < 3) return false;
    if (!node.parentElement) return false;

    const hits = [];
    let m;
    if (settings.scanCashtags) {
      RE_CASH.lastIndex = 0;
      while ((m = RE_CASH.exec(text))) {
        const sym = m[2].toUpperCase();
        if (SKIP.has(sym)) continue;
        const start = m.index + m[1].length;
        hits.push({ start, end: start + 1 + m[2].length, query: "$" + sym, sym, kind: "sym" });
      }
    }
    if (settings.scanAddresses) {
      RE_EVM.lastIndex = 0;
      while ((m = RE_EVM.exec(text))) hits.push({ start: m.index, end: m.index + m[0].length, query: m[0], kind: "ca" });
      RE_SOL.lastIndex = 0;
      while ((m = RE_SOL.exec(text))) {
        if (!isSolAddr(m[0])) continue;
        if (hits.some((h) => m.index < h.end && m.index + m[0].length > h.start)) continue;
        hits.push({ start: m.index, end: m.index + m[0].length, query: m[0], kind: "ca" });
      }
    }
    if (!hits.length) return false;
    hits.sort((a, b) => a.start - b.start);

    const frag = document.createDocumentFragment();
    let at = 0;
    for (const h of hits) {
      if (h.start < at) continue;
      if (h.start > at) frag.appendChild(document.createTextNode(text.slice(at, h.start)));
      const span = document.createElement("span");
      span.className = MARK + (h.kind === "ca" ? " xeet-ca" : "");
      span.textContent = text.slice(h.start, h.end);
      span.dataset.xeet = "1";
      span.dataset.xeetQuery = h.query;
      attach(span);
      if (h.kind === "sym") watchStage(span, h.sym);
      frag.appendChild(span);
      at = h.end;
    }
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));

    // No "already wrapped" flag on the parent. The text nodes this creates
    // live inside .xeet-tag spans, which the walker rejects, so a second pass
    // cannot double-wrap them — while a sticky flag would make the parent
    // permanently unscannable and leave a re-rendered post bare forever.
    try {
      node.replaceWith(frag);
      return true;
    } catch {
      return false;
    }
  }

  function unmarkAll() {
    document.querySelectorAll("." + MARK).forEach((n) => {
      n.classList.remove(MARK, "xeet-warm", "xeet-running", "xeet-sending", "xeet-live");
      delete n.dataset.xeet;
    });
  }

  /* ------------------------------------------------------------- hovering */
  let hoverTimer = null;

  function attach(node) {
    node.addEventListener("mouseenter", () => {
      P.enterAnchor();
      clearTimeout(hoverTimer);
      const delay = settings.hoverDelay ?? 130;
      hoverTimer = setTimeout(() => {
        if (!settings.on) return;
        document.querySelectorAll(".xeet-live").forEach((n) => n.classList.remove("xeet-live"));
        node.classList.add("xeet-live");
        P.open(node, { query: node.dataset.xeetQuery, symbol: node.dataset.xeetQuery.replace("$", "") });
      }, delay);
    });
    node.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      node.classList.remove("xeet-live");
      P.leaveAnchor();
    });
    // A marked cashtag inside a post: clicking it should open the panel, not
    // navigate to X's own cashtag search page mid-hover.
    node.addEventListener("click", (e) => {
      if (!settings.on) return;
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(hoverTimer);
      P.enterAnchor();
      P.open(node, { query: node.dataset.xeetQuery });
    });
  }

  /* ------------------------------------- the run stage, painted on the tag */
  /* "Runners light up before you hover." One lookup per symbol per three
     minutes, at most two in flight, and only for tags that are actually on
     screen — a timeline holds hundreds of cashtags and none of them is worth
     a request while it is a thousand pixels below the fold. */
  const queue = [];
  const queued = new Set();
  let running = 0;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const sym = e.target.dataset.xeetSym;
      if (!sym) continue;
      const known = seenSymbols.get(sym);
      if (known && Date.now() - known.at < STAGE_TTL) { paint(e.target, known.stage); continue; }
      if (queued.has(sym)) continue;
      queued.add(sym);
      queue.push(sym);
      pump();
    }
  }, { rootMargin: "120px" });

  function watchStage(node, sym) {
    node.dataset.xeetSym = sym;
    const known = seenSymbols.get(sym);
    if (known && Date.now() - known.at < STAGE_TTL) return paint(node, known.stage);
    io.observe(node);
  }

  function pump() {
    while (running < 2 && queue.length) {
      const sym = queue.shift();
      running++;
      send({ type: "resolve", query: "$" + sym })
        .then((r) => {
          const stage = r && r.token ? P.stageFor(r.token, "m5") : "quiet";
          seenSymbols.set(sym, { stage, at: Date.now() });
          document.querySelectorAll(`[data-xeet-sym="${cssEsc(sym)}"]`).forEach((n) => paint(n, stage));
        })
        .catch(() => { seenSymbols.set(sym, { stage: "quiet", at: Date.now() }); })
        .finally(() => {
          running--;
          queued.delete(sym);
          setTimeout(pump, 260); // Dexscreener is generous, not infinite
        });
    }
  }

  function paint(node, stage) {
    node.classList.remove("xeet-warm", "xeet-running", "xeet-sending");
    if (stage && stage !== "quiet") node.classList.add("xeet-" + stage);
  }

  function cssEsc(s) { return s.replace(/["\\]/g, "\\$&"); }

  /* ------------------------------------------------------------ scanning */
  const TWEET = '[data-testid="tweetText"]';
  const BIO = '[data-testid="UserDescription"]';
  const NAME = '[data-testid="UserName"]';

  function scan(rootNode) {
    if (!settings.on) return;
    const scope = rootNode && rootNode.querySelectorAll ? rootNode : document;

    // X links cashtags itself; those anchors are the cheapest and safest mark.
    scope.querySelectorAll('a[href*="cashtag"], a[href*="q=%24"]').forEach(markLink);

    const blocks = [];
    if (scope.matches && scope.matches(`${TWEET}, ${BIO}, ${NAME}`)) blocks.push(scope);
    scope.querySelectorAll(`${TWEET}, ${BIO}, ${NAME}`).forEach((n) => blocks.push(n));

    for (const block of blocks) {
      // Two conditions, and both are needed. The signature catches an edited
      // or replaced post; the presence check catches the case that a
      // signature alone misses — React re-rendering the same text and
      // throwing away our spans, which leaves the signature identical and the
      // marks gone. Blocks with nothing to mark carry xeetNone so they are not
      // re-walked on every frame forever.
      const sig = block.textContent.length + ":" + block.textContent.slice(0, 24);
      if (block.dataset.xeetSig === sig &&
        (block.dataset.xeetNone === "1" || block.querySelector("." + MARK))) continue;
      block.dataset.xeetSig = sig;
      let made = 0;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest("a") || p.classList.contains(MARK)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      for (const node of nodes) if (markText(node)) made++;
      if (!made && block.querySelector("." + MARK)) made = 1; // X linked it for us
      block.dataset.xeetNone = made ? "0" : "1";
    }
  }

  /* The feed never stops arriving, so the observer is debounced into one pass
     rather than one pass per mutation — X emits hundreds while a single post
     renders.
     A timer, not requestAnimationFrame: rAF does not run in a background tab,
     and a timeline left open in another tab keeps rendering posts. With rAF
     the marks for everything that arrived while you were away only appeared
     after the next mutation once you came back. */
  let pending = false;
  const mo = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; scan(); }, 16);
  });

  // Coming back to the tab is itself a reason to look: x.com re-renders on
  // focus and can drop every mark in one pass.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scan(); });

  function boot() {
    scan();
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);

  // Opening a token from the popup — a board row, or a contract somebody
  // pasted into the find field. The panel appears centred, with no tag under
  // it to anchor to.
  function openCentred(query, chain) {
    const ghost = document.createElement("span");
    ghost.style.cssText = "position:fixed;left:50%;top:120px;width:0;height:0";
    document.body.appendChild(ghost);
    P.enterAnchor();
    P.open(ghost, { query, chainHint: chain });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "openToken") return openCentred(msg.query, msg.chain);
    // The popup's Connect card: only the panel can ask, because the wallet's
    // own window opens over the page, not over a popup that closes the
    // moment it loses focus.
    if (msg.type === "connectWallet") return P.connectWallet();
  });

  // The popup can also ask for a token when no timeline was in front of it: it
  // leaves the request in storage and opens x.com, and this is where that
  // request lands. Sixty seconds, because a stale one would ambush somebody
  // opening X for an unrelated reason later.
  // Same handover for Connect: the popup cannot open a wallet's window, so it
  // parks the request and opens X, and this is where it lands.
  chrome.storage.local.get({ pendingConnect: null }).then((got) => {
    const req = got.pendingConnect;
    if (!req) return;
    chrome.storage.local.remove("pendingConnect");
    if (Date.now() - (req.at || 0) > 60000) return;
    setTimeout(() => P.connectWallet(), 700);
  }).catch(() => {});

  chrome.storage.local.get({ pendingOpen: null }).then((got) => {
    const req = got.pendingOpen;
    if (!req || !req.query) return;
    chrome.storage.local.remove("pendingOpen");
    if (Date.now() - (req.at || 0) > 60000) return;
    setTimeout(() => openCentred(req.query, req.chain), 700);
  }).catch(() => {});
})();
