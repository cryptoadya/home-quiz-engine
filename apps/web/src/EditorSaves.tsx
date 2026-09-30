import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

type Edit = { persist: () => Promise<unknown>; blocked?: string; owner?: string; discarded?: boolean };
type SaveState = { status: string; error: string };
const ownedBy = (edit: Edit, owner: string) => edit.owner === owner || edit.owner?.startsWith(`${owner}/`);

class SaveQueue {
  private pending = new Map<string, Edit>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operations = new Set<Promise<void>>();
  private operationFailures = new Map<string, Error>();
  private running: Promise<void> | undefined;
  private activeEdit: Edit | undefined;
  private drainFailureEdit: Edit | undefined;
  private excludedOwner: string | undefined;
  private exclusionDone: Promise<void> | undefined;
  private endExclusion: (() => void) | undefined;
  private listeners = new Set<() => void>();
  private state: SaveState = { status: 'Saved', error: '' };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  get unsaved() { return this.pending.size > 0 || Boolean(this.running) || this.operations.size > 0 || this.operationFailures.size > 0; }
  hasWorkExcept(failureKey?: string, owner?: string) {
    return [...this.pending.values()].some(edit => !owner || !ownedBy(edit, owner)) || Boolean(this.running) || this.operations.size > 0 ||
      [...this.operationFailures.keys()].some(key => key !== failureKey);
  }
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
    let discarded = false;
    for (const [key, edit] of this.pending) {
      if (!ownedBy(edit, owner)) continue;
      edit.discarded = true;
      this.pending.delete(key);
      discarded = true;
    }
    // A sent PUT cannot be undone. Keep waiting for it, but do not retry or
    // require success for work whose owner is about to be deleted.
    if (this.activeEdit && ownedBy(this.activeEdit, owner)) this.activeEdit.discarded = true;
    if (!this.pending.size) {
      clearTimeout(this.timer);
      if (discarded) this.publish(this.unsaved ? 'Saving...' : 'Saved');
    }
  };
  // Immediate mutations commit their UI only on success. Track them without
  // replaying failed POST/DELETE requests as if they were pending draft edits.
  // A failure key keeps the barrier blocked until that explicit operation succeeds.
  perform = (action: () => Promise<void>, failureKey?: string, alreadyFlushed = false): Promise<void> => {
    const operation = (alreadyFlushed ? Promise.resolve() : this.drain()).then(action);
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
  flush = (retryFailureKey?: string): Promise<void> => this.flushWork(retryFailureKey);
  flushExcept = async (owner: string, retryFailureKey?: string): Promise<() => void> => {
    if (this.excludedOwner === owner) {
      await this.flushWork(retryFailureKey, owner);
      return () => {};
    }
    if (this.exclusionDone) await this.exclusionDone;
    this.excludedOwner = owner;
    this.exclusionDone = new Promise(resolve => { this.endExclusion = resolve; });
    const release = () => {
      this.excludedOwner = undefined;
      this.endExclusion?.();
      this.endExclusion = undefined;
      this.exclusionDone = undefined;
    };
    try { await this.flushWork(retryFailureKey, owner); return release; }
    catch (cause) { release(); throw cause; }
  };
  private flushWork = async (retryFailureKey?: string, owner?: string): Promise<void> => {
    if (!owner && this.exclusionDone) await this.exclusionDone;
    const results = await Promise.allSettled([this.drain(), ...this.operations]);
    const failed = results.find((result, index) => result.status === 'rejected' &&
      !(index === 0 && owner && this.drainFailureEdit && ownedBy(this.drainFailureEdit, owner)));
    if (failed?.status === 'rejected') throw failed.reason;
    const failure = [...this.operationFailures].find(([key]) => key !== retryFailureKey)?.[1];
    if (failure) throw failure;
    if (!owner && this.exclusionDone) await this.exclusionDone;
    if (this.hasWorkExcept(retryFailureKey, owner)) await this.flushWork(retryFailureKey, owner);
  };
  private drain = (): Promise<void> => {
    clearTimeout(this.timer);
    // Share an in-flight drain: never retry a failed request inside the same barrier.
    if (this.running) return this.running;
    if (!this.pending.size) return Promise.resolve();
    this.publish('Saving...');
    this.running = Promise.resolve().then(async () => {
      this.drainFailureEdit = undefined;
      while (this.pending.size) {
        const next = [...this.pending].find(([, edit]) => !this.excludedOwner || !ownedBy(edit, this.excludedOwner));
        if (!next) break;
        const [key, edit] = next;
        if (edit.blocked) { this.drainFailureEdit = edit; throw new Error(edit.blocked); }
        this.activeEdit = edit;
        let succeeded = false;
        try { await edit.persist(); succeeded = true; }
        catch (cause) {
          if (!edit.discarded && !(this.excludedOwner && ownedBy(edit, this.excludedOwner))) {
            this.drainFailureEdit = edit;
            throw cause;
          }
        }
        finally { this.activeEdit = undefined; }
        // Object identity is the edit version, including repeated equal values.
        if ((succeeded || edit.discarded) && this.pending.get(key) === edit) this.pending.delete(key);
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
  flushExcept = async (owner: string, retryFailureKey?: string) => {
    const releases: Array<() => void> = [];
    try {
      do {
        const results = await Promise.allSettled([...this.queues].map(queue => queue.flushExcept(owner, retryFailureKey)));
        for (const result of results) if (result.status === 'fulfilled') releases.push(result.value);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } while ([...this.queues].some(queue => queue.hasWorkExcept(retryFailureKey, owner)));
      return () => releases.forEach(release => release());
    } catch (cause) { releases.forEach(release => release()); throw cause; }
  };
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
  flush = async (retryFailureKey?: string) => {
    do {
      const results = await Promise.allSettled([...this.queues].map(queue => queue.flush(retryFailureKey)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      // Recheck all queues, including edits made while another queue was saving.
    } while ([...this.queues].some(queue => queue.hasWorkExcept(retryFailureKey)));
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
    discard: queue.discard, flush: queue.flush, flushExcept: queue.flushExcept, perform: queue.perform };
}
