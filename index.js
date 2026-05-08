/**
 * @forkless/core — Config-driven journey state machine with conversational interface.
 *
 * Factory exports. Each module is created via a factory function
 * that receives its dependencies (no singletons, no globals).
 */

const { createAdapter } = require('./db/adapter');
const { createContextManager } = require('./core/context');
const { createScheduler } = require('./core/scheduler');
const { createCapabilityRegistry } = require('./runtime/capability-registry');
const { createActionDispatcher } = require('./runtime/action-dispatcher');
const { createBlockExecutor } = require('./runtime/block-executor');
const { createEventRouter } = require('./runtime/event-router');
const { createMockLLM } = require('./core/mock-llm');
const { buildBlockRegistry, loadJourney, loadJourneysFromDir, validate } = require('./core/journey-loader');
const { validateJourneyContracts, checkReadsContract, checkWritesContract, checkTransitionContract, generateScenarios } = require('./core/journey-contracts');

// Built-in block contracts
const blocks = {
  presentation: require('./blocks/presentation'),
  simple_intake: require('./blocks/simple_intake'),
  recommendation: require('./blocks/recommendation'),
  payment: require('./blocks/payment'),
  lab_processing: require('./blocks/lab_processing'),
  followup: require('./blocks/followup'),
  encounter_notes: require('./blocks/encounter_notes'),
  rx_review: require('./blocks/rx_review'),
  rx_consent: require('./blocks/rx_consent'),
  rx_payment: require('./blocks/rx_payment'),
  rx_order: require('./blocks/rx_order'),
  rx_tracking: require('./blocks/rx_tracking'),
  visit_summary: require('./blocks/visit_summary'),
  patient_delivery: require('./blocks/patient_delivery'),
  results_delivery: require('./blocks/results_delivery'),
  quick_intake: require('./blocks/quick_intake'),
  plan_assessment: require('./blocks/plan_assessment'),
  plan_generation: require('./blocks/plan_generation'),
  plan_refinement: require('./blocks/plan_refinement')
};

/**
 * Boot a Forkless Core instance with all modules wired together.
 *
 * @param {Object} opts
 * @param {string} [opts.dbPath=':memory:'] - Path to SQLite database file
 * @param {Object} [opts.llm] - LLM adapter { parseIntent, generateResponse }
 * @param {boolean} [opts.useMockLLM=false] - Use built-in mock LLM for testing
 * @param {Object} [opts.logger] - Logger { log, info, error }
 * @param {number} [opts.tickIntervalMs] - Scheduler tick interval
 * @param {Object[]} [opts.extraBlocks] - Additional block contracts to register
 * @returns {Object} Wired Forkless Core instance
 */
function createCore(opts = {}) {
  const db = createAdapter(opts.dbPath || ':memory:');
  const context = createContextManager({ db });
  const capabilityRegistry = createCapabilityRegistry();
  const scheduler = createScheduler({
    tickIntervalMs: opts.tickIntervalMs,
    onJobRun: opts.onJobRun,
    onJobError: opts.onJobError
  });
  const logger = opts.logger || console;

  // Build LLM adapter
  let llm = opts.llm || null;
  if (!llm && opts.useMockLLM) {
    llm = createMockLLM();
  }

  // Build block registry from built-in + extra blocks
  const allBlocks = Object.values(blocks);
  if (opts.extraBlocks) {
    allBlocks.push(...opts.extraBlocks);
  }
  const blockRegistry = buildBlockRegistry(allBlocks);

  const actionDispatcher = createActionDispatcher({
    conversationStore: db.conversations,
    capabilityRegistry,
    scheduler,
    logger,
    llm
  });

  const blockExecutor = createBlockExecutor({
    actionDispatcher,
    blockRegistry,
    conversationStore: db.conversations
  });

  // Journey definitions — populated via registerJourney()
  const journeyDefinitions = {};

  const eventRouter = createEventRouter({
    db,
    blockExecutor,
    journeyDefinitions
  });

  /**
   * Register a journey definition.
   * Runs contract validation automatically — warnings are logged,
   * errors throw in strict mode.
   */
  function registerJourney(definition, { strict = false } = {}) {
    const validated = loadJourney(definition, blockRegistry);

    // ── Contract validation at registration time ──
    const contractResult = validateJourneyContracts(validated, blockRegistry);
    if (contractResult.warnings.length > 0) {
      for (const w of contractResult.warnings) {
        logger.warn(`[Contract] ${validated.journey_type}: ${w}`);
      }
    }
    if (contractResult.errors.length > 0) {
      for (const e of contractResult.errors) {
        logger.error(`[Contract] ${validated.journey_type}: ${e}`);
      }
      if (strict) {
        throw new Error(
          `Journey "${validated.journey_type}" has contract errors:\n` +
          contractResult.errors.map(e => `  - ${e}`).join('\n')
        );
      }
    }

    journeyDefinitions[validated.journey_type] = validated;
    return validated;
  }

  /**
   * Switch a journey instance to a different journey type.
   *
   * Copies over context namespaces that exist in the target journey's blocks
   * (e.g., simple_intake data carries over if both journeys have that block).
   * Positions the new journey at the first block the user hasn't completed yet.
   *
   * @param {string} journeyInstanceId - Current journey instance ID
   * @param {string} targetJourneyType - Target journey type to switch to
   * @param {Object} [opts] - Options
   * @param {string} [opts.reason] - Reason for the switch (logged)
   * @param {string} [opts.startAtBlock] - Override: start at this block instead of auto-detecting
   * @param {Object} [opts.extraContext] - Additional context to merge into the new journey
   * @returns {{ oldJourney, newJourney, conversation, carryOver }}
   */
  function switchJourney(journeyInstanceId, targetJourneyType, opts = {}) {
    const oldJi = db.journeyInstances.get(journeyInstanceId);
    if (!oldJi) throw new Error(`Journey instance not found: ${journeyInstanceId}`);

    const targetDef = journeyDefinitions[targetJourneyType];
    if (!targetDef) throw new Error(`Unknown journey type: ${targetJourneyType}`);

    const oldCtx = oldJi.context || {};

    // Determine which context namespaces to carry over.
    // Carry over any namespace that matches a block name in the target journey,
    // plus always carry over: simple_intake, _global metadata.
    // NOTE: artifacts are NOT carried — they contain journey-specific URLs and must be regenerated.
    const targetBlockNames = new Set(targetDef.blocks.map(b => b.block));
    const alwaysCarry = ['simple_intake', 'user_id', 'conversation_id'];
    const carryOver = {};

    for (const key of Object.keys(oldCtx)) {
      if (targetBlockNames.has(key) || alwaysCarry.includes(key)) {
        carryOver[key] = JSON.parse(JSON.stringify(oldCtx[key]));
      }
    }

    // Merge any extra context
    if (opts.extraContext) {
      Object.assign(carryOver, opts.extraContext);
    }

    // Determine starting block: find the first block in target journey
    // whose namespace is NOT already complete in carryOver.
    let startBlock = opts.startAtBlock || targetDef.blocks[0].block;
    if (!opts.startAtBlock) {
      for (const blockDef of targetDef.blocks) {
        const contract = blockRegistry[blockDef.block];
        if (contract?.checkCompletion && contract.checkCompletion(blockDef, carryOver)) {
          continue; // This block is already satisfied by carried-over data
        }
        startBlock = blockDef.block;
        break;
      }
    }

    // Create new journey context (base structure) and then merge carried-over namespaces.
    // Note: context.create() only destructures specific named params, so we must merge
    // carryOver namespaces (simple_intake, recommendation, presentation, etc.) AFTER creation.
    const newCtx = context.create({
      journey_type: targetJourneyType,
      user_id: oldCtx.user_id,
      initialBlock: startBlock
    });
    // Merge all carried-over namespaces into the new context
    Object.assign(newCtx, carryOver);
    newCtx.journey_status = 'in_progress';
    newCtx.current_block = startBlock;

    // Pre-populate the starting block's params into its namespace so that writes
    // declared by the block (e.g. presentation.offering_slug) are satisfied on
    // entry — mirrors what fireOnEnter does for blocks reached via transition.
    const startBlockDef = targetDef.blocks.find(b => b.block === startBlock);
    if (startBlockDef && startBlockDef.params) {
      if (!newCtx[startBlock]) newCtx[startBlock] = {};
      for (const [k, v] of Object.entries(startBlockDef.params)) {
        if (newCtx[startBlock][k] === undefined) {
          newCtx[startBlock][k] = v;
        }
      }
      if (startBlockDef.params.amount_cents && !newCtx[startBlock].price_display) {
        newCtx[startBlock].price_display = `$${(startBlockDef.params.amount_cents / 100).toFixed(2)}`;
      }
    }
    newCtx._switched_from = {
      journey_type: oldJi.journey_type,
      journey_id: oldJi.id,
      reason: opts.reason || 'user_requested',
      switched_at: new Date().toISOString()
    };

    // Create new journey instance
    const newJi = db.journeyInstances.create({
      user_id: oldCtx.user_id,
      journey_type: targetJourneyType,
      context: newCtx,
      status: 'in_progress'
    });

    // Update conversation to point to new journey (MUST persist to DB, not just in-memory)
    const convos = db.conversations.findByJourney(oldJi.id);
    let conversation = null;
    if (convos.length > 0) {
      conversation = db.conversations.updateJourneyLink(convos[0].id, newJi.id);
      // Update the conversation_id in new journey context
      context.update(newJi.id, { conversation_id: conversation.id });
    }

    // Mark old journey as switched (persisted via put — in-memory mutations don't write to SQLite)
    const oldCtxUpdated = JSON.parse(JSON.stringify(oldJi.context));
    oldCtxUpdated.journey_status = 'switched';
    oldCtxUpdated._switched_to = {
      journey_type: targetJourneyType,
      journey_id: newJi.id,
      switched_at: newCtx._switched_from.switched_at
    };
    db.journeyInstances.put(oldJi.id, {
      context: oldCtxUpdated,
      status: 'switched'
    });

    logger.info(`[Journey Switch] ${oldJi.journey_type} (${oldJi.id}) → ${targetJourneyType} (${newJi.id}) at block "${startBlock}" — reason: ${opts.reason || 'user_requested'}`);

    return {
      oldJourney: oldJi,
      newJourney: newJi,
      conversation,
      carryOver: Object.keys(carryOver),
      startBlock
    };
  }

  return {
    db,
    context,
    capabilityRegistry,
    scheduler,
    actionDispatcher,
    blockExecutor,
    eventRouter,
    blockRegistry,
    journeyDefinitions,
    registerJourney,
    switchJourney,
    close() {
      scheduler.stop();
      db.close();
    }
  };
}

module.exports = {
  createCore,
  createAdapter,
  createContextManager,
  createScheduler,
  createCapabilityRegistry,
  createActionDispatcher,
  createBlockExecutor,
  createEventRouter,
  createMockLLM,
  buildBlockRegistry,
  loadJourney,
  loadJourneysFromDir,
  validate,
  validateJourneyContracts,
  checkReadsContract,
  checkWritesContract,
  checkTransitionContract,
  generateScenarios,
  blocks
};
