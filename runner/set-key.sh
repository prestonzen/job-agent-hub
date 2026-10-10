#!/usr/bin/env bash
# Store an API key for a CLI that runs headless on API keys instead of a login (run as root on the runner).
#   jar-set-key mistral    -> ~agent/.vibe/.env     MISTRAL_API_KEY=...   (Mistral Vibe)
#   jar-set-key gemini     -> ~agent/.gemini/.env   GEMINI_API_KEY=...    (Gemini CLI)
# The key is typed with hidden input, never echoed, never put in a command line or shell history.
set -euo pipefail
agent="${1:-}"
case "$agent" in
  mistral) dir=/home/agent/.vibe;   var=MISTRAL_API_KEY ;;
  gemini)  dir=/home/agent/.gemini; var=GEMINI_API_KEY ;;
  *) echo "usage: jar-set-key mistral|gemini" >&2; exit 1 ;;
esac
read -rsp "Paste your $agent API key (hidden): " key; echo
[ -n "$key" ] || { echo "nothing entered" >&2; exit 1; }
install -d -o agent -g agent -m 700 "$dir"
file="$dir/.env"
touch "$file"
grep -v "^$var=" "$file" > "$file.tmp" || true
printf '%s=%s\n' "$var" "$key" >> "$file.tmp"
mv "$file.tmp" "$file"
chown agent:agent "$file"; chmod 600 "$file"
unset key
echo "Saved. The hub shows $agent as ready within about 5 minutes."
