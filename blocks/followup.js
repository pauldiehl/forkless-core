/**
 * Followup — Conversational Block
 *
 * Post-journey follow-up. Handles scheduling, check-ins, and ongoing questions.
 * On entry, fetches available scheduling slots (if include_scheduling is true)
 * and presents them to the customer.
 *
 * This is typically the final customer-facing block before physician handoff.
 */

module.exports = {
  type: 'conversational',
  name: 'followup',

  params_schema: {
    include_scheduling: { type: 'boolean' },
    cal_event_type: { type: 'string' },
    cal_event_type_id: { type: 'number' },
    first_checkin_delay: { type: 'string' }
  },

  reads: ['simple_intake.*', 'recommendation.*', 'payment.*', 'lab_processing.*'],
  writes: [
    'followup.scheduling_offered',
    'followup.appointment_booked',
    'followup.booking_id',
    'followup.meeting_url',
    'followup.appointment_datetime',
    'followup.available_slots_display'
  ],

  handles_events: ['conversation', 'scheduled', 'api'],

  on_enter: [
    {
      type: 'capability',
      capability: 'scheduling_get_slots',
      params_from_context: {
        event_type: 'followup.cal_event_type',
        event_type_id: 'followup.cal_event_type_id'
      }
    },
    {
      type: 'respond',
      template: 'Let\'s schedule your physician consultation. Here are the available times:\n\n{{followup.available_slots_display}}\n\nWhich time works best for you?'
    },
    {
      type: 'update_context',
      set: { 'followup.scheduling_offered': true }
    }
  ],

  on_conversation_event: {
    completion_condition: null  // followup blocks don't auto-complete
  },

  on_scheduled_event: {
    checkin_reminder: {
      before: [],
      transition: null,
      after: [
        {
          type: 'respond',
          template: 'Hi {{simple_intake.customerName}}, just checking in! How are you feeling since your consultation?'
        }
      ]
    }
  },

  // Cal.com webhook events
  on_api_event: {
    booking_created: {
      before: [],
      transition: null,
      after: [
        {
          type: 'update_context',
          set: { 'followup.appointment_booked': true }
        }
      ]
    },
    meeting_ended: {
      before: [],
      transition: 'next_block',
      after: [
        {
          type: 'transaction_note',
          template: 'Consultation completed.'
        },
        {
          type: 'update_context',
          set: { 'followup.meeting_completed': true }
        }
      ]
    }
  },

  /**
   * Determine which api event handler to use.
   */
  getApiHandler(event) {
    const trigger = (event.payload?.triggerEvent || event.payload?.trigger || '').toUpperCase();
    // Accept common Cal.com trigger variants
    if (trigger === 'BOOKING_CREATED' || trigger === 'BOOKING_COMPLETED' || event.payload?.booking_created) return 'booking_created';
    if (trigger === 'MEETING_ENDED' || trigger === 'MEETING_COMPLETE' || trigger === 'MEETING_COMPLETED' || event.payload?.meeting_ended || event.payload?.meeting_completed || event.payload?.meeting_complete) return 'meeting_ended';
    return null;
  },

  checkCompletion() {
    return false;  // followup stays open — transitions via meeting_ended webhook
  }
};
