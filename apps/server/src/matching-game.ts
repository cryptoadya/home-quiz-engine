import { answerOrder } from './answer-order.js';
import { createHash } from 'node:crypto';
import type { MatchingSide } from './matching.js';

export type Mapping = { leftId: string; rightId: string }[];
type Content = { id: string; pairs?: { id: string; left: MatchingSide; right: MatchingSide }[] };
// Domain-separated opaque IDs retain snapshot identity without exposing the shared
// pair ID. Ordering never changes the ID-based correct mapping.
export function matchingContent(roomId: string, question: Content, shuffleAnswers = false) {
  const id = (pairId: string, side: string) => createHash('sha256').update(JSON.stringify([roomId, question.id, pairId, side])).digest('hex');
  const pairs = question.pairs ?? [];
  const items = (side: 'left' | 'right') => answerOrder(pairs.map(pair => {
    const content = pair[side];
    return { id: id(pair.id, side), ...content,
      ...(content.kind === 'image' ? { mediaUrl: `/api/rooms/${roomId}/media/${content.mediaId}/content` } : {}) };
  }), shuffleAnswers, roomId, question.id, side);
  return { leftItems: items('left'), rightItems: items('right'), correctMapping: pairs.map(pair => ({ leftId: id(pair.id, 'left'), rightId: id(pair.id, 'right') })) };
}
export function validMapping(value: unknown, content: ReturnType<typeof matchingContent>): value is Mapping {
  if (!Array.isArray(value) || value.length !== content.leftItems.length) return false;
  return value.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
    && Object.keys(entry).length === 2 && typeof entry.leftId === 'string' && typeof entry.rightId === 'string'
    && content.leftItems.some(item => item.id === entry.leftId) && content.rightItems.some(item => item.id === entry.rightId))
    && new Set(value.map(entry => entry.leftId)).size === value.length
    && new Set(value.map(entry => entry.rightId)).size === value.length;
}
