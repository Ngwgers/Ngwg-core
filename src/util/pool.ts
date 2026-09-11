// Bounded-concurrency async task pool. The pipeline uses this to fan out
// file parsing and page deployment across concurrent tasks (Bun event loop).

export class PoolAborted extends Error {
  constructor() {
    super("pool aborted");
  }
}

export class Pool {
  private abort = false;

  constructor(public concurrency = 8) {}

  abort() {
    this.abort = true;
  }

  /**
   * Run `worker(item, index)` over every item with at most `concurrency`
   * tasks in flight. Results are returned in input order. Rejects with
   * PoolAborted as soon as abort() is called (used by live-reload to stop
   * in-flight work immediately).
   */
  async run<T, R>(items: T[], worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(this.concurrency, items.length)) }, async () => {
      while (true) {
        if (this.abort) throw new PoolAborted();
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    });
    await Promise.all(runners);
    return results;
  }
}
