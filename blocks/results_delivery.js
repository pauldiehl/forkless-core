/**
 * Results Delivery — Conversational Block (customer-facing)
 *
 * Final block for labs-only journeys. Delivers lab results to the customer
 * when they're available and answers questions about the results.
 *
 * Completion: results_acknowledged === true
 */

module.exports = {
  type: 'conversational',
  name: 'results_delivery',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    delivery_method: { type: 'string' },
    include_reference_ranges: { type: 'boolean' }
  },

  reads: ['lab_processing.*', 'simple_intake.*', 'encounter_notes.*'],
  writes: [
    'results_delivery.results_acknowledged',
    'results_delivery.questions_asked',
    'results_delivery.consult_interest'
  ],

  handles_events: ['conversation', 'api'],

  on_enter: [
    {
      type: 'respond',
      template: 'Great news, {{simple_intake.customerName}}! Your lab results are in. Let me walk you through them.'
    },
    {
      type: 'update_context',
      set: { 'results_delivery.status': 'results_available' }
    }
  ],

  on_api_event: {
    results_ready: {
      before: [],
      transition: null,
      after: [
        {
          type: 'respond',
          template: 'Your lab results are now available, {{simple_intake.customerName}}! Would you like to review them?'
        }
      ]
    }
  },

  on_conversation_event: {
    completion_condition: 'results_acknowledged'
  },

  checkCompletion(blockDef, context) {
    return context.results_delivery?.results_acknowledged === true;
  }
};
