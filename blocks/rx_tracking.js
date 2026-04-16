/**
 * RX Tracking — Conversational Block (multi-actor)
 *
 * Customer is informed of prescription order status and checks in.
 * Physician can also update status (e.g. mark as received/fulfilled).
 * Handles check-in reminders via scheduled events.
 * This is typically the final block in a journey with an RX component.
 */

module.exports = {
  type: 'conversational',
  name: 'rx_tracking',

  actor: 'any',  // Both customer and physician can interact
  default_visibility: ['customer', 'agent'],

  params_schema: {
    checkin_delay: { type: 'string' }
  },

  reads: ['encounter_notes.*', 'rx_order.*', 'simple_intake.*'],
  writes: ['rx_tracking.received', 'rx_tracking.side_effects_reported'],

  handles_events: ['conversation', 'scheduled'],

  on_enter: [
    {
      type: 'respond',
      template: 'Your prescription for {{encounter_notes.medication_name}} has been submitted to the pharmacy. We\'ll check in with you to see how things are going.'
    },
    {
      type: 'update_context',
      set: { 'rx_tracking.status': 'awaiting_delivery' }
    }
  ],

  on_scheduled_event: {
    rx_checkin: {
      before: [],
      transition: null,
      after: [
        {
          type: 'respond',
          template: 'Hi {{simple_intake.customerName}}, have you received your prescription yet? How are you feeling?'
        }
      ]
    }
  },

  on_conversation_event: {
    completion_condition: null  // rx_tracking stays open
  },

  checkCompletion(blockDef, context) {
    return context.rx_tracking?.received === true
      || context.rx_tracking?.completed === true;
  }
};
