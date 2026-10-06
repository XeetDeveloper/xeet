#!/usr/bin/env bash
# Point the extension at the venue running on this laptop, and rebuild it.
#
# It writes two values into extension/src/config.js — the local node and the
# mint the vault settles in — and nothing else. Run it again with no validator
# (or `./local/wire-extension.sh off`) to put them back.
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../.."

STATE=vault-sol/local/state.json
CFG=extension/src/config.js

if [ "${1:-on}" = "off" ]; then
  node -e '
    const fs = require("fs"), f = "extension/src/config.js";
    const set = (s, tag, v) => s.replace(
      new RegExp(`(\\w+): "[^"]*",(\\s*/\\* ${tag} \\*/)`), `$1: "${v}",$2`);
    let s = fs.readFileSync(f, "utf8");
    s = set(s, "local-rpc", "");
    s = set(s, "local-mint", "");
    s = set(s, "local-price", "https://xeet.click/api/price");
    fs.writeFileSync(f, s);
  '
  echo "extension points at nothing local again"
else
  [ -f "$STATE" ] || { echo "no local venue yet — run ./local/run.sh first"; exit 1; }
  node -e '
    const fs = require("fs");
    const st = JSON.parse(fs.readFileSync("vault-sol/local/state.json", "utf8"));
    const f = "extension/src/config.js";
    const set = (s, tag, v) => {
      const re = new RegExp(`(\\w+): "[^"]*",(\\s*/\\* ${tag} \\*/)`);
      if (!re.test(s)) throw new Error("config.js has no " + tag + " marker any more");
      return s.replace(re, `$1: "${v}",$2`);
    };
    let s = fs.readFileSync(f, "utf8");
    s = set(s, "local-rpc", st.rpc);
    s = set(s, "local-mint", st.mint);
    s = set(s, "local-price", "http://127.0.0.1:8910/price");
    fs.writeFileSync(f, s);
    console.log("extension wired to", st.rpc, "mint", st.mint);
  '
fi

./build.sh >/dev/null

# The wired build goes to the desktop and the repo copy is put back at once:
# a config with 127.0.0.1 in it is one careless commit away from shipping.
if [ "${1:-on}" != "off" ]; then
  OUT="$HOME/Desktop/Xeet-$(node -p 'require("./extension/manifest.json").version')-preview"
  rm -rf /tmp/xeet-preview && mkdir -p /tmp/xeet-preview
  unzip -q -o dist/xeet-extension.zip -d /tmp/xeet-preview
  rm -rf "$OUT" && mkdir -p "$OUT" && cp -R /tmp/xeet-preview/xeet/. "$OUT/"
  "$SELF" off >/dev/null
  echo "preview build: $OUT"
  echo "In chrome://extensions press reload on it, then hover a \$XEET post."
else
  echo "built."
fi
