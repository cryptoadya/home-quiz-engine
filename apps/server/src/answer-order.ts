import { createHash } from 'node:crypto';

// A deterministic permutation of frozen IDs, shared by every audience and Player.
// Domain separation gives Matching's two sides independent permutations.
export function answerOrder<T extends { id: string }>(items: T[], enabled: boolean, roomId: string, questionId: string, side = 'options'): T[] {
  if (!enabled) return items;
  const key = (id: string) => createHash('sha256').update(JSON.stringify(['answer-order-v1', roomId, questionId, side, id])).digest('hex');
  return items.map(item => ({ item, key: key(item.id) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.item.id.localeCompare(b.item.id)).map(entry => entry.item);
}
