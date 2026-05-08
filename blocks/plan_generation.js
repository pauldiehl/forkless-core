/**
 * Plan Generation — Capability Block
 *
 * Generates the nutrition/fitness plan artifact based on assessed
 * parameters. The artifact is a versioned markdown document.
 * Transitions immediately once the artifact is generated.
 */

module.exports = {
  type: 'conversational',  // Conversational so the LLM can present the plan
  name: 'plan_generation',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    artifact_type: { type: 'string' },
    format: { type: 'string' },
    include_version_history: { type: 'boolean' }
  },

  reads: ['quick_intake.*', 'plan_assessment.*'],
  writes: ['plan_generation.*', 'artifacts.*'],

  handles_events: ['conversation', 'system'],

  on_conversation_event: {
    completion_condition: 'artifact_generated_and_presented'
  },

  /**
   * Check if the plan artifact has been generated AND presented to the customer.
   * The _plan_presented flag prevents auto-completion before the LLM actually
   * shows the plan link — mirrors the _assessment_presented pattern.
   */
  checkCompletion(blockDef, context) {
    const hasArtifact = !!context.artifacts?.['nutrition-plan'] || !!context.artifacts?.['fitness-plan'];
    const hasVersion = !!context.plan_generation?.current_version;
    const wasPresented = !!context.plan_generation?._plan_presented;
    return hasArtifact && hasVersion && wasPresented;
  }
};
