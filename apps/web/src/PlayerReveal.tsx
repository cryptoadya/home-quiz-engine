import type { PlayerReveal } from './lobby';

export function PlayerRevealContent({ question, language }: { question: PlayerReveal; language: 'ru' | 'en' }) {
  const ru = language === 'ru';
  const { outcome, points } = question.result;
  const correct = question.options.find(option => option.id === question.correctOptionId);
  const selectedId = question.submission.submitted ? question.submission.optionId : null;
  const selected = question.options.find(option => option.id === selectedId);
  return <>
    <h2>{question.text}</h2>
    <p role="status">{outcome === 'correct' ? `${ru ? 'Верно!' : 'Correct!'} +${points}`
      : outcome === 'wrong' ? (ru ? 'Неверно' : 'Incorrect') : (ru ? 'Нет ответа' : 'No answer')}</p>
    <p>{ru ? 'Очки' : 'Points'}: {points}</p>
    <p className="correct-option">{ru ? 'Верный ответ' : 'Correct answer'}: {correct?.text}</p>
    {selected && <p>{ru ? 'Ваш ответ' : 'Your answer'}: {selected.text}</p>}
  </>;
}
