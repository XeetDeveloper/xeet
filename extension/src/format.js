/* Xeet — number and time formatting.
 *
 * Every figure in the panel is a fixed width in a tabular face, so a price
 * ticking from $0.0031 to $0.0034 does not shove the change beside it. The
 * rules here are the panel's, not a locale's: money is short-scaled, a price
 * under a cent gets subscript zeros rather than eight decimals, and anything
 * unknown renders as an em dash instead of NaN. */

(function (g) {
  "use strict";

  const SUB = "₀₁₂₃₄₅₆₇₈₉";
  const DASH = "—";

  function num(v) {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : null;
  }

  /* $283M / $1.58B / $12.4K — three significant figures, never more. */
  function usdShort(v) {
    const n = num(v);
    if (n === null) return DASH;
    const a = Math.abs(n);
    const s = n < 0 ? "-" : "";
    if (a >= 1e12) return `${s}$${trim(a / 1e12)}T`;
    if (a >= 1e9) return `${s}$${trim(a / 1e9)}B`;
    if (a >= 1e6) return `${s}$${trim(a / 1e6)}M`;
    if (a >= 1e3) return `${s}$${trim(a / 1e3)}K`;
    return `${s}$${a < 1 ? a.toFixed(2) : trim(a)}`;
  }

  function trim(x) {
    if (x >= 100) return String(Math.round(x));
    if (x >= 10) return x.toFixed(1).replace(/\.0$/, "");
    return x.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
  }

  /* 214K holders, 1.2M txns — same scale, no currency. */
  function countShort(v) {
    const n = num(v);
    if (n === null) return DASH;
    const a = Math.abs(n);
    if (a >= 1e9) return `${trim(a / 1e9)}B`;
    if (a >= 1e6) return `${trim(a / 1e6)}M`;
    if (a >= 1e3) return `${trim(a / 1e3)}K`;
    return String(Math.round(a));
  }

  /* A PRICE, not a number. Above a cent it is a normal decimal; below, the
     leading zeros collapse to a subscript count — $0.0₅3184 — because eleven
     characters of zero is the panel's whole width spent saying "small". */
  function price(v) {
    const n = num(v);
    if (n === null) return DASH;
    if (n === 0) return "$0";
    const a = Math.abs(n);
    if (a >= 1000) return "$" + a.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (a >= 1) return "$" + a.toFixed(a >= 100 ? 2 : 4).replace(/0+$/, "").replace(/\.$/, "");
    if (a >= 0.001) return "$" + a.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    const e = Math.floor(Math.log10(a));
    const zeros = -e - 1;
    const digits = Math.round(a * Math.pow(10, e < 0 ? -e + 3 : 0))
      .toString().replace(/0+$/, "").slice(0, 4) || "0";
    return "$0." + subDigits(zeros) + digits;
  }

  function subDigits(n) {
    if (n < 4) return "0".repeat(n);
    return String(n).split("").map((d) => SUB[+d]).join("");
  }

  /* +38.2% / -6.4% — always signed, one decimal, never "+0.0%" for nothing. */
  function pct(v, digits) {
    const n = num(v);
    if (n === null) return DASH;
    const d = digits === undefined ? (Math.abs(n) >= 100 ? 0 : 1) : digits;
    // A move too small to print is not a direction. "-0.0%" claims a fall the
    // figure beside it cannot show, which reads as a rendering fault.
    const shown = Number(n.toFixed(d));
    if (shown === 0) return (0).toFixed(d) + "%";
    return (shown > 0 ? "+" : "") + shown.toFixed(d) + "%";
  }

  /* Token quantity beside its symbol: enough figures to be checkable, never
     so many that the tile wraps. */
  function qty(v) {
    const n = num(v);
    if (n === null) return DASH;
    const a = Math.abs(n);
    if (a >= 1e9) return trim(a / 1e9) + "B";
    if (a >= 1e6) return trim(a / 1e6) + "M";
    if (a >= 1000) return Math.round(a).toLocaleString("en-US");
    if (a >= 1) return a.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
    if (a >= 0.001) return a.toFixed(4);
    return a.toPrecision(3);
  }

  /* 11m, 6h, 3d, 14mo — the age of a pair, in one or two characters. */
  function age(ms) {
    const n = num(ms);
    if (n === null) return "";
    const s = Math.max(0, (Date.now() - n) / 1000);
    if (s < 90) return Math.round(s) + "s";
    const m = s / 60;
    if (m < 90) return Math.round(m) + "m";
    const h = m / 60;
    if (h < 36) return Math.round(h) + "h";
    const d = h / 24;
    if (d < 60) return Math.round(d) + "d";
    const mo = d / 30.44;
    if (mo < 24) return Math.round(mo) + "mo";
    return Math.round(mo / 12) + "y";
  }

  /* 4Ba7…Gpump — an address you can eyeball against a wallet screen. */
  function shortAddr(a, head, tail) {
    if (!a) return "";
    const h = head || 5, t = tail || 5;
    return a.length <= h + t + 1 ? a : a.slice(0, h) + "…" + a.slice(-t);
  }

  g.XEET_FMT = { usdShort, countShort, price, pct, qty, age, shortAddr, num, DASH };
})(typeof self !== "undefined" ? self : window);
