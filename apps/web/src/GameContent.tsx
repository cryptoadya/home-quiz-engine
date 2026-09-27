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

export function QuestionContent({ question, host = false }: { question: CurrentQuestion; host?: boolean }) {
  return <>
    {question.answers && <p>Ответили / Answered: {question.answers.answered} / {question.answers.expected}</p>}
    {question.statistics && <p>Верно / Correct: {question.statistics.correct} · Неверно / Wrong: {question.statistics.wrong} · Нет ответа / Unanswered: {question.statistics.unanswered}</p>}
    <p>Раунд {question.roundNumber} / Round {question.roundNumber} · Вопрос / Question {question.questionNumber} / {question.questionCount}</p>
    <h2 lang="ru">{question.textRu}</h2>
    <h2 lang="en">{question.textEn}</h2>
    {(host || question.showOptionsOnScreen || question.state === 'ANSWER_REVEAL') && <ol className="game-options">{question.options?.map((option, index) => <li key={index} className={option.isCorrect ? 'correct-option' : undefined}>
      <span lang="ru">{option.textRu}</span> / <span lang="en">{option.textEn}</span>
      {(host || question.state === 'ANSWER_REVEAL') && option.isCorrect && <> — <strong>{host ? 'Correct answer' : 'Верный ответ / Correct answer'}</strong></>}
    </li>)}</ol>}
  </>;
}
