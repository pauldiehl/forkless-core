/**
 * Encounter Notes — Conversational Block (physician-facing)
 *
 * Two-turn workflow:
 * Turn 1: Physician pastes notes → LLM generates structured clinical summary
 * Turn 2: Physician reviews and approves (or requests edits)
 *
 * Structured notes live in the conversation as agent messages.
 * internal_note is captured post-approval from the last agent message.
 *
 * Completion: physician_approved === true
 */

module.exports = {
  type: 'conversational',
  name: 'encounter_notes',

  actor: 'physician',
  default_visibility: ['physician', 'agent'],

  params_schema: {
    note_sections: { type: 'array' },
    generate_external_note: { type: 'boolean' }
  },

  reads: ['simple_intake.*', 'lab_processing.*', 'followup.*'],
  writes: [
    'encounter_notes.notes_submitted',
    'encounter_notes.rx_mentioned',
    'encounter_notes.physician_approved',
    'encounter_notes.internal_note'    // captured post-approval from conversation
  ],

  handles_events: ['conversation'],

  on_enter: [
    {
      type: 'respond',
      template: 'Ready for encounter notes. Please paste the transcription or type your clinical notes for {{simple_intake.customerName}}.'
    }
  ],

  on_conversation_event: {
    completion_condition: 'notes_approved'
  },

  checkCompletion(blockDef, context) {
    return context.encounter_notes?.physician_approved === true;
  }
};
