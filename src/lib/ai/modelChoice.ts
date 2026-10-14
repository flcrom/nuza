import type { AgentConfig } from "./protocol";

/**
 * The model chosen for each vault, for one agent.
 *
 * A model id means nothing to a different agent - `sonnet` is not a Codex
 * model - so the choices are kept together with the agent they were made
 * for, and are forgotten the moment that agent changes.
 */
export interface ModelChoices {
  agent: string | null;
  byVault: Record<string, string>;
}

export const NO_MODEL_CHOICES: ModelChoices = { agent: null, byVault: {} };

/** Which agent a choice belongs to: its kind, or a custom agent's command. */
export function agentKey(config: AgentConfig | null): string | null {
  if (!config) return null;
  return config.kind === "custom" ? `custom:${config.command.trim()}` : config.kind;
}

/** The model chosen for `vault`, if one was chosen for this agent. */
export function modelFor(
  choices: ModelChoices,
  agent: AgentConfig | null,
  vault: string | null
): string | null {
  const key = agentKey(agent);
  if (!key || choices.agent !== key) return null;
  return choices.byVault[vault ?? ""] ?? null;
}

/** `choices`, with `model` chosen for `vault` - and every other choice dropped if the agent changed. */
export function chooseModel(
  choices: ModelChoices,
  agent: AgentConfig | null,
  vault: string | null,
  model: string | null
): ModelChoices {
  const key = agentKey(agent);
  const byVault = choices.agent === key ? { ...choices.byVault } : {};
  if (model) byVault[vault ?? ""] = model;
  else delete byVault[vault ?? ""];
  return { agent: key, byVault };
}
