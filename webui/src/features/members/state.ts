import type { Member } from "@/lib/backend";

export type AgentStateLabel = "Running" | "Paused" | "At ceiling" | "Idle";

export function agentStateLabel(
  member: Member,
  tokenLimit: number,
): AgentStateLabel {
  if (member.state === "running") return "Running";
  if (member.state === "paused") return "Paused";
  if (tokenLimit > 0 && (member.tokens ?? 0) >= tokenLimit) return "At ceiling";
  return "Idle";
}
