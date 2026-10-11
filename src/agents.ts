/**
 * Agent identity → color. Colors come from a validated categorical palette (CVD-safe in both
 * themes; see styles.css --agent-*). The order below is the palette's slot order, which is also the
 * stacking order in charts. That order is what keeps adjacent segments distinguishable.
 * Color follows the agent, never its rank.
 */
export const AGENT_ORDER = ["gemini", "claude", "codex", "mistral", "ollama", "human", "kimi", "qwen", "deepseek"] as const;

export const agentKey = (name: string | null | undefined) => (name ?? "unknown").trim().toLowerCase() || "unknown";

export const agentColor = (name: string | null | undefined) => {
  const k = agentKey(name);
  return (AGENT_ORDER as readonly string[]).includes(k) ? `var(--agent-${k})` : "var(--agent-unknown)";
};

export const agentLabel = (name: string | null | undefined) => {
  const k = agentKey(name);
  if (k === "unknown") return "Unknown";
  if (k === "deepseek") return "DeepSeek";
  return k[0].toUpperCase() + k.slice(1);
};

/** Palette slot order first, then anything unexpected alphabetically. */
export function sortAgents(names: string[]): string[] {
  const rank = (n: string) => {
    const i = (AGENT_ORDER as readonly string[]).indexOf(agentKey(n));
    return i === -1 ? 99 : i;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
