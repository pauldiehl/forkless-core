/**
 * Plan Refinement — Conversational Block (Open-Ended)
 *
 * Allows the customer to iteratively refine their plan through conversation:
 * food swaps, fueling count changes, plan type switches, stat updates,
 * version rollback, etc.
 *
 * This block has NO completion gate — it stays open indefinitely.
 * The customer can come back and refine anytime.
 */

module.exports = {
  type: 'conversational',
  name: 'plan_refinement',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    max_versions: { type: 'number' },
    allow_food_preferences: { type: 'boolean' },
    allow_fueling_change: { type: 'boolean' },
    allow_plan_type_switch: { type: 'boolean' },
    upsell_pho: { type: 'boolean' },
    upsell_medical: { type: 'boolean' }
  },

  reads: ['quick_intake.*', 'plan_assessment.*', 'plan_generation.*', 'artifacts.*'],
  writes: ['plan_refinement.*', 'plan_assessment.*', 'plan_generation.*', 'artifacts.*'],

  handles_events: ['conversation'],

  on_conversation_event: {
    completion_condition: 'never'  // Open-ended — no auto-completion
  },

  /**
   * This block never auto-completes. The customer stays here indefinitely.
   * The journey effectively "lives" in this block.
   */
  checkCompletion(/* blockDef, context */) {
    return false;
  }
};
