/**
 * Encounter Notes — Conversational Block (physician-facing)
 *
 * Multi-phase workflow:
 * Phase 1: Physician pastes notes → LLM generates structured clinical summary
 * Phase 2: Physician reviews and approves (or requests edits)
 * Phase 3: If RX mentioned → capture RX details (medication, dosage, frequency, pharmacy)
 * Phase 4: Physician confirmation gate — reviews what will be sent to patient
 *          (external note, consent form, RX price) and confirms or adjusts
 *
 * Completion: delivery_confirmed === true (ensures physician approves everything)
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
    'encounter_notes.internal_note',    // captured post-approval from conversation
    'encounter_notes.medication_name',
    'encounter_notes.dosage',
    'encounter_notes.frequency',
    'encounter_notes.pharmacy',
    'encounter_notes.rx_confirmed',
    'encounter_notes.rx_price_cents',
    'encounter_notes.delivery_confirmed'
  ],

  handles_events: ['conversation', 'api'],

  // Accept meeting_ended webhook if it arrives while physician is writing notes.
  // This is informational — captures meeting metadata (and future transcription)
  // without disrupting the note-writing flow.
  on_api_event: {
    meeting_ended: {
      before: [],
      transition: null,
      after: [
        {
          type: 'update_context',
          set: { 'encounter_notes.meeting_data_received': true }
        }
        // Future: capture transcription from event.payload.transcription
        // and make it available to the LLM for note generation
      ]
    }
  },

  getApiHandler(event) {
    const trigger = (event.payload?.triggerEvent || event.payload?.trigger || '').toUpperCase();
    if (trigger === 'MEETING_ENDED' || trigger === 'MEETING_COMPLETE' || trigger === 'MEETING_COMPLETED') return 'meeting_ended';
    return null;
  },

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
    const en = context.encounter_notes || {};
    if (!en.physician_approved) return false;
    // If RX was mentioned, must also confirm RX details before completing
    if (en.rx_mentioned && !en.rx_confirmed) return false;
    // Physician must confirm what will be delivered to patient
    if (!en.delivery_confirmed) return false;
    return true;
  }
};
