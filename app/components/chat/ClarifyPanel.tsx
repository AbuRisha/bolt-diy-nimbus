/*
 * ClarifyPanel — Nimbus-branded clarifying question panel.
 * Renders above the composer as a dark card when /api/plan returns mode:'questions'.
 * Task #56 — visual layer over the clarify flow with hard Nimbus dark styling.
 */
import React, { useState } from 'react';
import type { ClarifyQuestion } from './ClarifyChips';

interface ClarifyPanelProps {
  questions: ClarifyQuestion[];
  /** Called with collected answers when the user clicks "Build Now". */
  onComplete: (answers: Record<string, string>) => void;
  /** Called when the user skips all remaining questions. */
  onSkip: () => void;
}

export const ClarifyPanel: React.FC<ClarifyPanelProps> = ({ questions, onComplete, onSkip }) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const pickChip = (qid: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
  };

  const allAnswered = questions.every((q) => Boolean(answers[q.id]));

  const handleBuild = () => {
    if (allAnswered) {
      onComplete(answers);
    }
  };

  return (
    <div className="rounded-xl border border-violet-500/30 bg-[#0d1117] p-4 flex flex-col gap-4 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Before we build — a few quick choices</p>
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-gray-400 hover:text-gray-200 underline underline-offset-2 transition-colors"
        >
          Skip &amp; Build
        </button>
      </div>

      {/* Questions */}
      <div className="flex flex-col gap-4">
        {questions.map((q) => {
          const picked = answers[q.id];
          return (
            <div key={q.id} className="flex flex-col gap-2">
              <p className="text-sm text-gray-300">{q.question}</p>
              <div className="flex flex-wrap gap-2">
                {q.chips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => pickChip(q.id, chip)}
                    className={[
                      'text-xs px-3 py-1.5 rounded-full border transition-all duration-150 select-none',
                      picked === chip
                        ? 'bg-violet-600 border-violet-500 text-white shadow-[0_0_8px_rgba(139,92,246,0.35)]'
                        : 'bg-[#1a1f2e] border-gray-600 text-gray-300 hover:border-violet-500/50 hover:text-white',
                    ].join(' ')}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-3 pt-1 border-t border-white/5">
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={handleBuild}
          disabled={!allAnswered}
          className={[
            'text-xs px-4 py-1.5 rounded-lg font-semibold transition-all duration-150',
            allAnswered
              ? 'bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white shadow-sm'
              : 'bg-[#1a1f2e] text-gray-500 cursor-not-allowed border border-gray-700',
          ].join(' ')}
        >
          Build Now
        </button>
      </div>
    </div>
  );
};

export default ClarifyPanel;
