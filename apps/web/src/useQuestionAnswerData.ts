import { useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Option, Pair, Question } from './Questions';
import type { useEditorSave, useSaveBarrier } from './EditorSaves';

type OptionFields = Pick<Option, 'textRu' | 'textEn' | 'isCorrect'>;
type PairFields = Pick<Pair, 'left' | 'right'>;

type AnswerDataContext = {
  base: string;
  selected: Question | undefined;
  questionOwner: (id: string) => string;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  saves: ReturnType<typeof useEditorSave>;
  barrier: ReturnType<typeof useSaveBarrier>;
  setError: Dispatch<SetStateAction<string>>;
};

export function useQuestionAnswerData({ base, selected, questionOwner, api, saves, barrier, setError }: AnswerDataContext) {
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [options, setOptions] = useState<Option[]>([]);
  const [childLoadFailed, setChildLoadFailed] = useState(false);
  const answerDataVersion = useRef(0);
  const answerDataLoaded = useRef(false);
  const normalizedOptionsOwner = useRef<string | null>(null);
  const incompleteOptionEdits = useRef(new Map<string, OptionFields>());
  const incompletePairEdits = useRef(new Map<string, PairFields>());
  const selectedAnswer = useRef<{ id: string; type: Question['type'] } | null>(null);
  selectedAnswer.current = selected ? { id: selected.id, type: selected.type } : null;

  function invalidateAnswerData() { answerDataVersion.current += 1; }
  function isCurrentAnswer(question: Question, version: number) {
    return answerDataVersion.current === version && selectedAnswer.current?.id === question.id && selectedAnswer.current.type === question.type;
  }
  async function loadAnswerData(question: Question) {
    const version = ++answerDataVersion.current;
    answerDataLoaded.current = false;
    try {
      if (question.type === 'matching') {
        const items = await api<Pair[]>(`${base}/${question.id}/pairs`);
        if (!isCurrentAnswer(question, version)) return;
        setPairs(items.map(item => ({ ...item, ...incompletePairEdits.current.get(item.id) })));
      } else {
        const items = await api<Option[]>(`${base}/${question.id}/options`);
        if (!isCurrentAnswer(question, version)) return;
        const owner = `${questionOwner(question.id)}/options`;
        if (normalizedOptionsOwner.current === owner) {
          (barrier ?? saves).reconcileChildren(owner, items.map(item => item.id));
          normalizedOptionsOwner.current = null;
        }
        setOptions(items.map(item => ({ ...item, ...incompleteOptionEdits.current.get(item.id) })));
      }
      incompleteOptionEdits.current.clear(); incompletePairEdits.current.clear();
      answerDataLoaded.current = true;
      setChildLoadFailed(false); setError('');
    } catch (cause) {
      if (!isCurrentAnswer(question, version)) return;
      setChildLoadFailed(true); setError((cause as Error).message);
    }
  }
  function commitChildChange(question: Question, apply: () => void) {
    const needsReload = !answerDataLoaded.current;
    invalidateAnswerData();
    if (selectedAnswer.current?.id !== question.id || selectedAnswer.current.type !== question.type) return;
    apply();
    // The mutation waited for draft saves, so its authoritative response/reload
    // already includes them and may supersede fields such as correctness.
    incompleteOptionEdits.current.clear(); incompletePairEdits.current.clear();
    setChildLoadFailed(false);
    if (needsReload) void loadAnswerData(question);
    else answerDataLoaded.current = true;
  }

  function resetAnswerData(question: Question | undefined) {
    invalidateAnswerData();
    incompleteOptionEdits.current.clear(); incompletePairEdits.current.clear();
    setOptions([]); setPairs([]); setChildLoadFailed(false);
    if (question) void loadAnswerData(question);
    return () => invalidateAnswerData();
  }
  function changeAnswerSelection(applySelection: () => void) {
    invalidateAnswerData(); applySelection(); setChildLoadFailed(false);
  }
  function applyOptionEdit(option: Option, changes: OptionFields) {
    if (answerDataLoaded.current) invalidateAnswerData();
    else incompleteOptionEdits.current.set(option.id, changes);
    setOptions((items) => items.map((item) => item.id === option.id ? { ...item, ...changes } : item));
  }
  function applyPairEdit(pair: Pair, changes: PairFields) {
    if (answerDataLoaded.current) invalidateAnswerData();
    else incompletePairEdits.current.set(pair.id, changes);
    setPairs(items => items.map(item => item.id === pair.id ? { ...item, ...changes } : item));
  }
  function applyQuestionTypeChange(previous: Question, question: Question, applyQuestion: () => void) {
    normalizedOptionsOwner.current = previous.type !== 'matching' && previous.type !== 'yes_no' && question.type === 'yes_no'
      ? `${questionOwner(question.id)}/options` : null;
    applyQuestion();
    invalidateAnswerData(); answerDataLoaded.current = false;
    incompleteOptionEdits.current.clear(); incompletePairEdits.current.clear();
    setOptions([]); setPairs([]); setChildLoadFailed(false);
  }

  return {
    options, setOptions, pairs, setPairs, childLoadFailed,
    loadAnswerData, commitChildChange, resetAnswerData, changeAnswerSelection,
    applyOptionEdit, applyPairEdit, applyQuestionTypeChange,
  };
}
