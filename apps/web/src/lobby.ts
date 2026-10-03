import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export type Room = { isTest?: boolean; id: string; code: string; quizTitle: string; themeId?: string | null; state: 'LOBBY' | 'ROUND_INTRO' | 'QUESTION' | 'ANSWERING' | 'ANSWER_REVEAL' | 'ROUND_END' | 'LEADERBOARD' | 'FINAL_RESULTS' | 'WINNER_SCREEN' | 'PAUSED'; closedAt: string | null };
export type RoundIntro = { artUrl?: string; state: 'ROUND_INTRO'; roundNumber: number; questionCount: number; titleRu: string; titleEn: string; descriptionRu: string; descriptionEn: string };
export type AnswerTimer = { serverNow: string; deadlineAt: string; durationSeconds: number; remainingMs: number; expired: boolean };
export type Mapping = { leftId: string; rightId: string }[];
export type MatchingItem = { id: string } & ({ kind: 'text'; textRu: string; textEn: string } | { kind: 'image'; mediaId: string; mediaUrl?: string });
export type PlayerMatchingItem = { id: string } & ({ kind: 'text'; text: string } | { kind: 'image'; mediaId: string; mediaUrl?: string });
export type MatchingContent<T = MatchingItem> = { leftItems?: T[]; rightItems?: T[]; correctMapping?: Mapping };
export type Submission = { submitted: false } | { submitted: true; optionId: string } | { submitted: true; optionIds: string[] } | { submitted: true; mapping: Mapping };
export type PlayerQuestion = MatchingContent<PlayerMatchingItem> & { state: 'ANSWERING'; type?: 'multiple_choice' | 'matching'; requiredCorrectCount?: number; excluded?: boolean; questionId: string; submission: Submission; text: string; options: { id: string; text: string }[]; timer: AnswerTimer };
export type PlayerReveal = Omit<PlayerQuestion, 'state' | 'timer'> & { state: 'ANSWER_REVEAL'; correctOptionId?: string; correctOptionIds?: string[]; result: { outcome: 'correct' | 'wrong' | 'unanswered'; points: number } };
export type NavigationAction = 'next' | 'show-leaderboard' | 'next-round' | 'final-results' | 'show-winner';
export type GameBoundary = { state: 'ROUND_END' | 'LEADERBOARD' | 'FINAL_RESULTS' | 'WINNER_SCREEN'; roundNumber: number; questionCount: number; titleRu: string; titleEn: string; nextAction?: NavigationAction | null; leaderboard?: { playerId: string; displayName: string; totalPoints: number; rank: number }[] };
export type MediaAction = 'play' | 'pause' | 'restart';
export type QuestionMedia = { mediaId: string; name: string; mediaUrl: string; kind?: 'image' | 'audio' | 'video'; playBeforeTimer?: boolean; playback?: { playing: boolean; positionSeconds: number; serverNow: number; revision: number } };
export type CurrentQuestion = MatchingContent & { type?: 'single_choice' | 'multiple_choice' | 'yes_no' | 'matching'; explanationRu?: string; explanationEn?: string; preTimer?: { mediaId: string; number: number; total: number }; questionId?: string; media?: QuestionMedia[]; nextAction?: NavigationAction | null; state: 'QUESTION' | 'ANSWERING' | 'ANSWER_REVEAL'; timer?: AnswerTimer; statistics?: { correct: number; wrong: number; unanswered: number }; answers?: { answered: number; expected: number }; roundNumber: number; questionNumber: number; questionCount: number; textRu: string; textEn: string; points?: number; answerTimeSeconds?: number; options?: { textRu: string; textEn: string; isCorrect?: boolean }[] };
export type PausedGame = { content?: RoundIntro | CurrentQuestion | GameBoundary | null; state: 'PAUSED'; pausedFromState: Exclude<Room['state'], 'LOBBY' | 'WINNER_SCREEN' | 'PAUSED'>; remainingMs: number | null; reason?: 'manual' | 'player_disconnect'; disconnectedPlayer?: { id: string; name: string; present: boolean } | null };
export type LobbyState = { room: Room; game?: RoundIntro | CurrentQuestion | GameBoundary | PausedGame | null; players?: { id: string; name: string; language: 'ru' | 'en'; joinedAt: string; present?: boolean }[] };
type Audience = 'host' | 'screen' | 'player';
export const lobbyTransport = { connect: () => io({ autoConnect: false }) };

type MediaCompletion = { roomId: string; questionId: string; mediaId: string; revision: number; duration: number };
// Survives a Screen component remount while this browser page is open.
const pendingMediaCompletions = new Map<string, MediaCompletion>();
const completionKey = ({ roomId, questionId, mediaId, revision }: MediaCompletion) => `${roomId}:${questionId}:${mediaId}:${revision}`;
function completionIsCurrent(completion: MediaCompletion, snapshot: LobbyState) {
  if (snapshot.room.closedAt) return false;
  const paused = snapshot.game?.state === 'PAUSED';
  const game = snapshot.game?.state === 'PAUSED' ? snapshot.game.content : snapshot.game;
  if (!game || !('questionId' in game) || game.questionId !== completion.questionId) return false;
  const media = game.media?.find(item => item.mediaId === completion.mediaId);
  return media?.playback?.revision === completion.revision
    && (paused ? game.state === 'QUESTION' && game.preTimer?.mediaId === completion.mediaId : media.playback.playing);
}

export function useLobby(roomId: string | undefined, audience: Audience, token?: string | null) {
  const [state, setState] = useState<LobbyState | null>(null);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState(false);
  const [connected, setConnected] = useState(false);
  const revision = useRef(0);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const subscribed = useRef(false);
  const inFlight = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const clearInFlight = useCallback(() => {
    for (const timeout of inFlight.current.values()) clearTimeout(timeout);
    inFlight.current.clear();
  }, []);
  const sendPending = useCallback(() => {
    const socket = socketRef.current;
    if (audience !== 'screen' || !subscribed.current || !socket?.connected) return;
    for (const [key, completion] of pendingMediaCompletions) {
      if (completion.roomId !== roomId || inFlight.current.has(key)) continue;
      const timeout = setTimeout(() => {
        if (inFlight.current.get(key) !== timeout) return;
        inFlight.current.delete(key);
        sendPending();
      }, 3000);
      inFlight.current.set(key, timeout);
      socket.emit('media:ended', completion, (result: { accepted: boolean }) => {
        if (inFlight.current.get(key) !== timeout) return;
        // Pause can reject an otherwise current completion. Keep it until acceptance
        // or an authoritative snapshot invalidates the playback attempt.
        if (!result.accepted) return;
        clearTimeout(timeout);
        inFlight.current.delete(key);
        pendingMediaCompletions.delete(key);
      });
    }
  }, [roomId, audience]);
  const reportMediaEnded = useCallback((questionId: string, mediaId: string, playbackRevision: number, duration: number) => {
    if (audience !== 'screen' || !roomId) return;
    const completion = { roomId, questionId, mediaId, revision: playbackRevision, duration };
    if (!pendingMediaCompletions.has(completionKey(completion))) pendingMediaCompletions.set(completionKey(completion), completion);
    sendPending();
  }, [roomId, audience, sendPending]);
  const refresh = useCallback(async () => {
    const expected = ++revision.current;
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId!)}/game/${audience}`, { cache: 'no-store' });
    const body = await response.json();
    if (expected !== revision.current) return;
    if (!response.ok) throw new Error(body.error || 'Could not load room.');
    setState(body);
  }, [roomId, audience]);
  useEffect(() => {
    setState(null); setError(''); setConnected(false); setRemoved(false);
    subscribed.current = false;
    if (!roomId || (audience === 'player' && !token)) return;
    const initialRevision = ++revision.current;
    let active = true;
    let receivedSnapshot = false;
    // HTTP provides initial/reload state even before the realtime connection is ready.
    // A socket snapshot always supersedes any earlier, slower HTTP response.
    if (audience !== 'player') {
      void fetch(`/api/rooms/${encodeURIComponent(roomId)}/game/${audience}`, { cache: 'no-store' })
        .then(async response => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Could not load room.');
          if (active && !receivedSnapshot && initialRevision === revision.current) setState(body);
        }).catch((cause: Error) => { if (active && !receivedSnapshot && initialRevision === revision.current) setError(cause.message); });
    }
    const socket = lobbyTransport.connect();
    socketRef.current = socket;
    const subscribe = () => {
      subscribed.current = false;
      // The subscription returns a fresh SQLite snapshot on EVERY connection;
      // no event history or client cache is used for recovery.
      socket.emit('lobby:subscribe', { roomId, audience, ...(audience === 'player' ? { token } : {}) });
    };
    socket.on('connect', subscribe);
    const restoreVisible = () => { if (!document.hidden && socket.connected) subscribe(); };
    document.addEventListener('visibilitychange', restoreVisible);
    socket.on('lobby:state', (snapshot: LobbyState) => {
      if (!active || snapshot.room.id !== roomId) return;
      if (audience === 'screen') {
        for (const [key, completion] of pendingMediaCompletions) {
          if (completion.roomId === roomId && !completionIsCurrent(completion, snapshot)) {
            pendingMediaCompletions.delete(key);
            const timeout = inFlight.current.get(key);
            if (timeout) clearTimeout(timeout);
            inFlight.current.delete(key);
          }
        }
        if (snapshot.room.state === 'PAUSED') clearInFlight();
        subscribed.current = snapshot.room.state !== 'PAUSED';
        sendPending();
      }
      revision.current++;
      receivedSnapshot = true;
      setState(snapshot); setError(''); setConnected(true);
    });
    socket.on('player:removed', (body: { roomId: string }) => { if (body.roomId === roomId) { revision.current++; setRemoved(true); setState(null); } });
    socket.on('lobby:error', (body: { error: string }) => { revision.current++; subscribed.current = false; clearInFlight(); setState(null); setError(body.error); setConnected(false); });
    socket.on('disconnect', () => { subscribed.current = false; clearInFlight(); setConnected(false); });
    socket.on('connect_error', () => { subscribed.current = false; clearInFlight(); setConnected(false); });
    socket.connect();
    return () => { revision.current++; active = false; subscribed.current = false; clearInFlight(); document.removeEventListener('visibilitychange', restoreVisible); socket.removeAllListeners(); socket.disconnect(); socketRef.current = null; };
  }, [roomId, audience, token, clearInFlight, sendPending]);
  return { state, refresh, error, connected, removed, reportMediaEnded };
}
