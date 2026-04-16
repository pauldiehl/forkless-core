/**
 * Event Router — the front door.
 *
 * Receives any event, determines which journey instance it targets,
 * loads context, hands off to the block executor, saves updated context,
 * and logs the event.
 *
 * Supports actor matching: conversation events from the wrong actor
 * are rejected (or handled as DMs if event.dm === true).
 *
 * This module has ZERO knowledge of specific journeys or blocks.
 * It's pure routing.
 */

function createEventRouter({ db, blockExecutor, journeyDefinitions }) {

  /**
   * Handle an incoming event.
   *
   * @param {Object} event
   * @param {string} [event.journey_id] - Direct journey instance ID
   * @param {string} [event.conversation_id] - Conversation ID (conversation events)
   * @param {string} event.type - Event type: conversation, api, scheduled, system
   * @param {string} [event.source] - Event source identifier
   * @param {string} [event.actor] - Actor sending this event (customer, physician, admin)
   * @param {boolean} [event.dm] - If true, this is a direct message (stores without block execution)
   * @param {string} [event.dm_to] - DM recipient actor
   * @param {Object} event.payload - Event data
   * @returns {Object} Result of block execution
   */
  async function handleEvent(event) {
    // 1. Find the journey instance this event targets
    let journeyInstance;

    if (event.journey_id) {
      journeyInstance = db.journeyInstances.get(event.journey_id);
    } else if (event.type === 'conversation' && event.conversation_id) {
      const convo = db.conversations.get(event.conversation_id);
      if (!convo) throw new Error(`Conversation not found: ${event.conversation_id}`);
      if (!convo.journey_instance_id) throw new Error(`Conversation ${event.conversation_id} has no associated journey`);
      journeyInstance = db.journeyInstances.get(convo.journey_instance_id);
    } else {
      throw new Error('Cannot route event: no journey_id and not a conversation event with conversation_id');
    }

    if (!journeyInstance) throw new Error('Journey instance not found');

    // Don't process events for completed/abandoned journeys
    if (journeyInstance.status === 'completed' || journeyInstance.status === 'abandoned') {
      return { handled: false, reason: 'journey_not_active' };
    }

    // 2. Load the journey definition
    const journeyDef = journeyDefinitions[journeyInstance.journey_type];
    if (!journeyDef) throw new Error(`No definition for journey type: ${journeyInstance.journey_type}`);

    // 3. Find the current block definition
    const currentBlockDef = journeyDef.blocks.find(b =>
      b.block === journeyInstance.context.current_block
    );
    if (!currentBlockDef) {
      throw new Error(`Current block "${journeyInstance.context.current_block}" not found in journey definition`);
    }

    // 4. DM handling + actor matching for conversation events
    if (event.type === 'conversation') {
      // DMs are always passthrough — store without block execution
      if (event.dm === true) {
        return handleDM(event, journeyInstance, currentBlockDef);
      }

      const blockActor = currentBlockDef.actor || 'customer';
      const eventActor = event.actor || 'customer';

      if (blockActor !== 'any' && eventActor !== blockActor) {
        // Actor mismatch — but don't hard-reject. Mark as observation mode so the
        // block executor can still let the agent respond without advancing the block.
        // This lets physicians comment on customer-facing blocks (and vice versa)
        // without being silently blocked.
        event._observationMode = true;
        event._observationDetail = `Block "${currentBlockDef.block}" expects actor "${blockActor}", got "${eventActor}"`;
      }
    }

    // 5. Store incoming conversation message with visibility metadata
    if (event.type === 'conversation' && event.payload?.text) {
      const defaultVisibility = currentBlockDef.default_visibility || ['customer', 'agent'];
      // In observation mode (wrong actor), scope visibility to the observer + agent
      // so physician messages on customer blocks aren't broadcast to customer.
      // For multi-actor blocks (actor: 'any'), scope to the current actor + agent.
      let messageVisibility;
      if (event._observationMode) {
        messageVisibility = [event.actor || 'customer', 'agent'];
      } else if (currentBlockDef.actor === 'any') {
        messageVisibility = [event.actor || 'customer', 'agent'];
      } else {
        messageVisibility = defaultVisibility;
      }
      const conversationId = event.conversation_id || journeyInstance.context.conversation_id;

      // Sync context's conversation_id with the event's authoritative value.
      // This prevents stale conversation_id in context (e.g., from a previous CLI session
      // that shares a persistent DB) from causing the block executor to write to
      // a different conversation than the event router reads from.
      if (event.conversation_id && journeyInstance.context.conversation_id !== event.conversation_id) {
        journeyInstance.context.conversation_id = event.conversation_id;
      }

      if (conversationId) {
        db.conversations.addMessage(conversationId, {
          role: event.actor || 'customer',
          text: event.payload.text,
          visibility: messageVisibility,
          actor: event.actor || 'customer',
          block: currentBlockDef.block,
          llm_routed: true
        });
      }
    }

    // 6. Execute the block
    const result = await blockExecutor.execute({
      event,
      context: journeyInstance.context,
      blockDef: currentBlockDef,
      journeyDef
    });

    // 6. Save updated context
    const now = new Date().toISOString();
    db.journeyInstances.put(journeyInstance.id, {
      context: result.newContext,
      status: result.newContext.journey_status || journeyInstance.status
    });

    // 7. Log the event
    db.eventsLog.put({
      journey_instance_id: journeyInstance.id,
      type: event.type,
      source: event.source || null,
      payload: event.payload || {},
      timestamp: event.timestamp || now
    });

    return {
      handled: true,
      transitioned: result.transitioned,
      newBlock: result.newContext.current_block,
      actions: result.actions,
      error: result.error,
      warning: result.warning,
      observationMode: event._observationMode || false,
      observationDetail: event._observationDetail || null,
      journeyStatus: result.newContext.journey_status
    };
  }

  /**
   * Handle a DM — store message without invoking block executor.
   * DMs are visible only to the sender and recipient.
   */
  function handleDM(event, journeyInstance, currentBlockDef) {
    const conversationId = event.conversation_id || journeyInstance.context.conversation_id;
    const visibility = [event.actor, event.dm_to || 'agent'];

    if (conversationId) {
      db.conversations.addMessage(conversationId, {
        role: event.actor,
        text: event.payload.text,
        visibility,
        actor: event.actor,
        block: journeyInstance.context.current_block,
        llm_routed: false
      });
    }

    // Log the DM event for audit
    db.eventsLog.put({
      journey_instance_id: journeyInstance.id,
      type: 'conversation',
      source: 'dm',
      payload: { from: event.actor, to: event.dm_to, text_length: event.payload.text.length }
    });

    return {
      handled: true,
      dm: true,
      transitioned: false,
      newBlock: journeyInstance.context.current_block
    };
  }

  return { handleEvent };
}

module.exports = { createEventRouter };
