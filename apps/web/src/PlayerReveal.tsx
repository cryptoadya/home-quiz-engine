import type { PlayerReveal } from './lobby';

export function PlayerRevealContent({ question, language }: { question: PlayerReveal; language: 'ru' | 'en' }) {
  const ru = language === 'ru';
  const { outcome, points } = question.result;
  const correctIds = question.correctOptionIds ?? [question.correctOptionId];
  const correct = question.options.filter(option => correctIds.includes(option.id)).map(option => option.text).join(', ');
  const selectedIds = question.submission.submitted ? ('optionIds' in question.submission ? question.submission.optionIds : [question.submission.optionId]) : [];
  const selected = question.options.filter(option => selectedIds.includes(option.id)).map(option => option.text).join(', ');
  return <>
    <h2>{question.text}</h2>
    <p role="status">{outcome === 'correct' ? `${ru ? 'Верно!' : 'Correct!'} +${points}`
      : outcome === 'wrong' ? (ru ? 'Неверно' : 'Incorrect') : (ru ? 'Нет ответа' : 'No answer')}</p>
    <p>{ru ? 'Очки' : 'Points'}: {points}</p>
    <p className="correct-option">{ru ? 'Верный ответ' : 'Correct answer'}: {correct}</p>
    {selected && <p>{ru ? 'Ваш ответ' : 'Your answer'}: {selected}</p>}
  </>;
}
