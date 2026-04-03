/**
 * Patient Delivery — Bundled post-consultation delivery to customer.
 *
 * On entry, delivers everything at once:
 * 1. Visit summary artifact link (always)
 * 2. Treatment consent form link (if RX prescribed)
 * 3. Payment link (if RX prescribed)
 *
 * Completes when:
 * - No RX: customer acknowledges summary
 * - RX: customer signs consent AND payment is completed
 */

module.exports = {
  type: 'conversational',
  name: 'patient_delivery',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    rx_amount_cents: { type: 'number' },
    product_slug: { type: 'string' }
  },

  reads: [
    'encounter_notes.*',
    'simple_intake.*',
    'lab_processing.*'
  ],
  writes: [
    'patient_delivery.summary_acknowledged',
    'patient_delivery.consent_signed',
    'patient_delivery.consent_signed_at',
    'patient_delivery.payment_status',
    'patient_delivery.payment_order_id',
    'patient_delivery.checkout_url',
    'patient_delivery.consent_types'
  ],

  handles_events: ['conversation', 'api'],

  on_enter: [
    {
      type: 'respond',
      template: 'Your consultation summary and next steps are ready, {{simple_intake.customerName}}!'
    }
  ],

  on_api_event: {
    payment_completed: {
      before: [],
      transition: null,
      after: [
        { type: 'update_context', set: { 'patient_delivery.payment_status': 'completed' } },
        { type: 'transaction_note', text: 'Prescription payment received.' }
      ]
    }
  },

  getApiHandler(event) {
    if (event.payload?.type === 'payment.completed') return 'payment_completed';
    return null;
  },

  on_conversation_event: {
    completion_condition: 'delivery_complete'
  },

  checkCompletion(blockDef, context) {
    const pd = context.patient_delivery || {};
    const rxPrescribed = context.encounter_notes?.rx_confirmed === true;

    if (!rxPrescribed) {
      // No RX: just needs to acknowledge summary
      return pd.summary_acknowledged === true;
    }

    // RX: needs consent + payment
    return pd.consent_signed === true && pd.payment_status === 'completed';
  }
};
