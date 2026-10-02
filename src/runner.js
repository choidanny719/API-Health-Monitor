import { HttpError } from './errors.js';

export class Runner {
  constructor(store, checker, { concurrency = 4, now = Date.now, onError = console.error } = {}) {
    this.store = store;
    this.checker = checker;
    this.concurrency = concurrency;
    this.now = now;
    this.onError = onError;
    this.active = new Map();
    this.controller = new AbortController();
    this.closed = false;
    this.timer = null;
  }

  async run(id) {
    if (this.closed) throw new HttpError(503, 'Checker is stopping');
    const monitor = this.store.get(id);
    if (this.active.has(id)) throw new HttpError(409, 'A check is already running for this monitor');
    if (this.active.size >= this.concurrency) throw new HttpError(429, 'All checker slots are busy; try again shortly');
    const task = this.perform(monitor);
    this.active.set(id, task);
    try {
      const result = await task;
      if (!result) throw new HttpError(409, 'Check cancelled or monitor changed while it was running');
      return result;
    } finally {
      this.active.delete(id);
    }
  }

  async perform(monitor) {
    try {
      const result = await this.checker(monitor, this.controller.signal);
      if (this.closed) return null;
      return this.store.record(monitor, result, this.now());
    } catch (error) {
      this.store.defer(monitor, this.now());
      throw error;
    }
  }

  async tick() {
    if (this.closed || this.active.size >= this.concurrency) return;
    const tasks = [];
    for (const { id } of this.store.due(this.now())) {
      if (this.active.size >= this.concurrency) break;
      if (!this.active.has(id)) {
        tasks.push(this.run(id).catch(error => {
          if (!this.closed && error.status !== 409) this.onError(error);
        }));
      }
    }
    await Promise.all(tasks);
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick().catch(this.onError), 1000);
    this.tick().catch(this.onError);
  }

  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    this.controller.abort(new Error('Server is stopping'));
    await Promise.allSettled([...this.active.values()]);
  }
}
