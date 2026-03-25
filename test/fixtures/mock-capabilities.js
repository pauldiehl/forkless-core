/**
 * Mock capabilities for testing.
 *
 * These simulate external API integrations (lab provider, payment provider,
 * scheduling provider) with deterministic, inspectable behavior.
 *
 * Each capability follows the interface:
 *   { execute: async (params, context) => result }
 *
 * Consumers build real capabilities with the same interface.
 */

/**
 * Mock lab order creation.
 * Simulates creating a lab order with a provider.
 */
const labCreateOrder = {
  execute: async (params, context) => {
    const orderId = params.order_id || `lab_${Date.now().toString(36)}`;
    return {
      lab_order_id: orderId,
      provider: params.provider || 'labcorp',
      status: 'pending',
      requisition_url: `https://labcorp.example/req/${orderId}`,
      created_at: new Date().toISOString()
    };
  }
};

/**
 * Mock lab status check.
 * Returns a status based on params or a default.
 */
const labCheckStatus = {
  execute: async (params, context) => {
    return {
      lab_order_id: params.lab_order_id || context?.lab_processing?.lab_order_id,
      status: params.status || 'processing',
      checked_at: new Date().toISOString()
    };
  }
};

/**
 * Mock lab results fetch.
 * Returns mock lab results.
 */
const labFetchResults = {
  execute: async (params, context) => {
    return {
      lab_order_id: params.lab_order_id || context?.lab_processing?.lab_order_id,
      summary: 'TSH elevated (6.2), other panels normal',
      pdf_url: `https://labcorp.example/results/${params.lab_order_id || 'unknown'}.pdf`,
      panels: [
        { name: 'TSH', value: 6.2, unit: 'mIU/L', range: '0.4-4.0', flag: 'high' },
        { name: 'Free T4', value: 1.1, unit: 'ng/dL', range: '0.8-1.8', flag: 'normal' }
      ]
    };
  }
};

/**
 * Mock payment checkout creation.
 * Simulates creating a checkout URL with a payment provider.
 */
const paymentCreateCheckout = {
  execute: async (params, context) => {
    const orderId = params.order_id || `sq_${Date.now().toString(36)}`;
    return {
      order_id: orderId,
      checkout_url: `https://square.example/pay/${orderId}`,
      amount_cents: params.amount_cents,
      status: 'pending',
      created_at: new Date().toISOString()
    };
  }
};

/**
 * Mock scheduling — get available slots.
 */
const schedulingGetSlots = {
  execute: async (params, context) => {
    return {
      slots: [
        { datetime: '2026-04-01T14:30:00Z', display: 'Tue Apr 1, 2:30 PM' },
        { datetime: '2026-04-02T10:00:00Z', display: 'Wed Apr 2, 10:00 AM' },
        { datetime: '2026-04-02T15:00:00Z', display: 'Wed Apr 2, 3:00 PM' }
      ],
      event_type: params.event_type || 'consultation'
    };
  }
};

/**
 * Mock notification sender.
 */
const notify = {
  execute: async (params, context) => {
    return {
      sent: true,
      channel: params.channel || 'email',
      to: params.to || context?.simple_intake?.customerEmail,
      message: params.message,
      sent_at: new Date().toISOString()
    };
  }
};

/**
 * Register all mock capabilities on a capability registry.
 */
function registerMockCapabilities(registry) {
  registry.register('lab_create_order', labCreateOrder);
  registry.register('lab_check_status', labCheckStatus);
  registry.register('lab_fetch_results', labFetchResults);
  registry.register('payment_create_checkout', paymentCreateCheckout);
  registry.register('scheduling_get_slots', schedulingGetSlots);
  registry.register('notify', notify);
}

module.exports = {
  labCreateOrder,
  labCheckStatus,
  labFetchResults,
  paymentCreateCheckout,
  schedulingGetSlots,
  notify,
  registerMockCapabilities
};
