/**
 * Plan Assessment — Conversational Block
 *
 * Presents a recommended plan type based on the customer's profile,
 * collects food preferences (green/red/yellow), and confirms the plan
 * configuration before generation.
 */

module.exports = {
  type: 'conversational',
  name: 'plan_assessment',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    auto_select_plan: { type: 'boolean' },
    default_plan_type: { type: 'string' },
    default_fueling_count: { type: 'number' },
    collect_preferences: { type: 'boolean' }
  },

  reads: ['quick_intake.*'],
  writes: ['plan_assessment.*'],

  handles_events: ['conversation'],

  on_conversation_event: {
    completion_condition: 'plan_type_confirmed'
  },

  /**
   * Check if the plan type has been confirmed and we're ready to generate.
   */
  checkCompletion(blockDef, context) {
    const ns = context.plan_assessment || {};
    return ns.plan_type_confirmed === true && !!ns.plan_type;
  }
};
