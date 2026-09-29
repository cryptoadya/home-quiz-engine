import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

type Edit = { persist: () => Promise<unknown>; blocked?: string };
type SaveState = { status: string; error: string };

class SaveQueue {
  private pending = new Map<string, Edit>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operations = new Set<Promise<void>>();
  private running: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  private state: SaveState = { status: 'Saved', error: '' };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  get unsaved() { return this.pending.size > 0 || Boolean(this.running) || this.operations.size > 0; }
  private publish(status: string, error = '') {
    this.state = { status, error };
    this.listeners.forEach(listener => listener());
  }
  schedule(key: string, persist: Edit['persist'], blocked?: string) {
    this.pending.set(key, { persist, blocked });
    clearTimeout(this.timer);
    this.publish(blocked || 'Saving...');
    if (!blocked) this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 400);
  }
  // Immediate mutations commit their UI only on success. Track them without
  // replaying failed POST/DELETE requests as if they were pending draft edits.
  perform = (action: () => Promise<void>): Promise<void> => {
    const operation = this.drain().then(action);
    this.operations.add(operation);
    this.publish('Saving...');
    return operation.then(() => {
      this.operations.delete(operation);
      if (!this.unsaved) this.publish('Saved');
    }, cause => {
      this.operations.delete(operation);
      this.publish('Save failed', (cause as Error).message);
      throw cause;
    });
  };
  flush = async (): Promise<void> => {
    const results = await Promise.allSettled([this.drain(), ...this.operations]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (this.unsaved) await this.flush();
  };
  private drain = (): Promise<void> => {
    clearTimeout(this.timer);
    // Share an in-flight drain: never retry a failed request inside the same barrier.
    if (this.running) return this.running;
    if (!this.pending.size) return Promise.resolve();
    this.publish('Saving...');
    this.running = Promise.resolve().then(async () => {
      while (this.pending.size) {
        const [key, edit] = this.pending.entries().next().value!;
        if (edit.blocked) throw new Error(edit.blocked);
        await edit.persist();
        // Object identity is the edit version, including repeated equal values.
        if (this.pending.get(key) === edit) this.pending.delete(key);
      }
    }).then(() => {
      this.running = undefined;
      this.publish(this.unsaved ? 'Saving...' : 'Saved');
    }, cause => {
      this.running = undefined;
      clearTimeout(this.timer);
      this.publish('Save failed', (cause as Error).message);
      throw cause;
    });
    return this.running;
  };
}

class SaveBarrier {
  private queues = new Set<SaveQueue>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify = () => { this.listeners.forEach(listener => listener()); };
  register(queue: SaveQueue) {
    this.queues.add(queue);
    const unsubscribe = queue.subscribe(this.notify);
    this.notify();
    return () => {
      // A disappearing child must not take unsaved work out of the barrier.
      if (!queue.unsaved) { unsubscribe(); this.queues.delete(queue); this.notify(); }
    };
  }
  snapshot = () => {
    const queues = [...this.queues];
    if (queues.some(queue => queue.snapshot().status === 'Save failed')) return 'Save failed';
    return queues.some(queue => queue.unsaved) ? 'Saving...' : 'Saved';
  };
  flush = async () => {
    do {
      const results = await Promise.allSettled([...this.queues].map(queue => queue.flush()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      // Recheck all queues, including edits made while another queue was saving.
    } while ([...this.queues].some(queue => queue.unsaved));
  };
}

const SavesContext = createContext<SaveBarrier | null>(null);
export function EditorSaves({ children }: { children: ReactNode }) {
  const [barrier] = useState(() => new SaveBarrier());
  return <SavesContext.Provider value={barrier}>{children}</SavesContext.Provider>;
}
export function useSaveBarrier() { return useContext(SavesContext); }
export function useEditorSave() {
  const barrier = useSaveBarrier();
  const [queue] = useState(() => new SaveQueue());
  const state = useSyncExternalStore(queue.subscribe, queue.snapshot);
  useEffect(() => barrier?.register(queue), [barrier, queue]);
  useEffect(() => () => { if (queue.snapshot().status !== 'Save failed') void queue.flush().catch(() => {}); }, [queue]);
  return { ...state, schedule: queue.schedule.bind(queue), flush: queue.flush, perform: queue.perform };
}
