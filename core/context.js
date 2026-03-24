/**
 * Context manager for Forkless journey instances.
 *
 * Context is a single JSON document per journey instance.
 * Namespaced by block (e.g., intake.customerName, payment.order_id).
 * Supports snapshot/restore for testing and debugging.
 */

function createContextManager({ db }) {

  /**
   * Create a new context for a journey instance.
   */
  function create({ journey_type, user_id, conversation_id, campaign_id, initialBlock }) {
    const now = new Date().toISOString();
    const context = {
      journey_type,
      current_block: initialBlock || null,
      block_state: null,
      journey_status: 'not_started',
      conversation_summary: '',
      last_message_role: null,
      last_message_preview: null,
      user_id,
      conversation_id: conversation_id || null,
      campaign_id: campaign_id || null,
      started_at: now,
      updated_at: now,
      block_history: initialBlock
        ? [{ block: initialBlock, entered: now, exited: null }]
        : []
    };
    return context;
  }

  /**
   * Read the context from a journey instance.
   */
  function read(journeyInstanceId) {
    const ji = db.journeyInstances.get(journeyInstanceId);
    if (!ji) return null;
    return ji.context;
  }

  /**
   * Update specific keys in the context. Supports dot-notation for namespaced writes.
   * e.g., update(id, { 'intake.customerName': 'Jane', 'payment.status': 'pending' })
   */
  function update(journeyInstanceId, updates) {
    const ji = db.journeyInstances.get(journeyInstanceId);
    if (!ji) throw new Error(`Journey instance ${journeyInstanceId} not found`);

    const ctx = ji.context;

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
          target = target[parts[i]];
        }
        target[parts[parts.length - 1]] = value;
      }
    }

    ctx.updated_at = new Date().toISOString();
    db.journeyInstances.put(journeyInstanceId, { context: ctx, status: ctx.journey_status || ji.status });
    return ctx;
  }

  /**
   * Take a snapshot of the current context (deep clone).
   * Returns a serializable object that can be restored later.
   */
  function snapshot(journeyInstanceId) {
    const ctx = read(journeyInstanceId);
    if (!ctx) throw new Error(`Journey instance ${journeyInstanceId} not found`);
    return {
      journey_instance_id: journeyInstanceId,
      snapshot_at: new Date().toISOString(),
      context: JSON.parse(JSON.stringify(ctx))
    };
  }

  /**
   * Restore a journey instance to a previously snapshotted context.
   */
  function restore(journeyInstanceId, snapshotData) {
    const ji = db.journeyInstances.get(journeyInstanceId);
    if (!ji) throw new Error(`Journey instance ${journeyInstanceId} not found`);

    const ctx = typeof snapshotData.context === 'string'
      ? JSON.parse(snapshotData.context)
      : JSON.parse(JSON.stringify(snapshotData.context));

    ctx.updated_at = new Date().toISOString();
    db.journeyInstances.put(journeyInstanceId, { context: ctx, status: ctx.journey_status || ji.status });
    return ctx;
  }

  /**
   * Apply a context update object (used by action dispatcher).
   * Merges top-level and namespaced keys.
   */
  function applyUpdate(context, updatePayload) {
    const ctx = { ...context };
    for (const [key, value] of Object.entries(updatePayload)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof ctx[key] === 'object' && ctx[key] !== null) {
        ctx[key] = { ...ctx[key], ...value };
      } else {
        ctx[key] = value;
      }
    }
    ctx.updated_at = new Date().toISOString();
    return ctx;
  }

  return { create, read, update, snapshot, restore, applyUpdate };
}

module.exports = { createContextManager };
