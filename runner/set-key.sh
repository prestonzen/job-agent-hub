#!/usr/bin/env bash
# Store an API key for a CLI that runs headless on API keys instead of a login (run as root on the runner).
#   jar-set-key mistral          -> ~agent/.vibe/.env       MISTRAL_API_KEY=...   (Mistral Vibe)
#   jar-set-key gemini           -> ~agent/.gemini/.env     GEMINI_API_KEY=...    (Gemini CLI, the first key)
#   jar-set-key gemini --add     -> ~agent/.gemini/keys     one more key, load-balanced with the others (with-key.mjs)
#   jar-set-key deepseek         -> ~agent/.deepseek/.env   DEEPSEEK_API_KEY=...  (DeepSeek, run through Claude Code)
#   jar-set-key qwen             -> ~agent/.qwen/.env       BAILIAN_CODING_PLAN_API_KEY=... + the Coding Plan base URL
# The key is typed with hidden input (or piped on stdin), never echoed, never put in a command line or shell history.
set -euo pipefail
agent="${1:-}"
mode="${2:-}"
extra=""
case "$agent" in
  mistral)  dir=/home/agent/.vibe;     var=MISTRAL_API_KEY ;;
  gemini)   dir=/home/agent/.gemini;   var=GEMINI_API_KEY ;;
  deepseek) dir=/home/agent/.deepseek; var=DEEPSEEK_API_KEY ;;
  qwen)     dir=/home/agent/.qwen;     var=BAILIAN_CODING_PLAN_API_KEY; extra="OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1" ;;
  *) echo "usage: jar-set-key mistral|gemini [--add]|deepseek|qwen" >&2; exit 1 ;;
esac
read -rsp "Paste your $agent API key (hidden): " key || true; echo
key="$(printf '%s' "$key" | tr -d '\r\n ')"
[ -n "$key" ] || { echo "nothing entered" >&2; exit 1; }
install -d -o agent -g agent -m 700 "$dir"
if [ "$agent" = gemini ] && [ "$mode" = "--add" ]; then
  file="$dir/keys"
  touch "$file"
  grep -qxF "$key" "$file" || printf '%s\n' "$key" >> "$file"
  chown agent:agent "$file"; chmod 600 "$file"
  unset key
  echo "Added. $(grep -c . "$file") extra key(s) in $file; runs rotate across all keys and rest any that hit their quota."
  exit 0
fi
file="$dir/.env"
touch "$file"
grep -v "^$var=" "$file" > "$file.tmp" || true
printf '%s=%s\n' "$var" "$key" >> "$file.tmp"
if [ -n "$extra" ]; then
  grep -v "^${extra%%=*}=" "$file.tmp" > "$file.tmp2" || true
  printf '%s\n' "$extra" >> "$file.tmp2"
  mv "$file.tmp2" "$file.tmp"
fi
mv "$file.tmp" "$file"
chown agent:agent "$file"; chmod 600 "$file"
unset key
echo "Saved. The hub shows $agent as ready within about 5 minutes."
