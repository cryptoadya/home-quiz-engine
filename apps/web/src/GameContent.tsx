import { PlayableMedia } from './PlayableMedia';
import type { MediaAction } from './lobby';
import { MatchingItemContent, MediaImage } from './MediaImage';
import type { CurrentQuestion, RoundIntro } from './lobby';
import { ThemeDecoration } from './themes/ThemeDecoration';
import { usePresentationLayout } from './usePresentationLayout';

const hostMediaActions = { play: 'Проиграть', pause: 'Пауза', restart: 'Сначала' };

export function RoundIntroContent({ round }: { round: RoundIntro }) {
  return <div className="round-intro">
    <ThemeDecoration kind="round" />
    <h2 className="phase-chip">Раунд {round.roundNumber} / Round {round.roundNumber}</h2>
    <h3 lang="ru">{round.titleRu}</h3>
    <h3 lang="en">{round.titleEn}</h3>
    {round.artUrl && <MediaImage src={round.artUrl} alt="Round art" className="question-image" />}
    {round.descriptionRu && <p lang="ru">{round.descriptionRu}</p>}
    {round.descriptionEn && <p lang="en">{round.descriptionEn}</p>}
  </div>;
}

export function QuestionContent({ question, host = false, onMediaControl, onMediaEnded, mediaBusy = false, localMediaControls = false }: { localMediaControls?: boolean; question: CurrentQuestion; host?: boolean; onMediaControl?: (mediaId: string, action: MediaAction) => void; mediaBusy?: boolean; onMediaEnded?: (mediaId: string, revision: number, duration: number) => void }) {
  const featuredVideo = question.media?.find(media => media.kind === 'video' && (media.playback?.playing || media.mediaId === question.preTimer?.mediaId));
  const visualCount = featuredVideo ? 1 : question.media?.filter(media => media.kind !== 'audio').length ?? 0;
  const { ref, overflow } = usePresentationLayout(`${question.questionId}:${question.textRu}:${question.textEn}:${question.state}:${featuredVideo?.mediaId}`, visualCount, host);
  return <div ref={ref} className="question-presentation" data-reveal={question.state === 'ANSWER_REVEAL' || undefined} data-has-media={visualCount > 0 || undefined} data-text-overflow={overflow || undefined}>
    {host && question.preTimer && <p className="state-notice waiting" role="status">До таймера / Before timer: {question.preTimer.number} / {question.preTimer.total} — {question.media?.find(media => media.mediaId === question.preTimer!.mediaId)?.name}</p>}
    <div className="question-meta">
    <p className="phase-chip">{question.isTiebreak ? 'Допвопросы / Tiebreak' : `Раунд ${question.roundNumber} / Round ${question.roundNumber}`} · Вопрос / Question {question.questionNumber} / {question.questionCount}</p>
    {question.answers && <p className="answer-count">Ответили / Answered: {question.answers.answered} / {question.answers.expected}</p>}
    {!host && question.state === 'ANSWER_REVEAL' && <ThemeDecoration kind="reveal" />}
    </div>
    {question.statistics && <p className="reveal-statistics">Верно / Correct: {question.statistics.correct} · Неверно / Wrong: {question.statistics.wrong} · Нет ответа / Unanswered: {question.statistics.unanswered}</p>}
    <div className="question-copy">
    <h2 lang="ru">{question.textRu}</h2>
    <h2 lang="en">{question.textEn}</h2>
    </div>
    <div className={host ? 'host-media' : 'question-media'} data-video-focus={Boolean(featuredVideo) || undefined}>{question.media?.map(media => media.kind === 'audio' || media.kind === 'video'
      ? host ? <div key={media.mediaId}><p>{media.name} — {media.playback?.playing ? 'Воспроизводится' : 'Приостановлено'}</p>{(['play', 'pause', 'restart'] as const).map(action => <button key={action} aria-label={`${hostMediaActions[action]} ${media.name}`} disabled={mediaBusy || Boolean(question.preTimer && question.preTimer.mediaId !== media.mediaId)} onClick={() => onMediaControl?.(media.mediaId, action)}>{hostMediaActions[action]}</button>)}</div>
        : <PlayableMedia key={`${question.questionId ?? ''}:${media.mediaId}`} featured={media.mediaId === featuredVideo?.mediaId} media={{ ...media, name: media.kind === 'video' ? 'Видео / Video' : 'Аудио / Audio' }} onEnded={onMediaEnded} localControls={localMediaControls} />
      : <MediaImage key={media.mediaId} src={media.mediaUrl} alt={host ? media.name : 'Изображение / Image'} className="question-image" />)}</div>
    {(host || question.state === 'ANSWER_REVEAL') && (question.explanationRu || question.explanationEn) && <section className="explanation"><h3>Объяснение / Explanation</h3><p lang="ru">{question.explanationRu}</p><p lang="en">{question.explanationEn}</p></section>}
    {(host || question.state === 'ANSWER_REVEAL') && question.leftItems && <>{question.correctMapping ? <><h3>Верные пары / Correct pairs</h3><ul className="matching-pairs correct-pairs">{question.correctMapping.map(pair => {
      const left = question.leftItems!.find(item => item.id === pair.leftId), right = question.rightItems?.find(item => item.id === pair.rightId);
      return <li key={pair.leftId}><MatchingItemContent item={left} /> → <MatchingItemContent item={right} /></li>;
    })}</ul></> : host && <div className="matching-columns">{[question.leftItems, question.rightItems].map((items, index) => <ul key={index}>{items?.map(item => <li key={item.id}><MatchingItemContent item={item} /></li>)}</ul>)}</div>}</>}
    {host && <ol className="game-options">{question.options?.map((option, index) => <li key={index} className={option.isCorrect ? 'correct-option' : question.state === 'ANSWER_REVEAL' ? 'incorrect-option' : undefined}>
      <span className="option-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
      <span lang="ru">{option.textRu}</span> / <span lang="en">{option.textEn}</span>
      {(host || question.state === 'ANSWER_REVEAL') && option.isCorrect && <> — <strong>{host ? 'Верный ответ' : 'Верный ответ / Correct answer'}</strong></>}
    </li>)}</ol>}
    {!host && question.state === 'ANSWER_REVEAL' && question.options?.some(option => option.isCorrect) && <section className="correct-answers">
      <h3>{question.type === 'multiple_choice' ? 'Правильные ответы / Correct answers' : 'Правильный ответ / Correct answer'}</h3>
      <ul className="revealed-answers">{question.options.filter(option => option.isCorrect).map((option, index) => <li key={index} className="correct-option">
        <span lang="ru">{option.textRu}</span> / <span lang="en">{option.textEn}</span>
      </li>)}</ul>
    </section>}
  </div>;
}

export function BoundaryContent({ game }: { game: import('./lobby').GameBoundary }) {
  return <div className={`boundary-content ${game.state === 'WINNER_SCREEN' ? 'winner-stage' : ''}`} data-phase={game.state}>
    {game.state === 'WINNER_SCREEN' && <ThemeDecoration kind="winner" />}
    {game.state !== 'WINNER_SCREEN' && <ThemeDecoration kind="waiting" />}
    <h2>{game.state === 'ROUND_END' ? 'Раунд завершён / Round complete' : game.state === 'LEADERBOARD' ? 'Таблица лидеров / Leaderboard' : game.state === 'FINAL_RESULTS' ? 'Финальные результаты / Final results' : 'Победители / Winners'}</h2>
    {game.state === 'ROUND_END' && <><h3 lang="ru">{game.titleRu}</h3><h3 lang="en">{game.titleEn}</h3></>}
    {game.leaderboard?.length === 0 && <p role="status">Нет участников / No remaining players</p>}
    {game.leaderboard && (game.state === 'WINNER_SCREEN'
      ? <div className="winners">{game.leaderboard.map(player => <div className="winner-card" key={player.playerId}><span className="phase-chip">№ 1</span><p><strong>{player.displayName}</strong></p><p className="winner-score">{player.totalPoints} <span>очков / points</span></p></div>)}</div>
      : <table className="leaderboard"><thead><tr><th>Место / Rank</th><th>Игрок / Player</th><th>Очки / Points</th></tr></thead>
        <tbody>{game.leaderboard.map(player => <tr key={player.playerId} data-rank={player.rank}><td><span className="rank-badge">{player.rank}</span></td><th scope="row">{player.displayName}</th><td className="score-value">{player.totalPoints}</td></tr>)}</tbody></table>)}
  </div>;
}
