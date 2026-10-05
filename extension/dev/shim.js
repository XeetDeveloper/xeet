/* A `chrome` just real enough to run the extension's own data layer in a tab.
 *
 * The point is that nothing is reimplemented: background.js is loaded straight
 * after this file, registers its real handlers, and answers real questions
 * against the real APIs. The shim only supplies the four pieces of extension
 * plumbing a page does not have — importScripts, message passing, storage, and
 * tabs — so what the harness renders is the shipped code path, not a mock of
 * it. Development only; never packaged. */

(() => {
  "use strict";
  if (window.chrome && chrome.runtime && chrome.runtime.id) return; // real extension

  // background.js opens with importScripts("config.js"); the page already has it.
  window.importScripts = () => {};

  const mem = { sync: {}, local: {} };
  try {
    Object.assign(mem.sync, JSON.parse(localStorage.getItem("xeet.sync") || "{}"));
    Object.assign(mem.local, JSON.parse(localStorage.getItem("xeet.local") || "{}"));
  } catch { /* first run */ }
  const persist = (area) => {
    try { localStorage.setItem("xeet." + area, JSON.stringify(mem[area])); } catch { /* full */ }
  };

  function area(name) {
    return {
      get(keys) {
        const out = {};
        if (typeof keys === "string") out[keys] = mem[name][keys];
        else if (Array.isArray(keys)) keys.forEach((k) => { out[k] = mem[name][k]; });
        else for (const k in keys) out[k] = k in mem[name] ? mem[name][k] : keys[k];
        return Promise.resolve(out);
      },
      set(obj) {
        // Real chrome.storage tells everyone what changed, and the popup leans
        // on that to notice a wallet connecting or going away. A stub that
        // never fires makes that path untestable here, which is how it went
        // unexamined in the first place.
        const changes = {};
        for (const k in obj) changes[k] = { oldValue: mem[name][k], newValue: obj[k] };
        Object.assign(mem[name], obj);
        persist(name);
        setTimeout(() => { for (const fn of changeListeners) fn(changes, name); }, 0);
        return Promise.resolve();
      },
      remove(k) {
        const changes = { [k]: { oldValue: mem[name][k], newValue: undefined } };
        delete mem[name][k];
        persist(name);
        setTimeout(() => { for (const fn of changeListeners) fn(changes, name); }, 0);
        return Promise.resolve();
      },
    };
  }

  const changeListeners = [];

  const msgListeners = [];
  // background.js is an ES module now, so it is deferred and registers its
  // handler after the classic page scripts have already started asking. Hold
  // the questions until there is something to answer them.
  const pending = [];
  function flush() {
    while (pending.length && msgListeners.length) {
      const { msg, cb } = pending.shift();
      deliver(msg, cb);
    }
  }
  function deliver(msg, cb) {
    let answered = false;
    const reply = (res) => { if (!answered) { answered = true; cb && cb(res); } };
    for (const fn of msgListeners) if (fn(msg, { id: "harness" }, reply)) return;
    reply({ ok: false, error: "no handler" });
  }

  window.chrome = {
    runtime: {
      // Chrome exposes this in a content script and clears it when the context
      // is invalidated. The harness needs it or code that reads it behaves
      // differently here than in the extension.
      id: "xeet-harness",
      lastError: null,
      sendMessage(msg, cb) {
        if (!msgListeners.length) return void pending.push({ msg, cb });
        deliver(msg, cb);
      },
      onMessage: { addListener: (fn) => { msgListeners.push(fn); flush(); } },
      // Firing this is how the upgrade path gets tested at all — the worker
      // does its one-time migrations here.
      onInstalled: { addListener: (fn) => { (window.__XEET_ONINSTALLED ||= []).push(fn); } },
      // The harness needs these to exercise the build-mismatch check: without
      // getManifest the popup cannot know what it expects, and without reload
      // the fix button cannot be tested at all.
      getManifest: () => ({ version: window.__XEET_MANIFEST_VERSION || "0.0.0" }),
      reload: () => { window.__XEET_RELOADED = (window.__XEET_RELOADED || 0) + 1; },
      getURL: (p) => new URL("../" + p, location.href).href,
    },
    storage: {
      sync: area("sync"),
      local: area("local"),
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
    tabs: {
      query: (q) => { window.__XEET_TABQUERY = q; return Promise.resolve([{ id: 1 }, { id: 2 }]); },
      reload: (id) => { (window.__XEET_RELOADED_TABS ||= []).push(id); return Promise.resolve(); },
      create: ({ url }) => { window.open(url, "_blank", "noopener"); return Promise.resolve({}); },
      sendMessage: () => Promise.reject(new Error("no tab")),
    },
  };
})();
