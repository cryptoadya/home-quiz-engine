import { PlayableMedia } from './PlayableMedia';
import type { MediaAction } from './lobby';
import { MatchingItemContent, MediaImage } from './MediaImage';
import type { CurrentQuestion, RoundIntro } from './lobby';

export function RoundIntroContent({ round }: { round: RoundIntro }) {
  return <>
    <h2>Раунд {round.roundNumber} / Round {round.roundNumber}</h2>
    <h3 lang="ru">{round.titleRu}</h3>
    <h3 lang="en">{round.titleEn}</h3>
    {round.descriptionRu && <p lang="ru">{round.descriptionRu}</p>}
    {round.descriptionEn && <p lang="en">{round.descriptionEn}</p>}
  </>;
}

export function QuestionContent({ question, host = false, onMediaControl, mediaBusy = false }: { question: CurrentQuestion; host?: boolean; onMediaControl?: (mediaId: string, action: MediaAction) => void; mediaBusy?: boolean }) {
  return <>
    {question.answers && <p>Ответили / Answered: {question.answers.answered} / {question.answers.expected}</p>}
    {question.statistics && <p>Верно / Correct: {question.statistics.correct} · Неверно / Wrong: {question.statistics.wrong} · Нет ответа / Unanswered: {question.statistics.unanswered}</p>}
    <p>Раунд {question.roundNumber} / Round {question.roundNumber} · Вопрос / Question {question.questionNumber} / {question.questionCount}</p>
    <h2 lang="ru">{question.textRu}</h2>
    <h2 lang="en">{question.textEn}</h2>
    <div className={host ? 'host-media' : 'question-media'}>{question.media?.map(media => media.kind === 'audio' || media.kind === 'video'
      ? host ? <div key={media.mediaId}><p>{media.name} — {media.playback?.playing ? 'Playing' : 'Paused'}</p>{(['play', 'pause', 'restart'] as const).map(action => <button key={action} aria-label={`${action[0].toUpperCase() + action.slice(1)} ${media.name}`} disabled={mediaBusy} onClick={() => onMediaControl?.(media.mediaId, action)}>{action[0].toUpperCase() + action.slice(1)}</button>)}</div>
        : <PlayableMedia key={`${question.questionId ?? ''}:${media.mediaId}`} media={media} />
      : <MediaImage key={media.mediaId} src={media.mediaUrl} alt={media.name} className="question-image" />)}</div>
    {question.leftItems && <>{question.correctMapping ? <><h3>Верные пары / Correct pairs</h3><ul>{question.correctMapping.map(pair => {
      const left = question.leftItems!.find(item => item.id === pair.leftId), right = question.rightItems?.find(item => item.id === pair.rightId);
      return <li key={pair.leftId}><MatchingItemContent item={left} /> → <MatchingItemContent item={right} /></li>;
    })}</ul></> : <div className="matching-columns">{[question.leftItems, question.rightItems].map((items, index) => <ul key={index}>{items?.map(item => <li key={item.id}><MatchingItemContent item={item} /></li>)}</ul>)}</div>}</>}
    {(host || question.showOptionsOnScreen || question.state === 'ANSWER_REVEAL') && <ol className="game-options">{question.options?.map((option, index) => <li key={index} className={option.isCorrect ? 'correct-option' : undefined}>
      <span lang="ru">{option.textRu}</span> / <span lang="en">{option.textEn}</span>
      {(host || question.state === 'ANSWER_REVEAL') && option.isCorrect && <> — <strong>{host ? 'Correct answer' : 'Верный ответ / Correct answer'}</strong></>}
    </li>)}</ol>}
  </>;
}

export function BoundaryContent({ game }: { game: import('./lobby').GameBoundary }) {
  return <>
    <h2>{game.state === 'ROUND_END' ? 'Раунд завершён / Round complete' : game.state === 'LEADERBOARD' ? 'Таблица лидеров / Leaderboard' : game.state === 'FINAL_RESULTS' ? 'Финальные результаты / Final results' : 'Победители / Winners'}</h2>
    {game.state === 'ROUND_END' && <><h3 lang="ru">{game.titleRu}</h3><h3 lang="en">{game.titleEn}</h3></>}
    {game.leaderboard && (game.state === 'WINNER_SCREEN'
      ? <div className="winners">{game.leaderboard.map(player => <p key={player.playerId}><strong>{player.displayName}</strong> — {player.totalPoints} <span>очков / points</span></p>)}</div>
      : <table className="leaderboard"><thead><tr><th>Место / Rank</th><th>Игрок / Player</th><th>Очки / Points</th></tr></thead>
        <tbody>{game.leaderboard.map(player => <tr key={player.playerId}><td>{player.rank}</td><td>{player.displayName}</td><td>{player.totalPoints}</td></tr>)}</tbody></table>)}
  </>;
}
