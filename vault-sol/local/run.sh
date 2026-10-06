#!/usr/bin/env bash
# The whole venue, on this laptop, for nothing.
#
#   ./local/run.sh            start the validator + the price service, set it up
#   ./local/run.sh stop       stop them
#
# The validator loads the program at genesis instead of deploying it, so the
# 4.8 SOL a mainnet deploy would cost is not spent and not needed. Everything
# else is real: same program binary, live prices, signed transactions.
set -euo pipefail
cd "$(dirname "$0")/.."

PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
PROGRAM_ID=EHwwa3q9WQd3s5NzWvUZjk83zuCyApDbXep6DPEjyMzx
LEDGER=local/.ledger
PID_DIR=local/.pids
mkdir -p "$PID_DIR"

stop() {
  for f in "$PID_DIR"/*.pid; do
    [ -e "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  echo "stopped"
}

if [ "${1:-start}" = "stop" ]; then stop; exit 0; fi

stop 2>/dev/null || true

if [ ! -f target/deploy/vault_sol.so ]; then
  echo "building the program…"
  cargo-build-sbf --manifest-path programs/vault-sol/Cargo.toml
fi

# The operator's key: generated once, kept here, never anywhere else. On
# mainnet this one lives on a server and the owner key does not.
if [ ! -f local/.keys.json ]; then
  node -e '
    const c = require("node:crypto"), fs = require("node:fs");
    const seed = () => c.randomBytes(32).toString("hex");
    fs.writeFileSync("local/.keys.json", JSON.stringify(
      { house: seed(), operator: seed(), trader: seed(), mint: seed() }, null, 2),
      { mode: 0o600 });
  '
fi
OPERATOR_SEED=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("local/.keys.json")).operator)')

echo "starting the validator…"
rm -rf "$LEDGER"
solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" target/deploy/vault_sol.so >local/.validator.log 2>&1 &
echo $! > "$PID_DIR/validator.pid"

for i in $(seq 1 60); do
  if curl -s -X POST http://127.0.0.1:8899 -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; then break; fi
  sleep 1
done

echo "starting the price service…"
XEET_OPERATOR_KEY="$OPERATOR_SEED" XEET_PRICE_OVERRIDE=1 node local/price-service.mjs >local/.price.log 2>&1 &
echo $! > "$PID_DIR/price.pid"
sleep 1

node local/setup.mjs

# The extension is wired to the mint and the node, and both survive a restart,
# so this keeps a loaded build pointing at whatever is running now.
if [ -f extension/src/config.js ] || [ -f ../extension/src/config.js ]; then
  ./local/wire-extension.sh >/dev/null && echo "extension re-wired (reload it in chrome://extensions)"
fi
