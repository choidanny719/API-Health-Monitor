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
    this.db.prepare(`
      UPDATE monitors SET config = ?, enabled = ?, revision = revision + 1,
      status = 'pending', failure_count = 0, last_checked_at = NULL, next_check_at = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(config), Number(config.enabled), now, now, id);
    return this.get(id);
  }

  delete(id) {
    this.get(id);
    this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
  }

  close() {
    this.db.close();
  }
}
