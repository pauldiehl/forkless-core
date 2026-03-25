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

// Built-in block contracts
const blocks = {
  presentation: require('./blocks/presentation'),
  simple_intake: require('./blocks/simple_intake'),
  recommendation: require('./blocks/recommendation'),
  payment: require('./blocks/payment'),
  followup: require('./blocks/followup')
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
    blockRegistry
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
   */
  function registerJourney(definition) {
    const validated = loadJourney(definition, blockRegistry);
    journeyDefinitions[validated.journey_type] = validated;
    return validated;
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
  blocks
};
