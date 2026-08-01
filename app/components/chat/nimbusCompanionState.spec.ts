import { describe, expect, it } from 'vitest';
import { nextCompanionState } from './nimbusCompanionState';

describe('Nimbus companion state transitions', () => {
  it('distinguishes history loading, empty history, and a saved run', () => {
    expect(nextCompanionState({ type: 'history-loading' })).toBe('thinking');
    expect(nextCompanionState({ type: 'history-ready', hasHistory: false })).toBe('ready');
    expect(nextCompanionState({ type: 'history-ready', hasHistory: true })).toBe('watching');
  });

  it('tracks a successful Builder request from model wait through work and completion', () => {
    expect(nextCompanionState({ type: 'request-started' })).toBe('thinking');
    expect(nextCompanionState({ type: 'work-started' })).toBe('building');
    expect(nextCompanionState({ type: 'completed' })).toBe('done');
    expect(nextCompanionState({ type: 'reset' })).toBe('ready');
  });

  it('keeps request failures distinct from successful completion', () => {
    expect(nextCompanionState({ type: 'failed' })).toBe('error');
  });
});
