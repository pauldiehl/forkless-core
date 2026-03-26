/**
 * Recommendation — Conversational Block
 *
 * Presents a recommendation and collects user agreement + formal consent.
 * Transitions to next block when user agrees AND consent is recorded.
 *
 * Consent recording is handled by the consumer (server layer) —
 * when the LLM extracts agreed: true, the consumer creates a business_record
 * and sets recommendation.consent_recorded = true before the next event.
 *
 * This two-step flow (agreed → consent_recorded) prevents premature transitions:
 * the block won't complete until the consumer has confirmed that consent
 * was properly logged.
 */

module.exports = {
  type: 'conversational',
  name: 'recommendation',

  params_schema: {
    include_agreement: { type: 'boolean' },
    agreement_template: { type: 'string' },
    price_cents: { type: 'number', required: true }
  },

  reads: ['simple_intake.*'],
  writes: ['recommendation.offering', 'recommendation.agreed', 'recommendation.panels', 'recommendation.consent_recorded'],

  handles_events: ['conversation'],

  on_conversation_event: {
    completion_condition: 'user_agreed_and_consent_recorded'
  },

  checkCompletion(blockDef, context) {
    return context.recommendation?.agreed === true
      && context.recommendation?.consent_recorded === true;
  }
};
