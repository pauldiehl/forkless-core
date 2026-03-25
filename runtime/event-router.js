/**
 * Event Router — the front door.
 *
 * Receives any event, determines which journey instance it targets,
 * loads context, hands off to the block executor, saves updated context,
 * and logs the event.
 *
 * This module has ZERO knowledge of specific journeys or blocks.
 * It's pure routing.
 */

function createEventRouter({ db, blockExecutor, journeyDefinitions }) {

  /**
   * Handle an incoming event.
   *
   * @param {Object} event
   * @param {string} [event.journey_id] - Direct journey instance ID (api, scheduled, system events)
   * @param {string} [event.conversation_id] - Conversation ID (conversation events)
   * @param {string} event.type - Event type: conversation, api, scheduled, system
   * @param {string} [event.source] - Event source identifier
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

    // 4. Execute the block
    const result = await blockExecutor.execute({
      event,
      context: journeyInstance.context,
      blockDef: currentBlockDef,
      journeyDef
    });

    // 5. Save updated context
    const now = new Date().toISOString();
    db.journeyInstances.put(journeyInstance.id, {
      context: result.newContext,
      status: result.newContext.journey_status || journeyInstance.status
    });

    // 6. Log the event
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
      journeyStatus: result.newContext.journey_status
    };
  }

  return { handleEvent };
}

module.exports = { createEventRouter };
