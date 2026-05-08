/**
 * Quick Intake — Conversational Block
 *
 * Lightweight intake for free journeys (The Man Plan).
 * Collects name, goal, and optional body stats.
 * No medical history, no state of residence — just the basics.
 */

module.exports = {
  type: 'conversational',
  name: 'quick_intake',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    required_fields: { type: 'array', items: 'string' },
    optional_fields: { type: 'array', items: 'string' },
    questions: { type: 'array', items: 'string' }
  },

  reads: ['presentation.engaged'],
  writes: ['quick_intake.*'],

  handles_events: ['conversation'],

  on_conversation_event: {
    completion_condition: 'required_fields_and_goal'
  },

  /**
   * Check if we have enough info to proceed to assessment.
   * Required: customerName + primaryGoal + (stats OR stats_declined)
   */
  checkCompletion(blockDef, context) {
    const ns = context.quick_intake || {};
    const requiredFields = (blockDef.params?.required_fields || ['customerName']);
    const allRequired = requiredFields.every(field => {
      const val = ns[field];
      return val !== undefined && val !== null && val !== '';
    });
    const hasGoal = ns.primaryGoal && ns.primaryGoal !== '';
    const hasStats = ns.weight_lbs || ns.height_inches || ns.age;
    const statsHandled = hasStats || ns.stats_declined === true;
    return allRequired && hasGoal && statsHandled;
  },

  getMissingFields(blockDef, context) {
    const ns = context.quick_intake || {};
    const requiredFields = (blockDef.params?.required_fields || ['customerName']);
    return requiredFields.filter(field => {
      const val = ns[field];
      return val === undefined || val === null || val === '';
    });
  }
};
