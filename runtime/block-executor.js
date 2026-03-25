/**
 * Block Executor — the JSM core loop.
 *
 * Executes one cycle:
 *   context + event → before-actions → transition → after-actions → new context
 *
 * This module has ZERO knowledge of specific blocks.
 * It reads the block contract and follows instructions.
 */

function createBlockExecutor({ actionDispatcher, blockRegistry }) {

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
      newContext.block_state = resolveTransition(handler.transition, event);
      transitioned = true;

      // Check if this internal state is an exit state
      if (blockContract.internal_states) {
        const internalState = blockContract.internal_states[newContext.block_state];
        if (internalState && internalState.is_exit) {
          transitionToNextBlock(newContext, journeyDef, blockDef);
        }
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

    return { newContext, actions: afterActions, transitioned, beforeResults };
  }

  /**
   * Handle conversational block events via LLM.
   */
  async function handleConversational(blockContract, blockDef, event, context, journeyDef) {
    // 1. Ask LLM to parse intent + extract data
    const parseResult = await actionDispatcher.dispatch(
      { type: 'parse_intent', payload: { text: event.payload.text, block: blockDef } },
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

    // 4. LLM generates response
    const respondResult = await actionDispatcher.dispatch(
      { type: 'respond', payload: { intent: parseResult.intent, context: newContext, block: blockDef } },
      newContext, event
    );

    return {
      newContext,
      actions: [{ action: { type: 'respond' }, result: respondResult }],
      transitioned,
      parseResult
    };
  }

  return { execute };
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
  const nextBlock = getNextBlock(journeyDef, currentBlockDef);
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

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = { createBlockExecutor, getHandler, getNextBlock, resolveTransition, applyContextUpdate };
