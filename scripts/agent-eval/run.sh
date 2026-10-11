#!/usr/bin/env bash
# Run one (harness, model) trial against the fake application site and print a one-line JSON result.
#   run.sh claude gemma4:26b            Claude Code harness on Ollama's Anthropic-compatible endpoint
#   run.sh hermes gemma4:26b            Hermes Agent harness on Ollama
#   run.sh bare gemma4:26b              bare-agent.mjs: model + MCP tools + a loop, nothing else (needs ~/bare with the MCP SDK)
# Env: HARD=medium (cookie wall, masked inputs, gated submit, work history) or HARD=hard (adds type-ahead comboboxes), OLLAMA_URL (default http://127.0.0.1:11434), EVAL_DIR (default ~/agent-eval), TIMEOUT_MIN (default 25)
set -uo pipefail
HARNESS="${1:?harness: claude|hermes}"; MODEL="${2:?model}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EVAL_DIR="${EVAL_DIR:-$HOME/agent-eval}"
TIMEOUT_MIN="${TIMEOUT_MIN:-25}"
PORT=8099
export DISPLAY="${DISPLAY:-:99}" PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"

mkdir -p "$EVAL_DIR/work" && cd "$EVAL_DIR/work" && rm -rf ./* ./.playwright 2>/dev/null
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > resume.pdf

pkill -f "server.py $PORT" 2>/dev/null; sleep 0.5
case "${HARD:-}" in 1|hard) DIFF=hard ;; medium) DIFF=medium ;; *) DIFF= ;; esac
python3 "$HERE/server.py" $PORT $DIFF >/dev/null 2>&1 &
SRV=$!
sleep 1
curl -s -X POST localhost:$PORT/reset >/dev/null

PROMPT="$(cat "$HERE/prompt.txt")"
START=$(date +%s)
case "$HARNESS" in
  claude)
    export CLAUDE_CONFIG_DIR="$HOME/.claude-ollama"
    export ANTHROPIC_BASE_URL="$OLLAMA_URL" ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY=
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL" ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL" ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL" ANTHROPIC_SMALL_FAST_MODEL="$MODEL"
    export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
    timeout ${TIMEOUT_MIN}m claude -p "$PROMPT" --model "$MODEL" --max-turns 80 --dangerously-skip-permissions > out.txt 2> err.txt
    ;;
  bare)
    # Run from the work dir (the resume lives there and Playwright MCP only uploads files under the cwd); the script's own node_modules are found next to it.
    timeout ${TIMEOUT_MIN}m node "$HOME/bare/bare-agent.mjs" --model "$MODEL" --ollama "$OLLAMA_URL" --prompt-file "$HERE/prompt.txt" --max-turns 80 > "$EVAL_DIR/work/out.txt" 2> "$EVAL_DIR/work/err.txt"
    ;;
  hermes)
    export PATH="$HOME/.local/bin:$PATH"
    timeout ${TIMEOUT_MIN}m hermes chat -Q --yolo --max-turns 80 --provider local-ollama -m "$MODEL" -q "$PROMPT" > out.txt 2> err.txt
    ;;
  *) echo "unknown harness $HARNESS"; kill $SRV; exit 2 ;;
esac
RC=$?
END=$(date +%s)
# Keep every run's output for later reading (the work dir is wiped at the start of the next run).
mkdir -p "$EVAL_DIR/logs" && for f in out err; do cp "$EVAL_DIR/work/$f.txt" "$EVAL_DIR/logs/$HARNESS-${MODEL//[:\/]/_}-$(date +%H%M%S).$f" 2>/dev/null; done
RESULT="$(curl -s localhost:$PORT/result)"
kill $SRV 2>/dev/null
python3 - "$HARNESS" "$MODEL" "$RC" "$((END-START))" "$RESULT" "$EVAL_DIR/work/out.txt" <<'PY'
import json, sys
h, m, rc, secs, res, out = sys.argv[1:7]
r = json.loads(res)
failed = [k for k, v in r["checks"].items() if not v]
tail = open(out, errors="replace").read()[-200:].replace("\n", " ")
print(json.dumps({"harness": h, "model": m, "exit": int(rc), "seconds": int(secs), "submissions": r["submissions"], "passed": r["passed"], "total": r["total"], "success": r["success"], "failed_checks": failed, "essay": r["essay"][:300], "tail": tail}))
PY
