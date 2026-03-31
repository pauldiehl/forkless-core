/**
 * Visit Summary — Conversational Block (customer-facing)
 *
 * Final block in physician-phase journeys. Delivers a patient-friendly
 * summary of the consultation, treatment plan, and next steps.
 *
 * The LLM generates the summary from encounter_notes.internal_note,
 * rx_review.*, and other context. The on_enter template is a fallback.
 *
 * Completion: sent + customer acknowledged
 */

module.exports = {
  type: 'conversational',
  name: 'visit_summary',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    include_rx_details: { type: 'boolean' },
    include_followup_instructions: { type: 'boolean' }
  },

  reads: [
    'simple_intake.*',
    'encounter_notes.*',
    'rx_review.*',
    'rx_order.*',
    'payment.*',
    'rx_payment.*',
    'lab_processing.*',
    'followup.*'
  ],
  writes: [
    'visit_summary.sent',
    'visit_summary.summary_text',
    'visit_summary.acknowledged'
  ],

  handles_events: ['conversation'],

  on_enter: [
    {
      type: 'respond',
      template: 'Here is your visit summary for your consultation, {{simple_intake.customerName}}.'
    },
    {
      type: 'update_context',
      set: { 'visit_summary.sent': true }
    }
  ],

  on_conversation_event: {
    completion_condition: 'summary_acknowledged'
  },

  checkCompletion(blockDef, context) {
    return context.visit_summary?.sent === true
      && context.visit_summary?.acknowledged === true;
  }
};
