#!/usr/bin/env bash
# Packages the extension twice, because the two destinations want opposite
# shapes and getting it wrong fails in a confusing way at each end.
#
#   dist/xeet-extension.zip   the folder INSIDE the zip. Unzipping gives you
#                              an `xeet` directory to point "Load unpacked"
#                              at. A zip of loose files makes people pick the
#                              wrong folder.
#
#   dist/xeet-store.zip       manifest.json at the ROOT of the zip. This is
#                              what the Chrome Web Store requires; upload the
#                              other one and it rejects the package with
#                              "Manifest file is missing or unreadable".
#
# dev/ is in neither: the harness shims `chrome` and has no business shipping.
set -euo pipefail
cd "$(dirname "$0")"

# Only this script's own output is cleared. `rm -rf dist` also took
# dist/store/ with it — the listing artwork lives there and is made by a
# different script, so a build would silently delete the screenshots.
rm -rf .pack
# The worker states its own build as a literal, because an old worker reading
# the new manifest off disk would report the new number and prove nothing. That
# only works while the two agree — and a version bump that forgets the literal
# would make every popup claim the extension needs reloading, forever.
mver=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
bver=$(python3 -c "import re;print(re.search(r'const BUILD = \"([0-9.]+)\"', open('extension/src/background.js').read()).group(1))")
pver=$(python3 -c "import re;print(re.search(r'const BUILD = \"([0-9.]+)\"', open('extension/src/panel.js').read()).group(1))")
if [ "$mver" != "$bver" ] || [ "$mver" != "$pver" ]; then
  echo "version drift: manifest=$mver  background.js=$bver  panel.js=$pver" >&2
  echo "All three must match, or Xeet will report itself stale to its own users." >&2
  exit 1
fi

rm -f dist/xeet-store.zip
mkdir -p .pack dist
rsync -a --exclude 'dev' --exclude '.DS_Store' extension/ .pack/xeet/

# 1. the unpacked-install zip, for the site's download button
# Not in site/ any more: Xeet is in the Chrome Web Store, and a public
# unpacked copy is a copy that never updates. Kept here for local testing.
rm -f dist/xeet-extension.zip site/xeet-extension.zip
( cd .pack && zip -qr ../dist/xeet-extension.zip xeet -x '*.DS_Store' )

# 2. the store package
( cd .pack/xeet && zip -qr ../../dist/xeet-store.zip . -x '*.DS_Store' )

rm -rf .pack

VERSION=$(python3 -c 'import json;print(json.load(open("extension/manifest.json"))["version"])')
printf 'xeet %s\n' "$VERSION"
printf '  dist/xeet-extension.zip  %s  (unpacked, local testing only)\n' "$(du -h dist/xeet-extension.zip | cut -f1)"
printf '  dist/xeet-store.zip      %s  (Chrome Web Store)\n' "$(du -h dist/xeet-store.zip | cut -f1)"

# The store rejects a package whose manifest is not at the root, so check it
# here rather than finding out in the dashboard.
#
# The listing is captured first rather than piped into `grep -q`: -q exits on
# the first match, unzip takes SIGPIPE, and under `set -o pipefail` that turns
# a successful check into a failed one.
LISTING=$(unzip -l dist/xeet-store.zip)
if grep -qE '^ *[0-9]+ +.* manifest\.json$' <<<"$LISTING"; then
  echo '  ✓ manifest.json at the zip root'
else
  echo '  ✗ manifest.json is NOT at the zip root — the store will reject this'
  exit 1
fi
