#!/usr/bin/env bash
#
# Build, package, and install this extension into the locally installed editors.
#
#   ./scripts/dev-install.sh                  # install into every editor found
#   ./scripts/dev-install.sh --target cursor  # cursor | code | all
#   ./scripts/dev-install.sh --bump           # bump the patch version first
#   ./scripts/dev-install.sh --dry-run        # print the plan, change nothing
#   ./scripts/dev-install.sh --skip-typecheck # skip tsc (build only)
#
# Resolves the `code` / `cursor` CLI from the macOS app bundle when it is not on
# PATH, which is the usual case inside an agent sandbox.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET=all
DRY_RUN=0
BUMP=0
TYPECHECK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target needs a value: code|cursor|all}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --dry-run|-n) DRY_RUN=1; shift ;;
    --bump) BUMP=1; shift ;;
    --skip-typecheck) TYPECHECK=0; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

case "$TARGET" in
  code|cursor|all) ;;
  *) echo "--target must be one of: code, cursor, all" >&2; exit 2 ;;
esac

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would run:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# --- resolve editor CLIs -----------------------------------------------------
# $1 is the command name; the rest are fallback absolute paths.
find_cli() {
  local cmd="$1"; shift
  if command -v "$cmd" >/dev/null 2>&1; then command -v "$cmd"; return 0; fi
  local candidate
  for candidate in "$@"; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

CODE_CLI="$(find_cli code \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "/usr/share/code/bin/code" \
  "/snap/bin/code")" || CODE_CLI=""

CURSOR_CLI="$(find_cli cursor \
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  "/usr/share/cursor/bin/cursor")" || CURSOR_CLI=""

CLIS=()
CLI_NAMES=()
if [ "$TARGET" = all ] || [ "$TARGET" = code ]; then
  [ -n "$CODE_CLI" ] && { CLIS+=("$CODE_CLI"); CLI_NAMES+=("VS Code"); }
fi
if [ "$TARGET" = all ] || [ "$TARGET" = cursor ]; then
  [ -n "$CURSOR_CLI" ] && { CLIS+=("$CURSOR_CLI"); CLI_NAMES+=("Cursor"); }
fi

# --- version -----------------------------------------------------------------
if [ "$BUMP" = 1 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "  would bump the patch version in package.json"
  else
    node -e '
      const fs = require("fs");
      const p = "package.json";
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const s = j.version.split(".");
      s[2] = String(Number(s[2]) + 1);
      j.version = s.join(".");
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
      console.log("version -> " + j.version);
    '
  fi
fi

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
PUBLISHER="$(node -p "require('./package.json').publisher")"
VSIX="$NAME-$VERSION.vsix"
EXT_ID="$PUBLISHER.$NAME"

echo "==> $EXT_ID $VERSION"

# --- build -------------------------------------------------------------------
[ "$TYPECHECK" = 1 ] && { echo "==> typecheck"; run npm run typecheck; }
echo "==> build"
run npm run build
echo "==> package"
run npm run package

# --- install -----------------------------------------------------------------
if [ "${#CLIS[@]}" -eq 0 ]; then
  cat >&2 <<EOF

==> No editor CLI found for --target=$TARGET.

Built: $ROOT/$VSIX

Install it by hand: Extensions view -> "..." menu -> "Install from VSIX...".
To get the CLI on PATH: Command Palette -> "Shell Command: Install 'code' command in PATH"
(or the Cursor equivalent).
EOF
  exit 1
fi

for i in "${!CLIS[@]}"; do
  echo "==> install into ${CLI_NAMES[$i]} (${CLIS[$i]})"
  run "${CLIS[$i]}" --install-extension "$VSIX" --force
done

if [ "$DRY_RUN" = 1 ]; then
  echo "==> dry run, nothing changed"
  exit 0
fi

cat <<EOF

==> Installed $VSIX into: ${CLI_NAMES[*]}

Next, in that editor:
  1. Cmd/Ctrl+Shift+P -> "Developer: Reload Window"
  2. Open a file from test_data/ to check the change
  3. Cmd/Ctrl+Shift+P -> "Developer: Open Webview Developer Tools" for console output

Uninstall with: <editor> --uninstall-extension $EXT_ID
EOF
