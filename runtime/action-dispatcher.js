/**
 * Action Dispatcher — routes action objects to the appropriate system.
 *
 * Action types:
 *   respond          → send message to conversation (template or LLM-generated)
 *   transaction_note → add transaction note to conversation
 *   execute_capability → call an external capability
 *   validate         → run validation rules
 *   parse_intent     → ask LLM to parse user intent
 *   update_context   → update context keys (handled by block executor after dispatch)
 *   schedule         → schedule a future event
 *   log              → log an event
 *   transition       → signal a state transition (handled by block executor)
 */

function createActionDispatcher({ conversationStore, capabilityRegistry, scheduler, logger, llm }) {

  async function dispatch(action, context, event) {
    switch (action.type) {

      case 'respond': {
        const msgMeta = {
          role: 'agent',
          visibility: action.visibility,
          actor: action.actor || 'agent',
          block: action.block || context.current_block,
          llm_routed: action.llm_routed
        };
        if (action.template) {
          const rawText = resolveTemplate(action.template, context);
          // Phase 13.3b — strip lines whose template tokens didn't resolve
          // before sending to the customer. resolveTemplate intentionally
          // leaves missing paths as the literal `{{ns.key}}` (useful for
          // dev visibility in transaction notes / logs), but the customer
          // shouldn't see raw curly braces. If every line is unresolved,
          // suppress the send entirely and let the dev see the warn.
          const text = stripUnresolvedTemplateLines(rawText, action.block || context.current_block);
          if (!text || !text.trim()) {
            console.warn(`[respond] All lines had unresolved {{...}} tokens — suppressing message entirely (block: ${action.block || 'unknown'})`);
            return { sent: false, reason: 'all_lines_unresolved' };
          }
          if (conversationStore && context.conversation_id) {
            await conversationStore.addMessage(context.conversation_id, { ...msgMeta, text });
          } else if (!context.conversation_id) {
            console.warn(`[respond] No conversation_id in context — template response not stored (block: ${action.block || 'unknown'})`);
          }
          return { sent: true, text };
        } else if (action.payload) {
          if (!llm) return { sent: false, reason: 'no_llm_configured' };
          const text = await llm.generateResponse(action.payload.intent, action.payload.context, action.payload.block, action.payload.conversationHistory);
          if (conversationStore && context.conversation_id) {
            await conversationStore.addMessage(context.conversation_id, { ...msgMeta, text });
          } else if (!context.conversation_id) {
            console.warn(`[respond] No conversation_id in context — agent response generated but not stored (block: ${action.block || 'unknown'})`);
          }
          return { sent: true, text };
        }
        return { sent: false, reason: 'no_template_or_payload' };
      }

      case 'transaction_note': {
        const text = action.template
          ? resolveTemplate(action.template, context)
          : action.text || '';
        if (conversationStore && context.conversation_id) {
          await conversationStore.addMessage(context.conversation_id, {
            role: 'transaction',
            text,
            visibility: action.visibility || ['all'],
            actor: 'system',
            block: action.block || context.current_block,
            llm_routed: false
          });
        }
        return { sent: true, text };
      }

      case 'execute_capability': {
        if (!capabilityRegistry) throw new Error('No capability registry configured');
        const capability = capabilityRegistry.get(action.capability);
        if (!capability) throw new Error(`Unknown capability: ${action.capability}`);
        const result = await capability.execute(action.params || {}, context);
        return result;
      }

      case 'capability': {
        if (!capabilityRegistry) throw new Error('No capability registry configured');
        const cap = capabilityRegistry.get(action.capability);
        if (!cap) throw new Error(`Capability not found: ${action.capability}`);
        // Resolve params from context + block params
        const resolvedParams = {};
        if (action.params_from_context) {
          for (const [key, source] of Object.entries(action.params_from_context)) {
            // Check block params first (action._blockParams), then context path
            const fromBlockParams = action._blockParams ? getNestedValue(action._blockParams, key) : null;
            resolvedParams[key] = fromBlockParams || getNestedValue(context, source) || null;
          }
        }
        if (action.params) {
          Object.assign(resolvedParams, action.params);
        }
        const capResult = await cap.execute(resolvedParams, context);
        return capResult;
      }

      case 'validate': {
        return runValidation(action, context, event);
      }

      case 'parse_intent': {
        if (!llm) return { intent: 'unknown', extracted: {}, reason: 'no_llm_configured' };
        console.log(`[action-dispatcher] parse_intent for block="${action.payload.block?.block || '?'}" text="${(action.payload.text || '').slice(0, 60)}..."`);
        const result = await llm.parseIntent(action.payload.text, context, action.payload.block, action.payload.conversationHistory);
        return result;
      }

      case 'update_context': {
        // Actual context mutation is handled by block executor after dispatch
        return { applied: true };
      }

      case 'schedule': {
        if (!scheduler) throw new Error('No scheduler configured');
        await scheduler.schedule({
          type: action.payload.job_type,
          runAt: computeRunAt(action.payload.delay),
          params: { journey_id: context.journey_id, ...action.payload }
        });
        return { scheduled: true };
      }

      case 'log': {
        const level = action.payload?.level || 'info';
        const message = action.payload?.message || '';
        if (logger && typeof logger[level] === 'function') {
          logger[level](message, action.payload?.data);
        } else if (logger && typeof logger.log === 'function') {
          logger.log(level, message, action.payload?.data);
        }
        return { logged: true };
      }

      case 'transition': {
        // Handled by block executor
        return { noted: true };
      }

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  return { dispatch };
}

/**
 * Get a nested value from an object using dot-notation path.
 */
function getNestedValue(obj, path) {
  if (!obj || !path) return null;
  const parts = path.split('.');
  let value = obj;
  for (const part of parts) {
    if (value === undefined || value === null) return null;
    value = value[part];
  }
  return value !== undefined ? value : null;
}

/**
 * Resolve a template string with context values.
 * Supports {{key}} and {{namespace.key}} patterns.
 */
function resolveTemplate(template, context) {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const parts = path.split('.');
    let value = context;
    for (const part of parts) {
      if (value === undefined || value === null) return match;
      value = value[part];
    }
    return value !== undefined && value !== null ? String(value) : match;
  });
}

/**
 * Phase 13.3b — drop newline-delimited lines that still contain a `{{...}}`
 * token after template resolution. Used to keep customer-facing respond
 * messages clean when context paths are missing (e.g. an upstream
 * capability failed to populate the value). Logs each dropped line at
 * warn level so devs can see the leak in development.
 *
 * If the entire template resolved cleanly, the input is returned unchanged.
 *
 * @param {string} text — already-rendered template text
 * @param {string} [blockName] — block name, for log context only
 * @returns {string}
 */
function stripUnresolvedTemplateLines(text, blockName) {
  if (!text || typeof text !== 'string') return text;
  if (!text.includes('{{')) return text;
  const tokenRe = /\{\{(\w+(?:\.\w+)*)\}\}/;
  const lines = text.split('\n');
  const kept = [];
  for (const line of lines) {
    if (tokenRe.test(line)) {
      console.warn(`[respond] Dropping line with unresolved template (block: ${blockName || 'unknown'}): ${line.trim().slice(0, 100)}`);
      continue;
    }
    kept.push(line);
  }
  // Collapse 3+ blank lines that often appear after dropping a line in
  // the middle of a multi-paragraph template.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Run validation rules against context and event.
 */
function runValidation(action, context, event) {
  const rules = action.rules || [];
  for (const rule of rules) {
    if (rule.required) {
      const parts = rule.field.split('.');
      let value = context;
      for (const part of parts) {
        if (value === undefined || value === null) { value = undefined; break; }
        value = value[part];
      }
      if (value === undefined || value === null || value === '') {
        return { valid: false, reason: `Missing required field: ${rule.field}` };
      }
    }
    if (rule.pattern) {
      const parts = rule.field.split('.');
      let value = context;
      for (const part of parts) {
        if (value === undefined || value === null) { value = ''; break; }
        value = value[part];
      }
      if (!new RegExp(rule.pattern).test(String(value))) {
        return { valid: false, reason: `Field ${rule.field} does not match pattern: ${rule.pattern}` };
      }
    }
  }
  return { valid: true };
}

/**
 * Compute a run-at timestamp from a delay string (e.g., "48h", "7d", "30m").
 */
function computeRunAt(delay) {
  if (!delay) return new Date().toISOString();
  const match = delay.match(/^(\d+)(m|h|d)$/);
  if (!match) return delay; // assume ISO string
  const [, amount, unit] = match;
  const ms = { m: 60000, h: 3600000, d: 86400000 }[unit];
  return new Date(Date.now() + parseInt(amount) * ms).toISOString();
}

module.exports = { createActionDispatcher, resolveTemplate, runValidation, computeRunAt };
