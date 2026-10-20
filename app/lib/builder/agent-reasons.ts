/**
 * Why an agent paragraph is not in a report, in the words the builder's Try it and the
 * report's page both use. Keyed by the runtime's reasons (`AgentOutcome.reason`); an
 * unknown reason reads as "Not written." where it is shown.
 */
export const AGENT_REASONS: Readonly<Record<string, string>> = {
  written: "Written.",
  unprovable_figures: "The agent wrote a number it was not shown, so its words were refused.",
  unfinished: "The agent ran out of room before it finished.",
  model_failed: "The model could not be reached, or did not answer in time.",
  empty: "The agent answered with nothing.",
  no_model: "No model is configured for this runtime.",
  over_budget: "The report's time for writing ran out before this paragraph.",
  provider_failed: "The model call failed.",
  nothing_to_read: "The blocks it reads had no figures in this report.",
}
