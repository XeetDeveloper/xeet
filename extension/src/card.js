/* Xeet — the trade card.
 *
 * A picture of a swap that just happened, drawn to be posted. It is the only
 * thing in the product that leaves the browser on purpose, so two rules shape
 * it: NOTHING ON IT IS INVENTED, and nothing on it identifies the person.
 *
 *   - Every number comes from the trade that was signed — amounts in and out,
 *     the token, the chain, the time. Where a multiple is shown it was
 *     computed from this device's own history of that token, and when there is
 *     no history there is no multiple, rather than a flattering guess.
 *   - No wallet address, no balance, no portfolio total. A screenshot of a win
 *     should not also be a map to the account that made it.
 *
 * Drawn on a canvas rather than built in the DOM: the result has to survive
 * being copied into a post, and an image is the only thing a timeline accepts.
 *
 * A plain script, not a module: it is injected alongside the panel as a
 * content script, and content scripts are not modules. What it offers is
 * hung on window.XEET_CARD at the bottom, the way chains.js and marks.js do.
 */
(() => {

const W = 1200, H = 675;                     // 16:9, the shape X renders largest
const INK = "#FFFFFF", DIM = "rgba(255,255,255,.62)";

/* COLOUR, AND WHY THIS ONE FILE HAS IT.
 *
 * Everything else in Xeet is black and white on purpose. A card is the one
 * thing that leaves for somebody else's timeline, where it competes with
 * three hundred other images, and monochrome loses that fight.
 *
 * The colour is not decoration either — it is the result. Green when the
 * position came out ahead, red when it did not, violet for a buy, which has
 * no outcome yet. Nobody has to read the number to know which happened. */
const PALETTES = {
  win:  { a: "#00E08A", b: "#19C3FF", ink: "#001B12" },
  loss: { a: "#FF4D6D", b: "#FF9A3D", ink: "#230008" },
  buy:  { a: "#7C5CFF", b: "#22D3EE", ink: "#0B0620" },
};

const DISP = '800 1px "Manrope", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '1px ui-monospace, "JetBrains Mono", Menlo, monospace';

const font = (spec, px, weight) =>
  spec.replace(/^(\d+ )?1px/, (weight ? weight + " " : "") + px + "px");

/* Rounded rectangles, because every box on the card is one. */
function box(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

const qty = (n) => {
  const v = Math.abs(Number(n) || 0);
  if (v === 0) return "0";
  if (v >= 1000) return Math.round(v).toLocaleString("en-US");
  if (v >= 1) return v.toFixed(2).replace(/\.?0+$/, "");
  return v.toPrecision(3).replace(/\.?0+$/, "");
};

const usd = (n) => {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1000000) return "$" + (v / 1000000).toFixed(2) + "M";
  if (v >= 1000) return "$" + (v / 1000).toFixed(1) + "K";
  return "$" + v.toFixed(v < 10 ? 2 : 0);
};

/* The multiple, and only when it is honest.
 *
 * A sale is compared against what this device actually paid for that token:
 * every earlier buy of the same mint, averaged. One missing buy — a position
 * opened in another wallet, or before Xeet — makes the number a lie, so the
 * card simply has no multiple when the history does not cover the whole
 * position. */
function multipleFrom(history, entry) {
  if (!entry || entry.side !== "sell" || !entry.address) return null;
  const earlier = (history || []).filter(
    (h) => h.address === entry.address && h.side === "buy" && h.at < entry.at
      && Number(h.usd) > 0 && Number(h.outAmount) > 0);
  if (!earlier.length) return null;

  const bought = earlier.reduce((n, h) => n + Number(h.outAmount), 0);
  const spent = earlier.reduce((n, h) => n + Number(h.usd), 0);
  const sold = Number(entry.inAmount) || 0;
  if (!bought || !spent || !sold) return null;
  if (sold > bought * 1.02) return null;          // sold more than it saw bought

  const costOfSold = (spent / bought) * sold;
  const got = Number(entry.usd) || 0;
  if (!got || !costOfSold) return null;
  return { x: got / costOfSold, cost: costOfSold, got };
}

/* The mark, from the extension's own icon. Loaded once per card; if it cannot
   be read the card still draws, just without it. */
async function markImage(url) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * Draw the card.
 *
 * @param {object} t   side, symbol, chainName, inAmount, inSymbol, outAmount,
 *                     outSymbol, usd, at, multiple ({x} or null)
 * @param {string} markUrl  chrome.runtime.getURL("icons/icon128.png")
 * @returns {Promise<Blob>} a PNG
 */
async function drawCard(t, markUrl, artUrl) {
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement("canvas"), { width: W, height: H });
  const c = canvas.getContext("2d");
  const sell = t.side === "sell";
  const m = t.multiple && isFinite(t.multiple.x) ? t.multiple : null;
  const pal = !m ? PALETTES.buy : (m.x >= 1 ? PALETTES.win : PALETTES.loss);

  // -- ground ---------------------------------------------------------------
  c.fillStyle = "#07080A";
  c.fillRect(0, 0, W, H);

  /* -- the art, on the right, wearing the colour of the outcome ----------
     Drawn on its own layer first: it has to cover the full height (a letter-
     boxed rectangle shows its edges as a box in the middle of the card) and
     dissolve on its left side (a hard vertical seam reads as a mistake, and
     type over texture reads as worse). Both are impossible to do while
     painting straight onto the card, hence the second canvas. */
  const art = artUrl ? await markImage(artUrl) : null;
  if (art) {
    const layer = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement("canvas"), { width: W, height: H });
    const lc = layer.getContext("2d");

    const scale = Math.max(H / art.height, (W * 0.66) / art.width);
    const aw = art.width * scale, ah = art.height * scale;
    lc.drawImage(art, W - aw, (H - ah) / 2, aw, ah);

    // the colour of the outcome, keeping the shards' own light and shade
    lc.globalCompositeOperation = "color";
    const tint = lc.createLinearGradient(W * 0.4, 0, W, H);
    tint.addColorStop(0, pal.a);
    tint.addColorStop(1, pal.b);
    lc.fillStyle = tint;
    lc.fillRect(0, 0, W, H);

    // and the dissolve, cut into the layer's own alpha
    lc.globalCompositeOperation = "destination-in";
    const mask = lc.createLinearGradient(W * 0.33, 0, W * 0.72, 0);
    mask.addColorStop(0, "rgba(0,0,0,0)");
    mask.addColorStop(1, "rgba(0,0,0,1)");
    lc.fillStyle = mask;
    lc.fillRect(0, 0, W, H);

    c.drawImage(layer, 0, 0);
  }

  // -- the mark, top left; the address, top right ---------------------------
  const mark = await markImage(markUrl);
  if (mark) c.drawImage(mark, 56, 48, 44, 44);
  c.fillStyle = INK;
  c.font = font(DISP, 32, 800);
  c.textBaseline = "alphabetic";
  c.fillText("eet", mark ? 108 : 56, 82);

  /* The address sits over the brightest part of the art, so it gets a plate
     of its own — on a lit shard, grey-on-glow is unreadable. */
  c.font = font(MONO, 17);
  const aw2 = c.measureText("XEET.CLICK").width;
  box(c, W - 56 - aw2 - 30, 50, aw2 + 30, 40, 20);
  c.fillStyle = "rgba(7,8,10,.62)";
  c.fill();
  c.fillStyle = "rgba(255,255,255,.88)";
  c.textAlign = "right";
  c.fillText("XEET.CLICK", W - 71, 77);
  c.textAlign = "left";

  // -- the ticker -----------------------------------------------------------
  const sym = (t.symbol || "").toUpperCase();
  let size = 64;
  c.font = font(DISP, size, 800);
  while (c.measureText(sym).width > W * 0.52 && size > 34) {
    size -= 3;
    c.font = font(DISP, size, 800);
  }
  c.fillStyle = INK;
  c.fillText(sym, 56, 196);

  c.font = font(MONO, 16);
  c.fillStyle = DIM;
  c.fillText((sell ? "SOLD · " : "BOUGHT · ") + (t.chainName || "").toUpperCase(), 56, 228);

  /* -- the number, in a solid block ---------------------------------------
     What goes in it depends on what can be proven. With a cost basis the
     block holds the money made or lost; without one it holds the size of the
     trade, which is a fact either way. A block that always says "+" would be
     a product that only prints wins. */
  const profit = m ? m.got - m.cost : null;
  const big = profit !== null
    ? (profit >= 0 ? "+" : "−") + usd(profit)
    : usd(t.usd || 0);

  c.font = font(DISP, 92, 800);
  const bw = Math.max(c.measureText(big).width + 80, 420);
  box(c, 56, 262, bw, 128, 16);
  const blockFill = c.createLinearGradient(56, 262, 56 + bw, 390);
  blockFill.addColorStop(0, pal.a);
  blockFill.addColorStop(1, pal.b);
  c.fillStyle = blockFill;
  c.fill();
  c.fillStyle = pal.ink;
  c.fillText(big, 96, 356);

  // -- the rows -------------------------------------------------------------
  const rows = profit !== null
    ? [["PNL", (m.x >= 1 ? "+" : "−") + Math.abs((m.x - 1) * 100).toFixed(Math.abs(m.x - 1) < 1 ? 1 : 0) + "%", pal.a],
       ["Invested", usd(m.cost), INK],
       ["Returned", usd(m.got), INK]]
    : [[sell ? "Sold" : "Paid", qty(t.inAmount) + " " + (t.inSymbol || "").toUpperCase(), INK],
       [sell ? "Received" : "Got", qty(t.outAmount) + " " + (t.outSymbol || "").toUpperCase(), INK],
       ["Size", usd(t.usd || 0), pal.a]];

  let y = 452;
  for (const [label, value, colour] of rows) {
    c.font = font(DISP, 30, 600);
    c.fillStyle = DIM;
    c.fillText(label, 60, y);
    c.font = font(DISP, 30, 800);
    c.fillStyle = colour;
    c.textAlign = "right";
    c.fillText(value, 560, y);
    c.textAlign = "left";
    y += 52;
  }

  // -- the footer -----------------------------------------------------------
  c.font = font(MONO, 16);
  c.fillStyle = DIM;
  c.fillText("SWAPPED FROM THE TIMELINE · @XEET_CLICK", 56, H - 44);

  return canvas.convertToBlob
    ? canvas.convertToBlob({ type: "image/png" })
    : new Promise((r) => canvas.toBlob(r, "image/png"));
}

/* Getting the picture out.
 *
 * The clipboard is the good path — one paste and it is in the post — but it
 * needs a permission the page may refuse, so a download is kept behind it.
 * Either way the caller is told which happened, because "copied" on a card
 * that was actually downloaded sends somebody hunting for a paste that never
 * arrives. */
async function deliver(blob, filename) {
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "copied";
    }
  } catch { /* fall through to the download */ }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "xeet-trade.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "saved";
}

  window.XEET_CARD = { drawCard, deliver, multipleFrom };
})();
