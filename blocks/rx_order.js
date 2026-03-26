/**
 * RX Order — Conversational Block (physician-facing)
 *
 * Notifies physician that consent + payment are confirmed.
 * Physician submits RX to pharmacy (manual for now, future integration).
 *
 * Completion: submitted === true
 */

module.exports = {
  type: 'conversational',
  name: 'rx_order',

  actor: 'physician',
  default_visibility: ['physician', 'agent'],

  params_schema: {},

  reads: ['rx_review.*', 'rx_consent.*', 'rx_payment.*', 'simple_intake.*'],
  writes: ['rx_order.submitted', 'rx_order.pharmacy', 'rx_order.submitted_at'],

  handles_events: ['conversation'],

  on_enter: [
    {
      type: 'respond',
      template: 'Patient {{simple_intake.customerName}} has consented and payment is confirmed. Please submit the prescription for {{rx_review.medication_name}} ({{rx_review.dosage}}, {{rx_review.frequency}}) to the pharmacy.'
    }
  ],

  on_conversation_event: {
    completion_condition: 'rx_submitted'
  },

  checkCompletion(blockDef, context) {
    return context.rx_order?.submitted === true;
  }
};
