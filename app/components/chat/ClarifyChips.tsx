/*
 * @ts-nocheck
 * ClarifyChips — renders /api/plan clarifying questions above the composer.
 * Task #56 — wires backend clarify mode into the first-send flow.
 */
import React, { useState } from 'react';
import { classNames } from '~/utils/classNames';

export interface ClarifyQuestion {
  id: string;
  question: string;
  chips: string[];
}

interface ClarifyChipsProps {
  questions: ClarifyQuestion[];
  onAnswered: (payload: { answers: Record<string, string>; skipped?: boolean }) => void;
}

export const ClarifyChips: React.FC<ClarifyChipsProps> = ({ questions, onAnswered }) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const pickChip = (qid: string, value: string) => {
    const next = { ...answers, [qid]: value };
    setAnswers(next);

    if (questions.every((q) => next[q.id] && next[q.id].length > 0)) {
      onAnswered({ answers: next });
    }
  };

  const commitDraft = (qid: string) => {
    const val = (drafts[qid] || '').trim();

    if (!val) {
      return;
    }

    pickChip(qid, val);
  };

  return (
    <div
      data-clarify-chips
      className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-4 flex flex-col gap-3 text-bolt-elements-textPrimary"
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Quick clarifying questions</div>
        <button
          type="button"
          className="text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary underline underline-offset-2"
          onClick={() => onAnswered({ answers, skipped: true })}
        >
          Skip and build
        </button>
      </div>
      {questions.map((q) => {
        const picked = answers[q.id];
        return (
          <div key={q.id} className="flex flex-col gap-2">
            <div className="text-sm">{q.question}</div>
            <div className="flex flex-wrap gap-2">
              {q.chips.map((chip) => (
                <button
                  type="button"
                  key={chip}
                  onClick={() => pickChip(q.id, chip)}
                  className={classNames(
                    'text-xs px-3 py-1 rounded-full border transition-colors',
                    picked === chip
                      ? 'bg-bolt-elements-item-backgroundAccent border-bolt-elements-borderColorActive text-bolt-elements-item-contentAccent'
                      : 'bg-bolt-elements-background-depth-1 border-bolt-elements-borderColor hover:bg-bolt-elements-item-backgroundActive',
                  )}
                >
                  {chip}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Or type your own…"
                value={drafts[q.id] || ''}
                onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitDraft(q.id);
                  }
                }}
                className="flex-1 text-xs px-2 py-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary"
              />
              <button
                type="button"
                onClick={() => commitDraft(q.id)}
                className="text-xs px-2 py-1 rounded border border-bolt-elements-borderColor hover:bg-bolt-elements-item-backgroundActive"
              >
                Use
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default ClarifyChips;
