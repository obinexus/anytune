/** A scheduler in virtual time, for tests: nothing runs until the test advances the clock, and then in the order of time, ties in the order of scheduling. */
import type { Scheduler } from '../../src/domain/ports.ts';

export class ManualScheduler implements Scheduler {
  private time = 0;
  private seq = 0;
  private readonly queue: { at: number; seq: number; run: () => void }[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(run: () => void, delayMs: number): () => void {
    const entry = { at: this.time + Math.max(0, delayMs), seq: this.seq++, run };
    this.queue.push(entry);
    return () => {
      const i = this.queue.indexOf(entry);
      if (i >= 0) this.queue.splice(i, 1);
    };
  }

  /** Run everything due up to now + `ms`, moving the clock to each task's time as it runs. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.queue[0];
      if (next === undefined || next.at > end) break;
      this.queue.shift();
      this.time = next.at;
      next.run();
    }
    this.time = end;
  }

  get pending(): number {
    return this.queue.length;
  }
}
