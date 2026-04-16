/**
 * Patient Delivery — Bundled post-consultation delivery to customer.
 *
 * On entry, delivers everything at once:
 * 1. Visit summary artifact link (always)
 * 2. Treatment consent form link (if special treatment: TRT, GLP-1, ED, hair-loss)
 * 3. Payment link (if RX prescribed)
 *
 * Completes when:
 * - No RX: customer acknowledges summary
 * - Basic RX: payment completed (summary + rx + payment link presented together on entry)
 * - Special RX: customer signs consent + payment completed
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

  // on_enter is intentionally empty — the server-side bundled materials
  // presentation handles the initial message with summary + rx + payment link.
  on_enter: [],

  on_api_event: {
    payment_completed: {
      before: [],
      transition: 'next_block',
      after: [
        { type: 'update_context', set: { 'patient_delivery.payment_status': 'completed', 'patient_delivery.payment_completed_at': '$now' } },
        { type: 'respond', template: 'Payment confirmed! Your prescription for {{encounter_notes.medication_name}} is being sent to {{encounter_notes.pharmacy}}. You should be able to pick it up within 1-2 business days.' },
        { type: 'transaction_note', template: 'Prescription payment received.' }
      ]
    },
    payment_failed: {
      before: [],
      transition: null,
      after: [
        { type: 'respond', template: 'Your payment could not be processed. Please try again or use a different payment method.' },
        { type: 'update_context', set: { 'patient_delivery.payment_status': 'failed' } }
      ]
    }
  },

  /**
   * Route webhook payloads to the right handler.
   * Square sends: { status: 'completed' | 'failed', order_id: '...' }
   */
  getApiHandler(event) {
    const status = event.payload?.status;
    if (status === 'completed') return 'payment_completed';
    if (status === 'failed') return 'payment_failed';
    // Also accept { type: 'payment.completed' } format
    if (event.payload?.type === 'payment.completed') return 'payment_completed';
    if (event.payload?.type === 'payment.failed') return 'payment_failed';
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

    // RX path: payment must be completed (via webhook)
    if (pd.payment_status !== 'completed') return false;

    // For special treatments: formal consent must also be signed
    if (pd._consent_required === true) {
      return pd.consent_signed === true;
    }

    // Basic RX: payment is sufficient — no intermediate acknowledgment needed
    return true;
  }
};
