import { MatchingItemContent } from './MediaImage';
import type { PlayerReveal } from './lobby';

export function PlayerRevealContent({ question, language }: { question: PlayerReveal; language: 'ru' | 'en' }) {
  const ru = language === 'ru';
  const { outcome, points } = question.result;
  const correctIds = question.correctOptionIds ?? [question.correctOptionId];
  const correct = question.options.filter(option => correctIds.includes(option.id)).map(option => option.text).join(', ');
  const selectedIds = question.submission.submitted ? ('optionIds' in question.submission ? question.submission.optionIds : 'optionId' in question.submission ? [question.submission.optionId] : []) : [];
  const selected = question.options.filter(option => selectedIds.includes(option.id)).map(option => option.text).join(', ');
  return <div className="player-reveal" data-outcome={outcome}>
    <h2>{question.text}</h2>
    <p className="personal-result" role="status">{outcome === 'correct' ? `${ru ? 'Верно!' : 'Correct!'} +${points}`
      : outcome === 'wrong' ? (ru ? 'Неверно' : 'Incorrect') : (ru ? 'Нет ответа' : 'No answer')}</p>
    <p>{ru ? 'Очки' : 'Points'}: {points}</p>
    {question.correctMapping && <><p>{ru ? 'Верные пары' : 'Correct pairs'}</p><ul className="matching-pairs correct-pairs">{question.correctMapping.map(pair => {
      const left = question.leftItems?.find(item => item.id === pair.leftId), right = question.rightItems?.find(item => item.id === pair.rightId);
      return <li key={pair.leftId}><MatchingItemContent item={left} /> → <MatchingItemContent item={right} /></li>;
    })}</ul></>}
    {question.type !== 'matching' && <p className="correct-option">{ru ? 'Верный ответ' : 'Correct answer'}: {correct}</p>}
    {selected && <p className={outcome === 'wrong' ? 'incorrect-option' : 'selected-result'}>{ru ? 'Ваш ответ' : 'Your answer'}: {selected}</p>}
  </div>;
}
