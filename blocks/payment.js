/**
 * Payment — Capability Block
 *
 * Handles payment flow via external provider (Square, Stripe).
 * Responds to API events (webhooks) for payment completion/failure.
 * Supports conversation events for payment questions.
 */

module.exports = {
  type: 'capability',
  name: 'payment',

  actor: 'customer',
  default_visibility: ['customer', 'agent'],

  params_schema: {
    amount_cents: { type: 'number', required: true },
    product_slug: { type: 'string', required: true },
    provider: { type: 'string', enum: ['square', 'stripe'], required: true }
  },

  reads: ['simple_intake.customerName', 'simple_intake.customerEmail', 'recommendation.agreed'],
  writes: ['payment.order_id', 'payment.status', 'payment.completed_at', 'payment.checkout_url'],

  handles_events: ['conversation', 'api'],

  on_enter: [
    {
      type: 'capability',
      capability: 'square_create_checkout',
      params_from_context: {
        amount_cents: 'payment.amount_cents',
        product_slug: 'payment.product_slug',
        product_name: 'payment.product_name',
        buyer_email: 'simple_intake.customerEmail',
        buyer_phone: 'payment.buyer_phone'
      }
    },
    {
      type: 'respond',
      template: 'Here\'s your secure payment link: {{payment.checkout_url}}\n\nThe total is {{payment.price_display}}. Once payment is confirmed, we\'ll get your next steps set up right away.'
    },
    {
      type: 'update_context',
      set: { 'payment.status': 'pending' }
    }
  ],

  on_conversation_event: {
    allowed_intents: ['payment_question', 'cancel_order']
  },

  on_api_event: {
    payment_completed: {
      before: [
        {
          type: 'validate',
          rules: [
            { field: 'payment.order_id', required: true }
          ]
        }
      ],
      transition: 'next_block',
      after: [
        {
          type: 'transaction_note',
          template: 'Payment received for order {{payment.order_id}}.'
        },
        {
          type: 'update_context',
          set: {
            'payment.status': 'completed',
            'payment.completed_at': '$now'
          }
        }
      ]
    },
    payment_failed: {
      before: [],
      transition: null,
      after: [
        {
          type: 'respond',
          template: 'Your payment could not be processed. Please try again or use a different payment method.'
        },
        {
          type: 'update_context',
          set: { 'payment.status': 'failed' }
        }
      ]
    }
  },

  /**
   * Determine which api event handler to use based on the event payload.
   */
  getApiHandler(event) {
    const status = event.payload?.status;
    if (status === 'completed') return 'payment_completed';
    if (status === 'failed') return 'payment_failed';
    return null;
  }
};
