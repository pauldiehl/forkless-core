/**
 * Presentation — Conversational Block
 *
 * Presents an offering to the user. Transitions to next block when
 * the user engages (describes symptoms, shows interest, asks questions).
 */

module.exports = {
  type: 'conversational',
  name: 'presentation',

  params_schema: {
    offering_slug: { type: 'string', required: true }
  },

  reads: [],
  writes: ['presentation.engaged', 'presentation.offering_slug'],

  handles_events: ['conversation', 'system'],

  on_conversation_event: {
    completion_condition: 'user_engaged'
  },

  on_system_event: {
    widget_loaded: {
      before: [],
      transition: null,
      after: [
        {
          type: 'update_context',
          set: { 'journey_status': 'in_progress' }
        }
      ]
    }
  },

  /**
   * Check if the user has engaged enough to move to intake.
   */
  checkCompletion(blockDef, context) {
    return context.presentation?.engaged === true;
  }
};
