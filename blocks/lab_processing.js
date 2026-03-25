/**
 * Lab Processing — Capability Block (multi-state)
 *
 * Example of a capability block with internal sub-states.
 * Demonstrates: derived transitions, exit states, scheduled events,
 * api webhooks, and conversation handling within a capability block.
 *
 * Internal states:
 *   lab_order_pending → awaiting_lab_visit → lab_results_pending → lab_results_ready (exit)
 *
 * This block ships with core as a reference implementation.
 * Consumers can use it directly or build their own capability blocks.
 */

module.exports = {
  type: 'capability',
  name: 'lab_processing',

  params_schema: {
    lab_provider: { type: 'string', required: true },
    auto_create_order: { type: 'boolean', default: true },
    reminders: { type: 'array', items: { delay: 'string', type: 'string' } }
  },

  reads: [
    'simple_intake.customerName',
    'simple_intake.customerDob',
    'simple_intake.customerGender',
    'recommendation.panels',
    'payment.status'
  ],
  writes: [
    'lab_processing.lab_order_id',
    'lab_processing.labcorp_status',
    'lab_processing.results_url',
    'lab_processing.summary',
    'lab_processing.visit_confirmed'
  ],

  handles_events: ['conversation', 'api', 'scheduled'],

  internal_states: {
    lab_order_pending: {
      on_enter: [
        { type: 'execute_capability', capability: 'lab_create_order' },
        { type: 'schedule', payload: { job_type: 'lab_visit_reminder', delay: '48h' } }
      ]
    },
    awaiting_lab_visit: {},
    lab_results_pending: {},
    lab_results_ready: {
      is_exit: true
    }
  },

  on_api_event: {
    lab_status_update: {
      before: [
        {
          type: 'validate',
          rules: [{ field: 'lab_processing.lab_order_id', required: true }]
        }
      ],
      transition: 'derived_from_payload.labcorp_status',
      after: [
        {
          type: 'transaction_note',
          template: 'Lab status updated: {{lab_processing.labcorp_status}}'
        },
        {
          type: 'update_context',
          set: {}  // dynamic — set by block executor from event payload
        }
      ]
    },
    lab_results_ready: {
      before: [
        {
          type: 'validate',
          rules: [{ field: 'lab_processing.lab_order_id', required: true }]
        }
      ],
      transition: 'lab_results_ready',
      after: [
        {
          type: 'transaction_note',
          template: 'Lab results are ready!'
        },
        {
          type: 'update_context',
          set: { 'lab_processing.labcorp_status': 'results_ready' }
        }
      ]
    }
  },

  on_scheduled_event: {
    lab_visit_reminder: {
      before: [],
      transition: null,
      after: [
        {
          type: 'respond',
          template: 'Hi {{simple_intake.customerName}}! Have you had a chance to visit the lab for your blood draw? Remember, you can walk into any location with your photo ID.'
        }
      ]
    },
    lab_results_check: {
      before: [],
      transition: null,
      after: [
        {
          type: 'execute_capability',
          capability: 'lab_check_status'
        }
      ]
    }
  },

  on_conversation_event: {
    allowed_intents: ['check_lab_status', 'lab_prep_question', 'confirm_lab_visit', 'general_question']
  },

  /**
   * Determine which api event handler to use based on the event payload.
   */
  getApiHandler(event) {
    const status = event.payload?.labcorp_status;
    if (status === 'results_ready') return 'lab_results_ready';
    if (status) return 'lab_status_update';
    return null;
  }
};
