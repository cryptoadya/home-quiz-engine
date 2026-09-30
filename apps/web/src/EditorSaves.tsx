import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

type Edit = { persist: () => Promise<unknown>; blocked?: string; owner?: string; discarded?: boolean };
type SaveState = { status: string; error: string };

class SaveQueue {
  private pending = new Map<string, Edit>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operations = new Set<Promise<void>>();
  private operationFailures = new Map<string, Error>();
  private running: Promise<void> | undefined;
  private activeEdit: Edit | undefined;
  private listeners = new Set<() => void>();
  private state: SaveState = { status: 'Saved', error: '' };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  get unsaved() { return this.pending.size > 0 || Boolean(this.running) || this.operations.size > 0 || this.operationFailures.size > 0; }
  private publish(status: string, error = '') {
    const failure = this.operationFailures.values().next().value;
    this.state = failure ? { status: 'Save failed', error: failure.message } : { status, error };
    this.listeners.forEach(listener => listener());
  }
  schedule(key: string, persist: Edit['persist'], blocked?: string, owner?: string) {
    this.pending.set(key, { persist, blocked, owner });
    clearTimeout(this.timer);
    this.publish(blocked || 'Saving...');
    if (!blocked) this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 400);
  }
  discard = (owner: string) => {
    const belongsToOwner = (edit: Edit) => edit.owner === owner || edit.owner?.startsWith(`${owner}/`);
    let discarded = false;
    for (const [key, edit] of this.pending) {
      if (!belongsToOwner(edit)) continue;
      edit.discarded = true;
      this.pending.delete(key);
      discarded = true;
    }
    // A sent PUT cannot be undone. Keep waiting for it, but do not retry or
    // require success for work whose owner is about to be deleted.
    if (this.activeEdit && belongsToOwner(this.activeEdit)) this.activeEdit.discarded = true;
    if (!this.pending.size) {
      clearTimeout(this.timer);
      if (discarded) this.publish(this.unsaved ? 'Saving...' : 'Saved');
    }
  };
  // Immediate mutations commit their UI only on success. Track them without
  // replaying failed POST/DELETE requests as if they were pending draft edits.
  // A failure key keeps the barrier blocked until that explicit operation succeeds.
  perform = (action: () => Promise<void>, failureKey?: string): Promise<void> => {
    const operation = this.drain().then(action);
    this.operations.add(operation);
    this.publish('Saving...');
    return operation.then(() => {
      this.operations.delete(operation);
      if (failureKey) this.operationFailures.delete(failureKey);
      this.publish(this.unsaved ? 'Saving...' : 'Saved');
    }, cause => {
      this.operations.delete(operation);
      if (failureKey) this.operationFailures.set(failureKey, cause as Error);
      this.publish('Save failed', (cause as Error).message);
      throw cause;
    });
  };
  flush = async (): Promise<void> => {
    const results = await Promise.allSettled([this.drain(), ...this.operations]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const failure = this.operationFailures.values().next().value;
    if (failure) throw failure;
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
        this.activeEdit = edit;
        try { await edit.persist(); }
        catch (cause) { if (!edit.discarded) throw cause; }
        finally { this.activeEdit = undefined; }
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
  discard = (owner: string) => { this.queues.forEach(queue => queue.discard(owner)); };
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
export function useEditorSave(owner?: string) {
  const barrier = useSaveBarrier();
  const [queue] = useState(() => new SaveQueue());
  const state = useSyncExternalStore(queue.subscribe, queue.snapshot);
  useEffect(() => barrier?.register(queue), [barrier, queue]);
  useEffect(() => () => { if (queue.snapshot().status !== 'Save failed') void queue.flush().catch(() => {}); }, [queue]);
  return { ...state, schedule: (key: string, persist: Edit['persist'], blocked?: string, editOwner = owner) => queue.schedule(key, persist, blocked, editOwner),
    discard: queue.discard, flush: queue.flush, perform: queue.perform };
}
