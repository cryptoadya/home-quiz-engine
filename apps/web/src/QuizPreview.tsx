import { useMemo, useState } from 'react';
import type { Quiz } from './Admin';
import type { Question, Option, Pair, Media, Side } from './Questions';
import type { CurrentQuestion, PlayerQuestion, PlayerReveal, MatchingItem, PlayerMatchingItem } from './lobby';
import { QuestionContent } from './GameContent';
import { PlayerAnswerContent } from './PlayerAnswer';
import { PlayerRevealContent } from './PlayerReveal';
import { CountdownDisplay } from './Countdown';
import { ThemeSurface } from './themes/ThemeSurface';

export type PreviewMode = 'RU Player' | 'EN Player' | 'Screen' | 'Host';
type Props = {
  quizId: string; quiz?: Quiz; question: Question; options: Option[]; pairs: Pair[]; media: Media[];
  roundNumber: number; questionNumber: number; questionCount: number; onClose: () => void;
};

// Editor-only projection: never import session hooks, sockets or mutation APIs here.
export function previewContent({ quizId, quiz, question, options, pairs, media, roundNumber, questionNumber, questionCount }: Omit<Props, 'onClose'>, mode: PreviewMode, reveal: boolean) {
  const player = mode === 'RU Player' || mode === 'EN Player';
  const ru = mode === 'RU Player';
  const url = (id: string) => `/api/quizzes/${encodeURIComponent(quizId)}/media/${encodeURIComponent(id)}/content`;
  const sideItem = (side: Side, id: string): MatchingItem | PlayerMatchingItem => side.kind === 'image'
    ? { id, kind: 'image', mediaId: side.mediaId, mediaUrl: url(side.mediaId) }
    : player ? { id, kind: 'text', text: ru ? side.textRu : side.textEn }
      : { id, kind: 'text', textRu: side.textRu, textEn: side.textEn };
  // Side IDs are independent of editor pair IDs; only Reveal carries a mapping.
  // getRandomValues also works on the app's plain HTTP LAN origin.
  const opaqueId = () => crypto.getRandomValues(new Uint32Array(4)).join('-');
  const sideIds = pairs.map(() => ({ leftId: opaqueId(), rightId: opaqueId() }));
  const leftItems = pairs.map((pair, index) => sideItem(pair.left, sideIds[index].leftId));
  const rightItems = pairs.map((pair, index) => sideItem(pair.right, sideIds[index].rightId));
  const correctMapping = sideIds;
  const matching = question.type === 'matching';
  const duration = question.answerTimeSeconds ?? quiz?.defaultAnswerTimeSeconds ?? 30;
  if (player) {
    const content: Omit<PlayerQuestion, 'timer'> = {
      state: 'ANSWERING', questionId: question.id, text: ru ? question.textRu : question.textEn,
      submission: { submitted: false }, options: matching ? [] : options.map(option => ({ id: option.id, text: ru ? option.textRu : option.textEn })),
      ...(question.type === 'multiple_choice' ? { type: 'multiple_choice', ...((question.showCorrectCount ?? true) ? { requiredCorrectCount: options.filter(option => option.isCorrect).length } : {}) } : {}),
      ...(matching ? { type: 'matching', leftItems: leftItems as PlayerMatchingItem[], rightItems: rightItems as PlayerMatchingItem[] } : {}),
    };
    if (!reveal) return { player: content, duration };
    const result: PlayerReveal = { ...content, state: 'ANSWER_REVEAL', result: { outcome: 'unanswered', points: 0 },
      ...(matching ? { correctMapping } : { correctOptionIds: options.filter(option => option.isCorrect).map(option => option.id) }) };
    return { playerReveal: result, duration };
  }
  const content: CurrentQuestion = {
    state: reveal ? 'ANSWER_REVEAL' : 'ANSWERING', type: question.type, questionId: question.id, roundNumber, questionNumber, questionCount,
    textRu: question.textRu, textEn: question.textEn, points: question.points, answerTimeSeconds: duration,
    ...((reveal || mode === 'Host') ? { explanationRu: question.explanationRu, explanationEn: question.explanationEn } : {}),
    ...(!matching && (reveal || mode === 'Host') ? { options: options.filter(option => mode === 'Host' || option.isCorrect)
      .map(option => ({ textRu: option.textRu, textEn: option.textEn, isCorrect: option.isCorrect })) } : {}),
    ...(matching && (reveal || mode === 'Host') ? { leftItems: leftItems as MatchingItem[], rightItems: rightItems as MatchingItem[], ...((reveal || mode === 'Host') ? { correctMapping } : {}) } : {}),
    media: (question.media ?? []).map(ref => {
      const item = media.find(item => item.id === ref.mediaId);
      return { mediaId: ref.mediaId, name: item?.name ?? 'Media unavailable', kind: item?.kind ?? 'image', mediaUrl: item ? url(item.id) : '', playBeforeTimer: ref.playBeforeTimer };
    }),
  };
  return { question: content, duration };
}

export function QuizPreview(props: Props) {
  const [mode, setMode] = useState<PreviewMode>('RU Player');
  const [reveal, setReveal] = useState(false);
  const content = useMemo(() => previewContent(props, mode, reveal),
    [props.quizId, props.quiz, props.question, props.options, props.pairs, props.media, props.roundNumber, props.questionNumber, props.questionCount, mode, reveal]);
  const language = mode === 'RU Player' ? 'ru' : 'en';
  return <section className="quiz-preview" aria-label="Question preview">
    <div className="preview-controls">
      <label>Preview mode<select value={mode} onChange={event => setMode(event.target.value as PreviewMode)}>
        {(['RU Player', 'EN Player', 'Screen', 'Host'] as const).map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Preview state<select value={reveal ? 'reveal' : 'answering'} onChange={event => setReveal(event.target.value === 'reveal')}>
        <option value="answering">Answering</option><option value="reveal">Reveal / correct answers</option>
      </select></label>
      <button onClick={props.onClose}>Close preview</button>
    </div>
    <p className="preview-banner">Visual preview · timer is frozen · answers stay local. Reveal uses an unanswered sample result.</p>
    <ThemeSurface as="div" themeId={props.quiz?.themeId} data-phase={reveal ? 'ANSWER_REVEAL' : 'ANSWERING'} className={mode === 'Screen' ? 'screen-lobby' : mode === 'Host' ? 'preview-host' : 'player'}>
      <h1>{mode === 'Screen' ? (reveal ? 'Ответ / Answer Reveal' : 'Вопрос / Question') : mode === 'Host' ? 'Host' : language === 'ru' ? 'Игрок' : 'Player'}</h1>
      {(mode === 'Host' || mode === 'Screen') && <h2>{props.quiz?.title}</h2>}
      <div className="game-content">
        {content.player && <PlayerAnswerContent key={`${mode}:${JSON.stringify(content.player)}`} question={content.player} language={language} seconds={content.duration}
          onSubmit={async answer => ({ submitted: true, ...answer })} />}
        {content.playerReveal && <PlayerRevealContent question={content.playerReveal} language={language} />}
        {content.question && <>
          <QuestionContent question={content.question} host={mode === 'Host'} mediaBusy localMediaControls />
          {mode === 'Host' && <><p>Points: {content.question.points}</p><p>Answer time: {content.duration} seconds</p></>}
          {!reveal && <CountdownDisplay seconds={content.duration} />}
        </>}
      </div>
    </ThemeSurface>
  </section>;
}
