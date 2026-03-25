/**
 * Recommendation — Conversational Block
 *
 * Presents a recommendation and collects user agreement.
 * Transitions to next block when user agrees.
 */

module.exports = {
  type: 'conversational',
  name: 'recommendation',

  params_schema: {
    include_agreement: { type: 'boolean' },
    agreement_template: { type: 'string' },
    price_cents: { type: 'number', required: true }
  },

  reads: ['intake.*'],
  writes: ['recommendation.offering', 'recommendation.agreed', 'recommendation.panels'],

  handles_events: ['conversation'],

  on_conversation_event: {
    completion_condition: 'user_agreed'
  },

  checkCompletion(blockDef, context) {
    return context.recommendation?.agreed === true;
  }
};
