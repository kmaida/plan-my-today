/**
 * Cycles through items in shuffled order, guaranteeing no repeats
 * until the entire pool is exhausted. Uses Fisher-Yates shuffle.
 */
export class ShuffledCycler<T> {
  private readonly items: T[];
  private queue: T[] = [];
  private index = 0;
  private lastReturned?: T;

  constructor(items: T[]) {
    if (items.length === 0) {
      throw new Error("ShuffledCycler requires at least one item");
    }
    this.items = items;
  }

  /** Return the next item, reshuffling when the queue is exhausted. */
  next(): T {
    if (this.index >= this.queue.length) {
      this.queue = shuffle([...this.items]);
      this.index = 0;
      // Prevent duplicate at the seam between reshuffles
      if (this.queue[0] === this.lastReturned && this.queue.length > 1) {
        const s = 1 + Math.floor(Math.random() * (this.queue.length - 1));
        [this.queue[0], this.queue[s]] = [this.queue[s], this.queue[0]];
      }
    }
    this.lastReturned = this.queue[this.index];
    return this.queue[this.index++];
  }
}

/** Shuffle array in-place (Fisher-Yates). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
