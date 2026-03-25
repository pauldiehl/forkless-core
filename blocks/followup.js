/**
 * Followup — Conversational Block
 *
 * Post-journey follow-up. Handles scheduling, check-ins, and ongoing questions.
 * This is typically the final block in a journey.
 */

module.exports = {
  type: 'conversational',
  name: 'followup',

  params_schema: {
    include_scheduling: { type: 'boolean' },
    cal_event_type: { type: 'string' },
    first_checkin_delay: { type: 'string' }
  },

  reads: ['intake.*', 'recommendation.*', 'payment.*', 'lab_processing.*'],
  writes: ['followup.scheduling_offered', 'followup.appointment_booked'],

  handles_events: ['conversation', 'scheduled'],

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
          template: 'Hi {{intake.customerName}}, just checking in! How are you feeling since your consultation?'
        }
      ]
    }
  },

  checkCompletion() {
    return false;  // followup stays open
  }
};
