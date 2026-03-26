/**
 * RX Consent — Conversational Block (customer-facing)
 *
 * Sends consent request to customer with prescription details.
 * Waits for customer acknowledgment via conversation.
 *
 * Completion: consented === true
 */

module.exports = {
  type: 'conversational',
  name: 'rx_consent',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {},

  reads: ['rx_review.*', 'simple_intake.*'],
  writes: ['rx_consent.consented', 'rx_consent.consented_at'],

  handles_events: ['conversation'],

  on_enter: [
    {
      type: 'respond',
      template: 'Your physician has prescribed {{rx_review.medication_name}} ({{rx_review.dosage}}, {{rx_review.frequency}}). Do you consent to this prescription?'
    }
  ],

  on_conversation_event: {
    completion_condition: 'customer_consented'
  },

  checkCompletion(blockDef, context) {
    return context.rx_consent?.consented === true;
  }
};
