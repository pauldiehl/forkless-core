/**
 * Simple Intake — Conversational Block
 *
 * Collects required fields from the user via LLM-mediated conversation.
 * The LLM parses intent and extracts structured data; the block validates
 * against required_fields and transitions when all are collected.
 */

module.exports = {
  type: 'conversational',
  name: 'simple_intake',

  params_schema: {
    required_fields: { type: 'array', items: 'string', required: true },
    questions: { type: 'array', items: 'string' }
  },

  reads: [],
  writes: ['simple_intake.*'],

  handles_events: ['conversation'],

  on_conversation_event: {
    completion_condition: 'all_required_fields_present'
  },

  /**
   * Check if all required fields have been collected.
   */
  checkCompletion(blockDef, context) {
    const requiredFields = blockDef.params.required_fields || [];
    const ns = context[blockDef.block] || context.intake || {};
    const allRequired = requiredFields.every(field => {
      const val = ns[field];
      return val !== undefined && val !== null && val !== '';
    });
    // All required fields + medical history asked (even if "none")
    return allRequired && ns.medicalHistory !== undefined;
  },

  /**
   * Get the list of fields still missing.
   */
  getMissingFields(blockDef, context) {
    const requiredFields = blockDef.params.required_fields || [];
    const ns = context[blockDef.block] || context.intake || {};
    return requiredFields.filter(field => {
      const val = ns[field];
      return val === undefined || val === null || val === '';
    });
  }
};
