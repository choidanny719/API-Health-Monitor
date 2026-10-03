import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from './errors.js';

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS monitors (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_checked_at INTEGER,
        next_check_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS monitors_due ON monitors(enabled, next_check_at);
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        result TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checks_monitor ON checks(monitor_id, id DESC);
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        opened_at TEXT NOT NULL,
        resolved_at TEXT,
        failure_code TEXT NOT NULL,
        message TEXT NOT NULL,
        resolution TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS incidents_open ON incidents(monitor_id) WHERE resolved_at IS NULL;
      CREATE INDEX IF NOT EXISTS incidents_history ON incidents(monitor_id, id DESC);
    `);
  }

  monitor(row) {
    if (!row) return null;
    return {
      id: row.id,
      ...JSON.parse(row.config),
      revision: row.revision,
      status: row.status,
      consecutiveFailures: row.failure_count,
      lastCheckedAt: row.last_checked_at === null ? null : new Date(row.last_checked_at).toISOString(),
      nextCheckAt: new Date(row.next_check_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  list() {
    return this.db.prepare('SELECT * FROM monitors ORDER BY created_at, id').all().map(row => this.monitor(row));
  }

  get(id) {
    const monitor = this.monitor(this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id));
    if (!monitor) throw new HttpError(404, 'Monitor not found');
    return monitor;
  }

  create(config, now = Date.now()) {
    if (this.db.prepare('SELECT COUNT(*) AS count FROM monitors').get().count >= 100) {
      throw new HttpError(409, 'The limit is 100 monitors');
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO monitors (id, config, enabled, next_check_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, JSON.stringify(config), Number(config.enabled), now, now, now);
    return this.get(id);
  }

  update(id, config, now = Date.now()) {
    this.get(id);
    this.transaction(() => {
      this.db.prepare(`
        UPDATE monitors SET config = ?, enabled = ?, revision = revision + 1,
        status = 'pending', failure_count = 0, last_checked_at = NULL, next_check_at = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(config), Number(config.enabled), now, now, id);
      this.resolveIncident(id, new Date(now).toISOString(), 'configuration_changed');
    });
    return this.get(id);
  }

  delete(id) {
    this.get(id);
    this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
  }

  record(monitor, result, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(monitor.id);
    if (!row || row.revision !== monitor.revision || result.failureCode === 'cancelled') return null;
    return this.transaction(() => {
      const entry = this.db.prepare('INSERT INTO checks (monitor_id, revision, result) VALUES (?, ?, ?)')
        .run(monitor.id, monitor.revision, JSON.stringify(result));
      this.#updateHealth(row, result, now + monitor.intervalSeconds * 1000);
      this.#pruneHistory(monitor.id);
      return { id: Number(entry.lastInsertRowid), monitorId: monitor.id, revision: monitor.revision, ...result };
    });
  }

  #updateHealth(row, result, nextCheckAt) {
    const failures = result.ok ? 0 : row.failure_count + 1;
    const status = result.ok ? 'up' : failures >= 3 ? 'down' : row.status;
    this.db.prepare(`
      UPDATE monitors SET status = ?, failure_count = ?, last_checked_at = ?, next_check_at = ? WHERE id = ?
    `).run(status, failures, Date.parse(result.checkedAt), nextCheckAt, row.id);
    if (result.ok) {
      this.resolveIncident(row.id, result.checkedAt, 'recovered');
    } else if (failures >= 3) {
      this.db.prepare(`
        INSERT OR IGNORE INTO incidents (monitor_id, opened_at, failure_code, message) VALUES (?, ?, ?, ?)
      `).run(row.id, result.checkedAt, result.failureCode, result.message);
    }
  }

  #pruneHistory(id) {
    this.db.prepare(`
      DELETE FROM checks WHERE monitor_id = ? AND id NOT IN (
        SELECT id FROM checks WHERE monitor_id = ? ORDER BY id DESC LIMIT 1000
      )
    `).run(id, id);
    this.db.prepare(`
      DELETE FROM incidents WHERE monitor_id = ? AND id NOT IN (
        SELECT id FROM incidents WHERE monitor_id = ? ORDER BY id DESC LIMIT 100
      )
    `).run(id, id);
  }

  checks(id, limit) {
    this.get(id);
    return this.db.prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY id DESC LIMIT ?').all(id, limit)
      .map(row => ({ id: row.id, monitorId: row.monitor_id, revision: row.revision, ...JSON.parse(row.result) }));
  }

  incidents(id, limit) {
    this.get(id);
    return this.db.prepare('SELECT * FROM incidents WHERE monitor_id = ? ORDER BY id DESC LIMIT ?').all(id, limit)
      .map(row => ({
        id: row.id, monitorId: row.monitor_id, openedAt: row.opened_at, resolvedAt: row.resolved_at,
        failureCode: row.failure_code, message: row.message, resolution: row.resolution
      }));
  }

  resolveIncident(id, at, resolution) {
    this.db.prepare('UPDATE incidents SET resolved_at = ?, resolution = ? WHERE monitor_id = ? AND resolved_at IS NULL')
      .run(at, resolution, id);
  }

  due(now) {
    return this.db.prepare('SELECT id FROM monitors WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at, id').all(now);
  }

  defer(monitor, now) {
    this.db.prepare('UPDATE monitors SET next_check_at = ? WHERE id = ? AND revision = ?')
      .run(now + monitor.intervalSeconds * 1000, monitor.id, monitor.revision);
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
