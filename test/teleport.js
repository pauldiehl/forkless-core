/**
 * Teleport — isolated block testing.
 *
 * Seeds a journey to a specific block, then fires an event and returns
 * the result. Enables testing any block in isolation without walking
 * through all prior blocks.
 *
 * Usage:
 *   const { teleport } = require('./test/teleport');
 *   const result = await teleport({
 *     journeyDef: labsOnlyDef,
 *     atBlock: 'lab_processing',
 *     event: { type: 'api', source: 'labcorp', payload: { labcorp_status: 'results_ready' } },
 *     contextOverrides: { 'lab_processing.lab_order_id': 'lab_123' }
 *   });
 *   console.log(result.transitioned);  // true
 *   console.log(result.newBlock);      // 'followup'
 */

const { seed } = require('./seed');
const { registerMockCapabilities } = require('./fixtures/mock-capabilities');

/**
 * Teleport to a block and fire an event.
 *
 * @param {Object} opts
 * @param {Object} opts.journeyDef - Journey definition
 * @param {string} opts.atBlock - Block to teleport to
 * @param {Object} opts.event - Event to fire
 * @param {Object} [opts.contextOverrides] - Override specific context values (dot-notation)
 * @param {Object} [opts.seedOverrides] - Override seed data per block namespace
 * @param {Object} [opts.userData] - Override user data
 * @param {Object} [opts.core] - Existing core instance
 * @param {boolean} [opts.withMockCapabilities=true] - Register mock capabilities
 * @returns {Object} { result, context, messages, core, ji, convo }
 */
async function teleport(opts) {
  const {
    journeyDef,
    atBlock,
    event,
    contextOverrides,
    seedOverrides,
    userData,
    withMockCapabilities = true
  } = opts;

  // Seed to the target block
  const seeded = seed({
    journeyDef,
    upToBlock: atBlock,
    userData,
    overrides: seedOverrides,
    core: opts.core
  });

  const { core, ji, convo, user } = seeded;

  // Register mock capabilities if requested
  if (withMockCapabilities) {
    registerMockCapabilities(core.capabilityRegistry);
  }

  // Apply any context overrides
  if (contextOverrides) {
    core.context.update(ji.id, contextOverrides);
  }

  // Snapshot before firing the event
  const beforeContext = core.context.snapshot(ji.id);

  // Fire the event
  const enrichedEvent = {
    ...event,
    journey_id: ji.id,
    timestamp: event.timestamp || new Date().toISOString()
  };

  const result = await core.eventRouter.handleEvent(enrichedEvent);

  // Collect after-state
  const afterContext = core.context.read(ji.id);
  const messages = core.db.conversations.get(convo.id).messages;
  const events = core.db.eventsLog.findByJourney(ji.id);

  return {
    result,
    context: afterContext,
    beforeContext: beforeContext.context,
    messages,
    events,
    core,
    ji,
    convo,
    user
  };
}

/**
 * Teleport and fire a sequence of events. Returns results for each.
 */
async function teleportSequence(opts) {
  const { journeyDef, atBlock, events, ...rest } = opts;

  // Seed once
  const seeded = seed({
    journeyDef,
    upToBlock: atBlock,
    userData: rest.userData,
    overrides: rest.seedOverrides
  });

  const { core, ji, convo } = seeded;

  if (rest.withMockCapabilities !== false) {
    registerMockCapabilities(core.capabilityRegistry);
  }

  if (rest.contextOverrides) {
    core.context.update(ji.id, rest.contextOverrides);
  }

  const results = [];
  for (const event of events) {
    const enrichedEvent = {
      ...event,
      journey_id: ji.id,
      timestamp: event.timestamp || new Date().toISOString()
    };

    const result = await core.eventRouter.handleEvent(enrichedEvent);
    const context = core.context.read(ji.id);
    const messages = core.db.conversations.get(convo.id).messages;

    results.push({ result, context, messages });
  }

  return { results, core, ji, convo };
}

module.exports = { teleport, teleportSequence };
