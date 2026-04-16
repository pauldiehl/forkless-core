/**
 * SQLite database adapter for Forkless Core.
 *
 * Wraps better-sqlite3 with CRUD operations for all 6 tables.
 * JSON columns are automatically serialized/deserialized.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function createAdapter(dbPath = ':memory:') {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  function generateId(prefix) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  // ── Users ──

  const users = {
    create({ id, email, name, phone } = {}) {
      const uid = id || generateId('user');
      db.prepare(
        'INSERT INTO users (id, email, name, phone) VALUES (?, ?, ?, ?)'
      ).run(uid, email, name || null, phone || null);
      return this.get(uid);
    },

    get(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
    },

    getByEmail(email) {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
    },

    update(id, fields) {
      const allowed = ['email', 'name', 'phone'];
      const sets = [];
      const vals = [];
      for (const key of allowed) {
        if (fields[key] !== undefined) {
          sets.push(`${key} = ?`);
          vals.push(fields[key]);
        }
      }
      if (sets.length === 0) return this.get(id);
      vals.push(id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return this.get(id);
    },

    list({ limit = 100, offset = 0 } = {}) {
      return db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    }
  };

  // ── Journey Instances ──

  const journeyInstances = {
    create({ id, user_id, journey_type, context = {}, status = 'not_started', campaign_id } = {}) {
      const jid = id || generateId('ji');
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO journey_instances (id, user_id, journey_type, context, status, campaign_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(jid, user_id, journey_type, JSON.stringify(context), status, campaign_id || null, now, now);
      return this.get(jid);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM journey_instances WHERE id = ?').get(id);
      if (!row) return null;
      row.context = JSON.parse(row.context);
      return row;
    },

    put(id, data) {
      const now = new Date().toISOString();
      // journey_type is optional — only update it when explicitly provided
      // (e.g. during snapshot restore where the type may differ from the row's type).
      if (data.journey_type !== undefined) {
        db.prepare(
          'UPDATE journey_instances SET context = ?, status = ?, journey_type = ?, updated_at = ? WHERE id = ?'
        ).run(JSON.stringify(data.context), data.status, data.journey_type, now, id);
      } else {
        db.prepare(
          'UPDATE journey_instances SET context = ?, status = ?, updated_at = ? WHERE id = ?'
        ).run(JSON.stringify(data.context), data.status, now, id);
      }
      return this.get(id);
    },

    findByUser(user_id, { status } = {}) {
      let sql = 'SELECT * FROM journey_instances WHERE user_id = ?';
      const params = [user_id];
      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }
      sql += ' ORDER BY updated_at DESC';
      return db.prepare(sql).all(...params).map(row => {
        row.context = JSON.parse(row.context);
        return row;
      });
    },

    list({ status, limit = 100 } = {}) {
      let sql = 'SELECT * FROM journey_instances';
      const params = [];
      if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
      }
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params).map(row => {
        row.context = JSON.parse(row.context);
        return row;
      });
    }
  };

  // ── Conversations ──

  const conversations = {
    create({ id, user_id, journey_instance_id, messages = [], mode = 'agent' } = {}) {
      const cid = id || generateId('convo');
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO conversations (id, user_id, journey_instance_id, messages, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(cid, user_id, journey_instance_id || null, JSON.stringify(messages), mode, now, now);
      return this.get(cid);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
      if (!row) return null;
      row.messages = JSON.parse(row.messages);
      return row;
    },

    addMessage(id, message) {
      const convo = this.get(id);
      if (!convo) throw new Error(`Conversation ${id} not found`);
      const msg = {
        role: message.role,
        text: message.text,
        visibility: message.visibility || ['all'],
        actor: message.actor || message.role,
        block: message.block || null,
        llm_routed: message.llm_routed !== undefined ? message.llm_routed : true,
        timestamp: message.timestamp || new Date().toISOString()
      };
      convo.messages.push(msg);
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE conversations SET messages = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(convo.messages), now, id);
      return this.get(id);
    },

    updateMessages(id, messages) {
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE conversations SET messages = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(messages), now, id);
      return this.get(id);
    },

    getMessages(id, { viewer } = {}) {
      const convo = this.get(id);
      if (!convo) return null;
      if (!viewer) return convo.messages;
      return convo.messages.filter(msg =>
        !msg.visibility || msg.visibility.includes('all') || msg.visibility.includes(viewer)
      );
    },

    updateJourneyLink(id, newJourneyInstanceId) {
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE conversations SET journey_instance_id = ?, updated_at = ? WHERE id = ?'
      ).run(newJourneyInstanceId, now, id);
      return this.get(id);
    },

    findByJourney(journey_instance_id) {
      const rows = db.prepare('SELECT * FROM conversations WHERE journey_instance_id = ? ORDER BY updated_at DESC').all(journey_instance_id);
      return rows.map(row => {
        row.messages = JSON.parse(row.messages);
        return row;
      });
    },

    findByUser(user_id) {
      const rows = db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC').all(user_id);
      return rows.map(row => {
        row.messages = JSON.parse(row.messages);
        return row;
      });
    }
  };

  // ── Events Log ──

  const eventsLog = {
    put(entry) {
      db.prepare(
        'INSERT INTO events_log (journey_instance_id, type, source, payload, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run(
        entry.journey_instance_id,
        entry.type,
        entry.source || null,
        JSON.stringify(entry.payload || {}),
        entry.timestamp || new Date().toISOString()
      );
    },

    findByJourney(journey_instance_id, { type, limit = 100 } = {}) {
      let sql = 'SELECT * FROM events_log WHERE journey_instance_id = ?';
      const params = [journey_instance_id];
      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }
      sql += ' ORDER BY id DESC LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params).map(row => {
        row.payload = JSON.parse(row.payload);
        return row;
      });
    }
  };

  // ── Business Records ──

  const businessRecords = {
    create({ id, journey_instance_id, record_type, data = {} } = {}) {
      const rid = id || generateId('br');
      db.prepare(
        'INSERT INTO business_records (id, journey_instance_id, record_type, data) VALUES (?, ?, ?, ?)'
      ).run(rid, journey_instance_id, record_type, JSON.stringify(data));
      return this.get(rid);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM business_records WHERE id = ?').get(id);
      if (!row) return null;
      row.data = JSON.parse(row.data);
      return row;
    },

    findByJourney(journey_instance_id, { record_type } = {}) {
      let sql = 'SELECT * FROM business_records WHERE journey_instance_id = ?';
      const params = [journey_instance_id];
      if (record_type) {
        sql += ' AND record_type = ?';
        params.push(record_type);
      }
      sql += ' ORDER BY created_at DESC';
      return db.prepare(sql).all(...params).map(row => {
        row.data = JSON.parse(row.data);
        return row;
      });
    }
  };

  // ── Campaigns ──

  const campaigns = {
    create({ id, name, status = 'draft', config = {} } = {}) {
      const cid = id || generateId('camp');
      db.prepare(
        'INSERT INTO campaigns (id, name, status, config) VALUES (?, ?, ?, ?)'
      ).run(cid, name, status, JSON.stringify(config));
      return this.get(cid);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
      if (!row) return null;
      row.config = JSON.parse(row.config);
      return row;
    },

    update(id, fields) {
      const allowed = ['name', 'status', 'started_at', 'ended_at'];
      const sets = [];
      const vals = [];
      for (const key of allowed) {
        if (fields[key] !== undefined) {
          sets.push(`${key} = ?`);
          vals.push(fields[key]);
        }
      }
      if (fields.config !== undefined) {
        sets.push('config = ?');
        vals.push(JSON.stringify(fields.config));
      }
      if (sets.length === 0) return this.get(id);
      vals.push(id);
      db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return this.get(id);
    },

    list({ status } = {}) {
      let sql = 'SELECT * FROM campaigns';
      const params = [];
      if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
      }
      return db.prepare(sql).all(...params).map(row => {
        row.config = JSON.parse(row.config);
        return row;
      });
    }
  };

  // ── Products ──

  const products = {
    create({ id, slug, name, product_type, category = null, description = null, metadata = {}, active = 1 } = {}) {
      const pid = id || generateId('prod');
      db.prepare(
        'INSERT INTO products (id, slug, name, product_type, category, description, metadata, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(pid, slug, name, product_type, category, description, JSON.stringify(metadata), active);
      return this.get(pid);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!row) return null;
      row.metadata = JSON.parse(row.metadata);
      return row;
    },

    getBySlug(slug) {
      const row = db.prepare('SELECT * FROM products WHERE slug = ?').get(slug);
      if (!row) return null;
      row.metadata = JSON.parse(row.metadata);
      return row;
    },

    list({ product_type, category, active } = {}) {
      let sql = 'SELECT * FROM products WHERE 1=1';
      const params = [];
      if (product_type) { sql += ' AND product_type = ?'; params.push(product_type); }
      if (category) { sql += ' AND category = ?'; params.push(category); }
      if (active !== undefined) { sql += ' AND active = ?'; params.push(active ? 1 : 0); }
      sql += ' ORDER BY name';
      return db.prepare(sql).all(...params).map(row => {
        row.metadata = JSON.parse(row.metadata);
        return row;
      });
    },

    update(id, fields) {
      const allowed = ['slug', 'name', 'product_type', 'category', 'description', 'active'];
      const sets = [];
      const vals = [];
      for (const key of allowed) {
        if (fields[key] !== undefined) {
          sets.push(`${key} = ?`);
          vals.push(fields[key]);
        }
      }
      if (fields.metadata !== undefined) {
        sets.push('metadata = ?');
        vals.push(JSON.stringify(fields.metadata));
      }
      if (sets.length === 0) return this.get(id);
      vals.push(id);
      db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return this.get(id);
    }
  };

  // ── Product Prices ──

  const productPrices = {
    /**
     * Add a new price row. If this is the "current" price, leave effective_to
     * as NULL. To replace a price, call closePrice() on the old one first.
     */
    create({ id, product_id, price_cents, cost_cents = null, effective_from, effective_to = null } = {}) {
      const pid = id || generateId('pp');
      const from = effective_from || new Date().toISOString();
      db.prepare(
        'INSERT INTO product_prices (id, product_id, price_cents, cost_cents, effective_from, effective_to) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(pid, product_id, price_cents, cost_cents, from, effective_to);
      return this.get(pid);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM product_prices WHERE id = ?').get(id);
      return row || null;
    },

    /**
     * Get the current price for a product (effective_to IS NULL, or
     * effective_to is in the future). Returns the most recently-effective row.
     */
    getCurrentPrice(product_id, asOf) {
      const now = asOf || new Date().toISOString();
      const row = db.prepare(`
        SELECT * FROM product_prices
        WHERE product_id = ?
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to > ?)
        ORDER BY effective_from DESC
        LIMIT 1
      `).get(product_id, now, now);
      return row || null;
    },

    /**
     * Get full price history for a product (newest first).
     */
    getHistory(product_id) {
      return db.prepare(
        'SELECT * FROM product_prices WHERE product_id = ? ORDER BY effective_from DESC'
      ).all(product_id);
    },

    /**
     * Close an existing price by setting effective_to.
     * Typically called just before creating a replacement price row.
     */
    closePrice(priceId, endDate) {
      const end = endDate || new Date().toISOString();
      db.prepare('UPDATE product_prices SET effective_to = ? WHERE id = ?').run(end, priceId);
      return this.get(priceId);
    }
  };

  function close() {
    db.close();
  }

  return {
    db,
    users,
    journeyInstances,
    conversations,
    eventsLog,
    businessRecords,
    campaigns,
    products,
    productPrices,
    close
  };
}

module.exports = { createAdapter };
