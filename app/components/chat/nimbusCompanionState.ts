export type CompanionState = 'ready' | 'thinking' | 'building' | 'watching' | 'done' | 'error';

export type CompanionEvent =
  | { type: 'history-loading' }
  | { type: 'history-ready'; hasHistory: boolean }
  | { type: 'request-started' }
  | { type: 'work-started' }
  | { type: 'completed' }
  | { type: 'failed' }
  | { type: 'reset' };

export const COMPANION_DONE_VISIBLE_MS = 2200;

/** Pure state transition shared by Chat.client and focused behavior tests. */
export function nextCompanionState(event: CompanionEvent): CompanionState {
  switch (event.type) {
    case 'history-loading':
    case 'request-started':
      return 'thinking';
    case 'history-ready':
      return event.hasHistory ? 'watching' : 'ready';
    case 'work-started':
      return 'building';
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'reset':
      return 'ready';
    default:
      return 'ready';
  }
}
