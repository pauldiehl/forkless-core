/**
 * Mock LLM adapter for testing.
 *
 * Returns deterministic results based on input patterns.
 * Swap for real LLM adapter (OpenAI, Anthropic) in production.
 */

function createMockLLM() {

  /**
   * Parse user intent and extract structured data from text.
   * In production, this calls the LLM with the block's prompt + context.
   */
  async function parseIntent(text, context, blockDef) {
    const lower = text.toLowerCase();
    const blockName = blockDef?.block || blockDef?.name || '';

    // Presentation block — detect engagement
    if (blockName === 'presentation') {
      if (containsAny(lower, ['tired', 'fatigue', 'weight', 'symptom', 'help', 'interested', 'tell me', 'yes'])) {
        return {
          intent: 'describe_symptoms',
          extracted: { engaged: true },
          confidence: 0.9
        };
      }
      return { intent: 'browsing', extracted: {}, confidence: 0.5 };
    }

    // Simple intake — extract structured fields
    if (blockName === 'simple_intake') {
      const extracted = {};

      // Name extraction
      const nameMatch = text.match(/(?:my name is |i'm |i am |name:?\s*)([A-Z][a-z]+ [A-Z][a-z]+)/i);
      if (nameMatch) extracted.customerName = nameMatch[1];
      // Fallback: if text looks like just a name
      if (!extracted.customerName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(text.trim())) {
        extracted.customerName = text.trim();
      }

      // Email extraction
      const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch) extracted.customerEmail = emailMatch[1];

      // DOB extraction
      const dobMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
      if (dobMatch) extracted.customerDob = dobMatch[1];
      const dobMatch2 = text.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},?\s*\d{4})/i);
      if (dobMatch2) extracted.customerDob = dobMatch2[1];

      // Gender extraction
      if (containsAny(lower, ['female', 'woman', 'f'])) extracted.customerGender = 'Female';
      else if (containsAny(lower, ['male', 'man', 'm'])) extracted.customerGender = 'Male';

      // State extraction
      const stateMatch = text.match(/\b([A-Z]{2})\b/);
      if (stateMatch && isUSState(stateMatch[1])) extracted.stateOfResidence = stateMatch[1];
      const stateNameMatch = lower.match(/(?:in |from |live in |living in )(\w+)/);
      if (stateNameMatch) {
        const abbr = stateNameToAbbr(stateNameMatch[1]);
        if (abbr) extracted.stateOfResidence = abbr;
      }

      // Health concerns
      if (containsAny(lower, ['tired', 'fatigue', 'weight', 'pain', 'stress', 'sleep', 'energy'])) {
        const concerns = [];
        if (lower.includes('tired') || lower.includes('fatigue')) concerns.push('fatigue');
        if (lower.includes('weight')) concerns.push('weight changes');
        if (lower.includes('pain')) concerns.push('pain');
        if (lower.includes('stress')) concerns.push('stress');
        if (lower.includes('sleep')) concerns.push('sleep issues');
        if (concerns.length) extracted.healthConcerns = concerns.join(', ');
      }

      return {
        intent: Object.keys(extracted).length > 0 ? 'provide_info' : 'general_question',
        extracted,
        confidence: Object.keys(extracted).length > 0 ? 0.85 : 0.5
      };
    }

    // Recommendation block — detect agreement
    if (blockName === 'recommendation') {
      if (containsAny(lower, ['yes', 'sure', 'sounds good', 'let\'s do it', 'agree', 'perfect', 'ok', 'okay'])) {
        return { intent: 'agree_to_recommendation', extracted: { agreed: true }, confidence: 0.9 };
      }
      if (containsAny(lower, ['no', 'not sure', 'maybe later', 'too expensive'])) {
        return { intent: 'decline_recommendation', extracted: {}, confidence: 0.8 };
      }
      return { intent: 'recommendation_question', extracted: {}, confidence: 0.6 };
    }

    // Payment block
    if (blockName === 'payment') {
      if (containsAny(lower, ['secure', 'safe', 'refund', 'cancel'])) {
        return { intent: 'payment_question', extracted: {}, confidence: 0.8 };
      }
      return { intent: 'general_question', extracted: {}, confidence: 0.5 };
    }

    // Default
    return { intent: 'general_question', extracted: {}, confidence: 0.5 };
  }

  /**
   * Generate a response based on intent, context, and block definition.
   * In production, this calls the LLM with full context.
   */
  async function generateResponse(intent, context, blockDef) {
    const blockName = blockDef?.block || blockDef?.name || '';
    const ns = context?.[blockName] || {};
    const name = ns.customerName || context?.simple_intake?.customerName || context?.intake?.customerName || 'there';

    // Presentation
    if (blockName === 'presentation') {
      if (intent === 'describe_symptoms') return `That sounds like something we can help with. Let me get some information from you so we can figure out the best path forward. What's your full name?`;
      return `I'm here to help with your health journey. We offer comprehensive lab panels with medical consultations. What's been going on?`;
    }

    // Simple intake
    if (blockName === 'simple_intake') {
      if (intent === 'provide_info') {
        const missing = getMissingFieldsList(blockDef, context);
        if (missing.length === 0) return `Thanks ${name}! I have everything I need. Let me put together a recommendation for you.`;
        return `Thanks ${name}! I still need your ${missing.join(', ')}. Can you provide those?`;
      }
      return `I'd be happy to help with that. But first, let me finish collecting your information.`;
    }

    // Recommendation
    if (blockName === 'recommendation') {
      if (intent === 'agree_to_recommendation') return `Great choice! Let me set up your payment.`;
      if (intent === 'decline_recommendation') return `No problem at all. Take your time to think about it. I'm here whenever you're ready.`;
      return `Good question! I'd be happy to explain more about what's included.`;
    }

    // Payment
    if (blockName === 'payment') {
      if (intent === 'payment_question') return `Your payment is processed securely. If you have any issues, we're here to help.`;
      return `I can help with that after we complete your payment.`;
    }

    return `I'm here to help. What would you like to know?`;
  }

  return { parseIntent, generateResponse };
}

// ── Helpers ──

function containsAny(text, words) {
  return words.some(w => text.includes(w));
}

function getMissingFieldsList(blockDef, context) {
  const required = blockDef?.params?.required_fields || [];
  const blockName = blockDef?.block || blockDef?.name || '';
  const ns = context?.[blockName] || context?.intake || {};
  return required.filter(f => !ns[f] || ns[f] === '');
}

function isUSState(abbr) {
  const states = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
  return states.includes(abbr);
}

function stateNameToAbbr(name) {
  const map = { florida: 'FL', california: 'CA', texas: 'TX', 'new york': 'NY', georgia: 'GA', ohio: 'OH', virginia: 'VA', washington: 'WA', colorado: 'CO', illinois: 'IL', pennsylvania: 'PA', arizona: 'AZ', michigan: 'MI', tennessee: 'TN', maryland: 'MD', 'north carolina': 'NC', 'south carolina': 'SC' };
  return map[name.toLowerCase()] || null;
}

module.exports = { createMockLLM };
