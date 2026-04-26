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

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

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
    'lab_processing.labcorp_status'
    // results_url, summary, panels are written conditionally when results arrive (via webhook handler)
    // visit_confirmed removed — not tracked in current flow
  ],

  handles_events: ['conversation', 'api', 'scheduled'],

  on_enter: [
    {
      type: 'capability',
      capability: 'lab_create_order',
      params_from_context: {
        patient_name: 'simple_intake.customerName',
        patient_dob: 'simple_intake.customerDob',
        patient_gender: 'simple_intake.customerGender',
        patient_email: 'simple_intake.customerEmail',
        panels: 'recommendation.panels'
      }
    },
    {
      type: 'respond',
      template: 'Your lab order has been created! Here\'s what to do next:\n\n1. Visit any LabCorp location with your photo ID. Find the nearest one at https://www.labcorp.com/labs-and-appointments\n2. Some locations accept walk-ins; others require an appointment — check before you go\n3. Results typically take 3-5 business days\n\nYour order ID: {{lab_processing.lab_order_id}}\n\nFasting may be required for accurate hormone panel results — avoid eating 8-12 hours before your visit if possible.'
    },
    {
      type: 'update_context',
      set: { 'lab_processing.labcorp_status': 'ordered' }
    }
  ],

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
      // NO automatic transition — the webhook sets status, but we wait for
      // actual results to be available (fetched or uploaded) before advancing.
      // Server.js will call checkCompletion after successful fetch/upload.
      transition: null,
      after: [
        {
          type: 'transaction_note',
          template: 'Lab results notification received.'
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
  },

  /**
   * Block advances only when actual results are available — either:
   * 1. Auto-fetched from LabCorp (panels array populated), or
   * 2. Physician uploaded lab results (physician is the authority to unstick the process)
   *
   * Customer uploads are accepted and stored, but do NOT advance the block.
   * The webhook sets labcorp_status = 'results_ready', but that alone
   * is NOT enough. We need authoritative data to be present.
   */
  checkCompletion(blockDef, context) {
    const lp = context.lab_processing || {};

    // Path 1: Auto-fetched results (panels available)
    if (lp.panels && Array.isArray(lp.panels) && lp.panels.length > 0) {
      return true;
    }

    // Path 2: Physician uploaded lab results (physician is the authority)
    if (lp._physician_uploaded_results && lp.results_s3_key) {
      return true;
    }

    return false;
  }
};
