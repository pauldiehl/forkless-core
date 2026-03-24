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

/**
 * Boot a Forkless Core instance with all modules wired together.
 *
 * @param {Object} opts
 * @param {string} [opts.dbPath=':memory:'] - Path to SQLite database file
 * @param {Object} [opts.llm] - LLM adapter { parseIntent, generateResponse }
 * @param {Object} [opts.logger] - Logger { log, info, error }
 * @param {number} [opts.tickIntervalMs] - Scheduler tick interval
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

  const actionDispatcher = createActionDispatcher({
    conversationStore: db.conversations,
    capabilityRegistry,
    scheduler,
    logger,
    llm: opts.llm || null
  });

  return {
    db,
    context,
    capabilityRegistry,
    scheduler,
    actionDispatcher,
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
  createActionDispatcher
};
