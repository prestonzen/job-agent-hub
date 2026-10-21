/**
 * Human-readable names for the agent instances (Preston, 2026-10-22: "name each LLM instance so I can
 * recognize them"). The short key stays the identity everywhere (tokens, settings, D1); this is only what
 * people see in Telegram and the admin UI. Keep src/agents.ts AGENT_NAMES in step.
 */
export const AGENT_NAMES: Record<string, string> = {
  claude: "Claude 1 · Main (Preston)",
  claude2: "Claude 2 · Galaxy Contact",
  claude3: "Claude 3 · Roman",
  kimi: "Kimi 1 · Preston",
  kimi2: "Kimi 2 · Roman",
  codex: "Codex · Preston",
  gemini: "Gemini · free keys (email lane)",
  mistral: "Mistral · Vibe",
  deepseek: "DeepSeek · via Claude Code",
  qwen: "Qwen Code",
  ollama: "Ollama · sparky (local)",
  feeds: "Feeds (no LLM)",
  hub: "Hub",
  human: "Human",
  roman: "Roman",
};
export const agentName = (a: string | null | undefined): string => (a ? AGENT_NAMES[a.toLowerCase()] ?? a[0].toUpperCase() + a.slice(1) : "Unknown");
