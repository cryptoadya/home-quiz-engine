import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Quiz } from './Admin';
import type { Round } from './Rounds';
import type { Question, Option, Pair, Media, Side } from './Questions';
import type { CurrentQuestion, PlayerQuestion, PlayerReveal, MatchingItem, PlayerMatchingItem, GameBoundary, RoundIntro } from './lobby';
import { QuestionContent, RoundIntroContent, QuestionReadyContent, BoundaryContent, LobbyContent } from './GameContent';
import { QRCodeSVG } from 'qrcode.react';
import { PlayerAnswerContent } from './PlayerAnswer';
import { PlayerRevealContent } from './PlayerReveal';
import { CountdownDisplay } from './Countdown';
import { ThemeSurface } from './themes/ThemeSurface';
import { ThemeDecoration } from './themes/ThemeDecoration';
import { ThemeScenery, screenScenery } from './themes/ThemeScenery';

export type PreviewMode = 'RU Player' | 'EN Player' | 'Screen' | 'Host';
export type PreviewPhase = 'lobby' | 'round-intro' | 'ready' | 'answering' | 'reveal' | 'round-end' | 'leaderboard' | 'final-results' | 'winners';
const screenPhases: { value: PreviewPhase; state: string; title: string; label: string }[] = [
  { value: 'lobby', state: 'LOBBY', title: 'Лобби / Lobby', label: 'Lobby / Лобби' },
  { value: 'round-intro', state: 'ROUND_INTRO', title: 'Начало раунда / Round Intro', label: 'Round Intro / Начало раунда' },
  { value: 'ready', state: 'QUESTION', title: 'Вопрос / Question', label: 'Ready / Вопрос готов' },
  { value: 'answering', state: 'ANSWERING', title: 'Вопрос / Question', label: 'Answering' },
  { value: 'reveal', state: 'ANSWER_REVEAL', title: 'Ответ / Answer Reveal', label: 'Reveal / correct answers' },
  { value: 'round-end', state: 'ROUND_END', title: 'Игра / Game', label: 'Round End / Конец раунда' },
  { value: 'leaderboard', state: 'LEADERBOARD', title: 'Игра / Game', label: 'Leaderboard / Таблица' },
  { value: 'final-results', state: 'FINAL_RESULTS', title: 'Игра / Game', label: 'Final Results / Итоги' },
  { value: 'winners', state: 'WINNER_SCREEN', title: 'Игра / Game', label: 'Winners / Победители' },
];
type Props = {
  quizId: string; quiz?: Quiz; round?: Pick<Round, 'titleRu' | 'titleEn' | 'descriptionRu' | 'descriptionEn' | 'artMediaId'>;
  question?: Question; options: Option[]; pairs: Pair[]; media: Media[]; initialPhase?: PreviewPhase;
  roundNumber: number; questionNumber: number; questionCount: number; onClose: () => void;
};
type PreviewContent = { duration: number; player?: Omit<PlayerQuestion, 'timer'>; playerReveal?: PlayerReveal; question?: CurrentQuestion };

function sampleStandings(count: number, winners = false): NonNullable<GameBoundary['leaderboard']> {
  return Array.from({ length: count }, (_, index) => ({ playerId: `sample-${index}`, displayName: ['Максимилиан-Александр', 'Александра-Стефания', 'Анна'][index] ?? `Игрок ${index + 1}`,
    rank: winners || index < 2 ? 1 : index + 1, totalPoints: winners || index < 2 ? 1200 : 1200 - index * 20 }));
}

// Editor-only projection: never import session hooks, sockets or mutation APIs here.
export function previewContent({ quizId, quiz, question, options, pairs, media, roundNumber, questionNumber, questionCount }: Omit<Props, 'onClose'>, mode: PreviewMode, reveal: boolean): PreviewContent {
  const duration = question?.answerTimeSeconds ?? quiz?.defaultAnswerTimeSeconds ?? 30;
  if (!question) return { duration };
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
  const [mode, setMode] = useState<PreviewMode>(props.initialPhase ? 'Screen' : 'RU Player');
  const [phase, setPhase] = useState<PreviewPhase>(props.initialPhase ?? 'answering');
  const reveal = phase === 'reveal';
  const [samplePlayers, setSamplePlayers] = useState(3);
  const [sampleWinners, setSampleWinners] = useState(1);
  const [shape, setShape] = useState('16 / 9');
  const [expanded, setExpanded] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const [screenScale, setScreenScale] = useState(1);
  const screenWidth = shape === '9 / 16' ? 720 : 1280;
  const [ratioWidth, ratioHeight] = shape.split('/').map(Number);
  const screenHeight = screenWidth * ratioHeight / ratioWidth;
  useLayoutEffect(() => {
    if (expanded) viewport.current?.closest('.quiz-preview')?.scrollIntoView?.({ block: 'start' });
  }, [expanded]);
  // Lay out Screen at a TV-sized resolution, then fit that stage into the rail.
  // Measuring the rail as the Screen itself would produce false overflow warnings.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (mode !== 'Screen' || !element) return;
    const measure = () => { if (element.clientWidth) setScreenScale(element.clientWidth / screenWidth); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, screenWidth]);
  const content = useMemo(() => previewContent(props, mode, reveal),
    [props.quizId, props.quiz, props.question, props.options, props.pairs, props.media, props.roundNumber, props.questionNumber, props.questionCount, mode, reveal]);
  const language = mode === 'RU Player' ? 'ru' : 'en';
  const phaseInfo = screenPhases.find(item => item.value === phase)!;
  const round: RoundIntro = { state: 'ROUND_INTRO', roundNumber: props.roundNumber, questionCount: props.questionCount,
    titleRu: props.round?.titleRu ?? '', titleEn: props.round?.titleEn ?? '', descriptionRu: props.round?.descriptionRu ?? '', descriptionEn: props.round?.descriptionEn ?? '',
    ...(props.round?.artMediaId ? { artUrl: `/api/quizzes/${encodeURIComponent(props.quizId)}/media/${encodeURIComponent(props.round.artMediaId)}/content` } : {}) };
  const boundary: GameBoundary | undefined = ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(phaseInfo.state)
    ? { ...round, state: phaseInfo.state as GameBoundary['state'], ...(phase === 'round-end' ? {} : { leaderboard: sampleStandings(phase === 'winners' ? sampleWinners : samplePlayers, phase === 'winners') }) } : undefined;
  const scenery = mode === 'Screen' ? screenScenery(phase === 'round-intro' ? round : phase === 'ready' ? { state: 'QUESTION', roundNumber: props.roundNumber, questionNumber: props.questionNumber, questionCount: props.questionCount, textRu: '', textEn: '' } : boundary ?? content.question) : undefined;
  const questionPhase = phase === 'answering' || reveal;
  return <section className="quiz-preview" aria-label="Question preview" data-expanded={expanded || undefined}>
    <div className="preview-controls">
      <label>Preview mode<select value={mode} onChange={event => { setMode(event.target.value as PreviewMode); if (event.target.value !== 'Screen' && !questionPhase) setPhase('answering'); }}>
        {(['RU Player', 'EN Player', 'Screen', 'Host'] as const).map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Preview state<select value={phase} onChange={event => setPhase(event.target.value as PreviewPhase)}>
        {screenPhases.filter(item => mode === 'Screen' || item.value === 'answering' || item.value === 'reveal').map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      <button onClick={props.onClose}>Close preview</button>
      <button aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Compact preview' : 'Expand preview'}</button>
      {mode === 'Screen' && <label>Screen format<select value={shape} onChange={event => setShape(event.target.value)}><option value="16 / 9">Wide · 16:9</option><option value="4 / 3">Standard · 4:3</option><option value="9 / 16">Portrait · 9:16</option></select></label>}
      {mode === 'Screen' && ['lobby', 'leaderboard', 'final-results'].includes(phase) && <label>Sample players<select value={samplePlayers} onChange={event => setSamplePlayers(Number(event.target.value))}>{[0, 3, 30].map(count => <option key={count} value={count}>{count}</option>)}</select></label>}
      {mode === 'Screen' && phase === 'winners' && <label>Sample winners<select value={sampleWinners} onChange={event => setSampleWinners(Number(event.target.value))}>{[1, 3, 30].map(count => <option key={count} value={count}>{count}</option>)}</select></label>}
    </div>
    <p className="preview-banner">Visual preview · timer is frozen · answers stay local. Players and scores are samples; no room is created. Reveal uses an unanswered sample result.</p>
    <div ref={viewport} className="preview-viewport" data-mode={mode === 'Screen' ? 'screen' : mode === 'Host' ? 'host' : 'player'} style={{ '--preview-ratio': shape,
      '--preview-screen-width': `${screenWidth}px`, '--preview-screen-height': `${screenHeight}px`, '--preview-screen-scale': screenScale } as CSSProperties}>
    <ThemeSurface as="div" themeId={props.quiz?.themeId} data-phase={phaseInfo.state} data-scene={scenery} className={mode === 'Screen' ? 'screen-lobby' : mode === 'Host' ? 'preview-host' : 'player'}>
      {mode === 'Screen' && <ThemeScenery kind={scenery} />}
      {mode === 'Screen' && <ThemeDecoration kind="corners" />}
      <header className={mode === 'Screen' ? 'screen-header' : 'preview-header'}><h1>{mode === 'Screen' ? phaseInfo.title : mode === 'Host' ? 'Host' : language === 'ru' ? 'Игрок' : 'Player'}</h1>
      {(mode === 'Host' || mode === 'Screen') && <h2 className="quiz-title">{props.quiz?.title}</h2>}</header>
      {mode === 'Screen' && phase === 'lobby' ? <LobbyContent code="DEMO" players={sampleStandings(samplePlayers).map(player => ({ id: player.playerId, name: player.displayName }))}>
        <p>Демонстрация лобби / Sample lobby</p><div className="join-codes"><QRCodeSVG value="Home Quiz Engine preview — no active room" size={200} marginSize={2} title="Demo QR — no active room" /><p>Пример QR / Sample QR</p></div>
      </LobbyContent> : <div className="game-content">
        {mode === 'Screen' && phase === 'round-intro' && <RoundIntroContent round={round} />}
        {mode === 'Screen' && phase === 'ready' && <QuestionReadyContent roundNumber={props.roundNumber} questionNumber={props.questionNumber} questionCount={props.questionCount} />}
        {mode === 'Screen' && boundary && <BoundaryContent screen game={boundary} />}
        {questionPhase && !props.question && <p role="status">Add a question to preview its content.</p>}
        {questionPhase && content.player && <PlayerAnswerContent key={`${mode}:${JSON.stringify(content.player)}`} question={content.player} language={language} seconds={content.duration}
          onSubmit={async answer => ({ submitted: true, ...answer })} />}
        {questionPhase && content.playerReveal && <PlayerRevealContent question={content.playerReveal} language={language} />}
        {questionPhase && content.question && <>
          <QuestionContent question={content.question} host={mode === 'Host'} mediaBusy localMediaControls />
          {mode === 'Host' && <><p>Points: {content.question.points}</p><p>Answer time: {content.duration} seconds</p></>}
          {!reveal && <CountdownDisplay seconds={content.duration} />}
        </>}
      </div>}
    </ThemeSurface>
    </div>
    {mode === 'Screen' && questionPhase && <p className="preview-overflow-warning" role="status">Содержимое требует прокрутки при читаемом размере. Сократите текст или разделите содержимое. / Content requires scrolling at a readable size.</p>}
  </section>;
}
