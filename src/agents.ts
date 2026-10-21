/**
 * Agent identity → color. Colors come from a validated categorical palette (CVD-safe in both
 * themes; see styles.css --agent-*). The order below is the palette's slot order, which is also the
 * stacking order in charts. That order is what keeps adjacent segments distinguishable.
 * Color follows the agent, never its rank.
 */
export const AGENT_ORDER = ["gemini", "claude", "codex", "mistral", "ollama", "human", "kimi", "qwen", "deepseek"] as const;

/** People, not agents: they share the "human" color and stay off the agent constellation. */
export const HUMANS = ["human", "roman"];

export const agentKey = (name: string | null | undefined) => (name ?? "unknown").trim().toLowerCase() || "unknown";

export const agentColor = (name: string | null | undefined) => {
  const k = HUMANS.includes(agentKey(name)) ? "human" : agentKey(name);
  return (AGENT_ORDER as readonly string[]).includes(k) ? `var(--agent-${k})` : "var(--agent-unknown)";
};

/** Display names for the instances (keep worker/src/names.ts in step). */
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
};
export const agentLabel = (name: string | null | undefined) => {
  const k = agentKey(name);
  if (k === "unknown") return "Unknown";
  return AGENT_NAMES[k] ?? k[0].toUpperCase() + k.slice(1);
};

/** Palette slot order first, then anything unexpected alphabetically. */
export function sortAgents(names: string[]): string[] {
  const rank = (n: string) => {
    const i = (AGENT_ORDER as readonly string[]).indexOf(agentKey(n));
    return i === -1 ? 99 : i;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** "Roman · Claude · Hermes" (approach dropped when it is "default"). */
export function identityLabel(id: string): string {
  const [user, model, approach] = (id || "").split("/");
  const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  return approach && approach !== "default" ? `${cap(user)} · ${cap(model)} · ${cap(approach)}` : `${cap(user)} · ${cap(model)}`;
}
