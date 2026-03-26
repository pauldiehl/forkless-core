/**
 * RX Review — Conversational Block (physician-facing)
 *
 * Physician confirms, edits, or skips prescription details.
 * Can mark requires_payment: false to bypass RX payment.
 *
 * Completion: rx_confirmed OR rx_skipped
 */

module.exports = {
  type: 'conversational',
  name: 'rx_review',

  actor: 'physician',
  default_visibility: ['physician', 'agent'],

  params_schema: {
    allow_skip: { type: 'boolean' },
    require_consent: { type: 'boolean' }
  },

  reads: ['encounter_notes.*', 'simple_intake.*'],
  writes: [
    'rx_review.medication_name',
    'rx_review.dosage',
    'rx_review.frequency',
    'rx_review.rx_confirmed',
    'rx_review.rx_skipped',
    'rx_review.requires_payment'
  ],

  handles_events: ['conversation'],

  on_enter: [
    {
      type: 'respond',
      template: 'Based on the encounter notes, please confirm the prescription details for {{simple_intake.customerName}}. You can also skip if no prescription is needed.'
    }
  ],

  on_conversation_event: {
    completion_condition: 'rx_confirmed_or_skipped'
  },

  checkCompletion(blockDef, context) {
    return context.rx_review?.rx_confirmed === true
      || context.rx_review?.rx_skipped === true;
  }
};
