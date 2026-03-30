/**
 * Block Executor — the JSM core loop.
 *
 * Executes one cycle:
 *   context + event → before-actions → transition → after-actions → new context
 *
 * This module has ZERO knowledge of specific blocks.
 * It reads the block contract and follows instructions.
 */

function createBlockExecutor({ actionDispatcher, blockRegistry, conversationStore }) {

  /**
   * Execute one cycle of the JSM core loop.
   *
   * @param {Object} opts
   * @param {Object} opts.event - The incoming event
   * @param {Object} opts.context - Current journey context
   * @param {Object} opts.blockDef - Block entry from journey definition (has .block and .params)
   * @param {Object} opts.journeyDef - Full journey definition
   * @returns {Object} { newContext, actions, transitioned, beforeResults, error }
   */
  async function execute({ event, context, blockDef, journeyDef }) {
    const blockContract = blockRegistry[blockDef.block];
    if (!blockContract) throw new Error(`No block registered: ${blockDef.block}`);

    // Does this block handle this event type?
    if (!blockContract.handles_events.includes(event.type)) {
      return { newContext: context, actions: [], transitioned: false };
    }

    // Find the appropriate handler
    const handler = getHandler(blockContract, event);

    if (!handler) {
      // No specific handler matched.
      // For conversational blocks with conversation events → LLM handles it
      if (blockContract.type === 'conversational' && event.type === 'conversation') {
        return await handleConversational(blockContract, blockDef, event, context, journeyDef);
      }
      return { newContext: context, actions: [], transitioned: false };
    }

    // ── Run BEFORE actions ──
    let beforeResults = {};
    if (handler.before) {
      for (const action of handler.before) {
        const resolvedAction = resolveActionRefs(action, context, event);
        const result = await actionDispatcher.dispatch(resolvedAction, context, event);
        beforeResults = { ...beforeResults, ...result };
        if (resolvedAction.type === 'validate' && !result.valid) {
          return { newContext: context, actions: [resolvedAction], transitioned: false, error: result.reason, beforeResults };
        }
      }
    }

    // ── Determine transition ──
    let newContext = deepClone(context);
    let transitioned = false;

    if (handler.transition === 'next_block') {
      transitioned = transitionToNextBlock(newContext, journeyDef, blockDef);
    } else if (handler.transition && handler.transition !== null) {
      // Internal state transition
      const derivedState = resolveTransition(handler.transition, event);

      // If the block declares internal_states, validate the derived state
      if (blockContract.internal_states) {
        const internalState = blockContract.internal_states[derivedState];
        if (!internalState) {
          // Unrecognized state — don't update block_state, log a warning.
          // The event still gets logged by the router (audit trail), but
          // we won't silently record an undeclared state.
          return {
            newContext: context,
            actions: [],
            transitioned: false,
            warning: `Unrecognized internal state "${derivedState}" for block "${blockDef.block}". Event logged but state not updated.`,
            beforeResults
          };
        }

        newContext.block_state = derivedState;
        transitioned = true;

        if (internalState.is_exit) {
          transitionToNextBlock(newContext, journeyDef, blockDef);
        }
      } else {
        // No internal_states declared — accept the transition as-is
        newContext.block_state = derivedState;
        transitioned = true;
      }
    }

    // ── Run AFTER actions ──
    const afterActions = [];
    if (handler.after) {
      for (const action of handler.after) {
        const resolvedAction = resolveActionRefs(action, newContext, event);
        const result = await actionDispatcher.dispatch(resolvedAction, newContext, event);
        afterActions.push({ action: resolvedAction, result });
        if (resolvedAction.type === 'update_context' && resolvedAction.set) {
          newContext = applyContextUpdate(newContext, resolvedAction.set);
        }
      }
    }

    // ── Fire on_enter for new block if transitioned ──
    if (transitioned) {
      const enterResult = await fireOnEnter(newContext, journeyDef, event);
      if (enterResult) {
        newContext = enterResult.newContext;
        afterActions.push(...enterResult.actions);
      }
    }

    return { newContext, actions: afterActions, transitioned, beforeResults };
  }

  /**
   * Handle conversational block events via LLM.
   */
  async function handleConversational(blockContract, blockDef, event, context, journeyDef) {
    // 0. Fetch filtered conversation history for LLM context
    const blockActor = blockDef.actor || 'customer';
    // Use event.conversation_id first — it's the authoritative source from the event router.
    // context.conversation_id may be stale (e.g., from a previous CLI session with a persistent DB).
    const conversationId = event.conversation_id || context.conversation_id;
    let conversationHistory = null;
    if (conversationStore && conversationId) {
      conversationHistory = getConversationHistory(conversationStore, conversationId, { viewer: blockActor });
    }

    // Ensure conversation_id in context matches the event's conversation_id.
    // Always prefer event.conversation_id — context may hold a stale value from a prior session.
    if (conversationId) {
      context.conversation_id = conversationId;
    }

    // 1. Ask LLM to parse intent + extract data
    const parseResult = await actionDispatcher.dispatch(
      { type: 'parse_intent', payload: { text: event.payload.text, block: blockDef, conversationHistory } },
      context, event
    );

    // 2. Update context with any extracted data
    let newContext = deepClone(context);
    if (parseResult.extracted && Object.keys(parseResult.extracted).length > 0) {
      const namespace = blockDef.block;
      newContext[namespace] = { ...newContext[namespace], ...parseResult.extracted };
    }

    // 3. Check completion condition
    let transitioned = false;
    if (blockContract.checkCompletion && blockContract.checkCompletion(blockDef, newContext)) {
      transitioned = transitionToNextBlock(newContext, journeyDef, blockDef);
    }

    // 4. Fire on_enter for new block if transitioned
    if (transitioned) {
      const enterResult = await fireOnEnter(newContext, journeyDef, event);
      if (enterResult) {
        newContext = enterResult.newContext;
      }
    }

    // 5. LLM generates response — include visibility metadata from block definition
    const defaultVisibility = blockDef.default_visibility || ['customer', 'agent'];
    const respondResult = await actionDispatcher.dispatch(
      {
        type: 'respond',
        payload: { intent: parseResult.intent, context: newContext, block: blockDef, conversationHistory },
        visibility: defaultVisibility,
        actor: 'agent',
        block: blockDef.block,
        llm_routed: true
      },
      newContext, event
    );

    return {
      newContext,
      actions: [{ action: { type: 'respond' }, result: respondResult }],
      transitioned,
      parseResult
    };
  }

  /**
   * Fire on_enter actions for the current block.
   * Called after a transition lands on a new block.
   */
  async function fireOnEnter(context, journeyDef, event) {
    const currentBlockName = context.current_block;
    const blockDef = journeyDef.blocks.find(b => b.block === currentBlockName);
    if (!blockDef) return null;

    const blockContract = blockRegistry[blockDef.block];
    if (!blockContract?.on_enter || blockContract.on_enter.length === 0) return null;

    let newContext = deepClone(context);
    const actions = [];

    // Pre-populate context namespace with ALL block params so they're available
    // for params_from_context resolution and template rendering.
    // e.g. followup.cal_event_type, lab_processing.lab_provider, etc.
    const ns = blockDef.block;
    if (blockDef.params) {
      if (!newContext[ns]) newContext[ns] = {};
      for (const [key, value] of Object.entries(blockDef.params)) {
        if (newContext[ns][key] === undefined) {
          newContext[ns][key] = value;
        }
      }
      // Derived convenience values
      if (blockDef.params.amount_cents && !newContext[ns].price_display) {
        newContext[ns].price_display = `$${(blockDef.params.amount_cents / 100).toFixed(2)}`;
      }
    }

    for (const action of blockContract.on_enter) {
      const resolvedAction = resolveActionRefs(action, newContext, event);
      // Attach block params for capability param resolution
      resolvedAction._blockParams = blockDef.params;
      // Propagate block's default_visibility to respond actions that don't set their own
      if (resolvedAction.type === 'respond' && !resolvedAction.visibility) {
        resolvedAction.visibility = blockDef.default_visibility || blockContract.default_visibility;
      }

      let result;
      try {
        result = await actionDispatcher.dispatch(resolvedAction, newContext, event);
      } catch (err) {
        // on_enter actions should not crash the transition — log and continue
        console.warn(`[on_enter] Action "${resolvedAction.type}" failed for block "${blockDef.block}": ${err.message}`);
        actions.push({ action: resolvedAction, error: err.message });
        continue;
      }

      actions.push({ action: resolvedAction, result });

      // Capability results merge into the block's context namespace
      if ((resolvedAction.type === 'capability' || resolvedAction.type === 'execute_capability') && result && typeof result === 'object') {
        newContext[ns] = { ...newContext[ns], ...result };
        // Format slots array into display string for templates
        if (result.slots && Array.isArray(result.slots)) {
          newContext[ns].available_slots_display = result.slots
            .map((s, i) => `${i + 1}. ${s.display}`)
            .join('\n');
        }
      }
      // update_context actions
      if (resolvedAction.type === 'update_context' && resolvedAction.set) {
        newContext = applyContextUpdate(newContext, resolvedAction.set);
      }
    }

    return { newContext, actions };
  }

  return { execute, fireOnEnter };
}

// ── Helper functions ──

/**
 * Find the appropriate handler in a block contract for a given event.
 */
function getHandler(blockContract, event) {
  const eventTypeKey = `on_${event.type}_event`;
  const handlers = blockContract[eventTypeKey];
  if (!handlers) return null;

  // For api events, look up by source or payload-derived key
  if (event.type === 'api') {
    // First try the block's own getApiHandler if it exists
    if (blockContract.getApiHandler) {
      const handlerKey = blockContract.getApiHandler(event);
      if (handlerKey && handlers[handlerKey]) return handlers[handlerKey];
    }
    // Try event source as handler key
    if (handlers[event.source]) return handlers[event.source];
    // Try payload status
    if (event.payload?.status && handlers[event.payload.status]) return handlers[event.payload.status];
    return null;
  }

  // For scheduled events, look up by job_type
  if (event.type === 'scheduled') {
    const jobType = event.payload?.job_type;
    if (jobType && handlers[jobType]) return handlers[jobType];
    return null;
  }

  // For system events, look up by source
  if (event.type === 'system') {
    if (handlers[event.source]) return handlers[event.source];
    return null;
  }

  // Conversation events on capability blocks → no specific handler
  // (conversational blocks are handled via handleConversational)
  return null;
}

/**
 * Check if a block should be skipped based on its skip_if condition.
 * skip_if is a dot-notation path into the context — if the value is truthy, skip.
 */
function shouldSkipBlock(blockDef, context) {
  if (!blockDef.skip_if) return false;
  const parts = blockDef.skip_if.split('.');
  let value = context;
  for (const part of parts) {
    if (value === undefined || value === null) return false;
    value = value[part];
  }
  return !!value;
}

/**
 * Find the next block in the journey sequence.
 */
function getNextBlock(journeyDef, currentBlockDef) {
  if (!journeyDef || !journeyDef.blocks) return null;
  const idx = journeyDef.blocks.findIndex(b => b.block === currentBlockDef.block);
  if (idx === -1 || idx >= journeyDef.blocks.length - 1) return null;
  return journeyDef.blocks[idx + 1];
}

/**
 * Transition context to the next block. Mutates newContext. Returns whether transition happened.
 */
function transitionToNextBlock(newContext, journeyDef, currentBlockDef) {
  let nextBlock = getNextBlock(journeyDef, currentBlockDef);

  // Skip blocks with skip_if conditions that evaluate to truthy
  let cursor = currentBlockDef;
  while (nextBlock && shouldSkipBlock(nextBlock, newContext)) {
    cursor = nextBlock;
    nextBlock = getNextBlock(journeyDef, cursor);
  }

  if (nextBlock) {
    const now = new Date().toISOString();
    // Mark previous block as exited
    if (newContext.block_history && newContext.block_history.length > 0) {
      const prev = newContext.block_history[newContext.block_history.length - 1];
      if (prev && !prev.exited) prev.exited = now;
    }
    newContext.current_block = nextBlock.block;
    newContext.block_state = null;
    if (!newContext.block_history) newContext.block_history = [];
    newContext.block_history.push({ block: nextBlock.block, entered: now, exited: null });
    return true;
  } else {
    newContext.journey_status = 'completed';
    return false;
  }
}

/**
 * Resolve a transition value. If it starts with 'derived_from_', extract from event payload.
 */
function resolveTransition(transition, event) {
  if (typeof transition !== 'string') return transition;
  if (transition.startsWith('derived_from_')) {
    const path = transition.replace('derived_from_', '');
    const parts = path.split('.');
    let value = event;
    for (const part of parts) {
      if (value === undefined || value === null) return transition;
      value = value[part];
    }
    return value || transition;
  }
  return transition;
}

/**
 * Resolve action references like $now and context paths.
 */
function resolveActionRefs(action, context, event) {
  const resolved = deepClone(action);
  if (resolved.set) {
    for (const [key, value] of Object.entries(resolved.set)) {
      if (value === '$now') resolved.set[key] = new Date().toISOString();
    }
  }
  return resolved;
}

/**
 * Apply context update. Supports dot-notation keys.
 */
function applyContextUpdate(context, updates) {
  const ctx = { ...context };
  for (const [key, value] of Object.entries(updates)) {
    const parts = key.split('.');
    if (parts.length === 1) {
      ctx[key] = value;
    } else {
      let target = ctx;
      for (let i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === undefined || target[parts[i]] === null) {
          target[parts[i]] = {};
        }
        if (typeof target[parts[i]] !== 'object') {
          target[parts[i]] = {};
        }
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;
    }
  }
  return ctx;
}

/**
 * Get filtered conversation history for LLM prompt assembly.
 *
 * Filters by visibility (only messages the block's actor should see)
 * and excludes llm_routed:false messages (DMs, transaction notes).
 *
 * @param {Object} conversationStore - db.conversations
 * @param {string} conversationId
 * @param {Object} [opts]
 * @param {string} [opts.viewer] - Actor perspective for visibility filter
 * @param {boolean} [opts.includeLlmRouted] - If false, exclude llm_routed:false (default: false)
 * @returns {Array} Filtered messages
 */
function getConversationHistory(conversationStore, conversationId, opts = {}) {
  const viewer = opts.viewer || null;
  const includeLlmRouted = opts.includeLlmRouted || false;

  let messages;
  if (viewer && conversationStore.getMessages) {
    messages = conversationStore.getMessages(conversationId, { viewer });
  } else {
    const convo = conversationStore.get(conversationId);
    messages = convo ? convo.messages : [];
  }

  if (!messages) return [];
  if (!includeLlmRouted) {
    messages = messages.filter(m => m.llm_routed !== false);
  }
  return messages;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = { createBlockExecutor, getHandler, getNextBlock, shouldSkipBlock, resolveTransition, applyContextUpdate, getConversationHistory };
