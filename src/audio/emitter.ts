/** A list of observers: subscribe returns the unsubscribe, emit calls each observer that is still subscribed, in the order they subscribed. */
export class Emitter<E> {
  private readonly observers = new Set<(event: E) => void>();

  subscribe(observer: (event: E) => void): () => void {
    // a wrapper, so that one function subscribed twice is two subscriptions
    const own = (event: E): void => observer(event);
    this.observers.add(own);
    return () => {
      this.observers.delete(own);
    };
  }

  emit(event: E): void {
    for (const observer of [...this.observers]) if (this.observers.has(observer)) observer(event);
  }
}
