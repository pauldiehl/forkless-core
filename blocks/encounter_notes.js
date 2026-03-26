/**
 * Encounter Notes — Conversational Block (physician-facing)
 *
 * Physician pastes transcription or types notes from patient encounter.
 * LLM generates structured internal note (clinical) and external note
 * (patient-facing summary). Flags if prescription is mentioned.
 *
 * Completion: internal_note + external_note + physician_approved
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
    'encounter_notes.transcription',
    'encounter_notes.internal_note',
    'encounter_notes.external_note',
    'encounter_notes.rx_mentioned',
    'encounter_notes.physician_approved'
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
    return context.encounter_notes?.internal_note
      && context.encounter_notes?.external_note
      && context.encounter_notes?.physician_approved === true;
  }
};
