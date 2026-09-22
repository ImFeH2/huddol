import type { Member } from "@/lib/backend";

export type AgentStateLabel =
  | "Running"
  | "Paused"
  | "Blocked"
  | "Error"
  | "Idle";

const labels: Record<Member["state"], AgentStateLabel> = {
  running: "Running",
  paused: "Paused",
  blocked: "Blocked",
  error: "Error",
  idle: "Idle",
};

export function agentStateLabel(member: Member): AgentStateLabel {
  return labels[member.state];
}

export function canResume(member: Member): boolean {
  return (
    Boolean(member.pause_requested) ||
    member.state === "paused" ||
    member.state === "blocked"
  );
}
