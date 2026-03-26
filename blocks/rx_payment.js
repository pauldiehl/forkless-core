/**
 * RX Payment — Capability Block (customer-facing)
 *
 * Same pattern as the main payment block but for prescription processing.
 * Can be bypassed if physician marked requires_payment: false.
 * Uses on_enter to create checkout link.
 *
 * Journey definitions should use skip_if: "rx_review.requires_payment === false"
 * or skip_if_not: "rx_review.requires_payment" to bypass when no payment needed.
 */

module.exports = {
  type: 'capability',
  name: 'rx_payment',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    amount_cents: { type: 'number' },
    product_slug: { type: 'string' }
  },

  reads: ['rx_review.*', 'simple_intake.*'],
  writes: ['rx_payment.order_id', 'rx_payment.status', 'rx_payment.checkout_url'],

  handles_events: ['conversation', 'api'],

  on_enter: [
    {
      type: 'capability',
      capability: 'square_create_checkout',
      params_from_context: {
        amount_cents: 'rx_payment.amount_cents',
        product_slug: 'rx_payment.product_slug',
        buyer_email: 'simple_intake.customerEmail'
      }
    },
    {
      type: 'respond',
      template: 'Here\'s your prescription payment link: {{rx_payment.checkout_url}}\n\nTotal: {{rx_payment.price_display}}'
    },
    {
      type: 'update_context',
      set: { 'rx_payment.status': 'pending' }
    }
  ],

  on_conversation_event: {
    allowed_intents: ['payment_question']
  },

  on_api_event: {
    payment_completed: {
      before: [
        { type: 'validate', rules: [{ field: 'rx_payment.order_id', required: true }] }
      ],
      transition: 'next_block',
      after: [
        { type: 'transaction_note', template: 'RX payment received.' },
        { type: 'update_context', set: { 'rx_payment.status': 'completed' } }
      ]
    },
    payment_failed: {
      before: [],
      transition: null,
      after: [
        { type: 'respond', template: 'Your prescription payment could not be processed. Please try again.' },
        { type: 'update_context', set: { 'rx_payment.status': 'failed' } }
      ]
    }
  },

  getApiHandler(event) {
    const status = event.payload?.status;
    if (status === 'completed') return 'payment_completed';
    if (status === 'failed') return 'payment_failed';
    return null;
  }
};
