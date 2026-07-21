import { SessionGeneration } from './session-generation';

describe('SessionGeneration', () => {
  test('rapid source switches invalidate callbacks from the previous session', () => {
    const sessions = new SessionGeneration();
    const first = sessions.begin();
    const second = sessions.begin();

    expect(sessions.isCurrent(first)).toBe(false);
    expect(sessions.isCurrent(second)).toBe(true);
  });

  test('stop invalidates the active session', () => {
    const sessions = new SessionGeneration();
    const active = sessions.begin();

    sessions.invalidate();

    expect(sessions.isCurrent(active)).toBe(false);
  });

  test('a new session can start after an error invalidates the old one', () => {
    const sessions = new SessionGeneration();
    const failed = sessions.begin();
    sessions.invalidate();
    const recovered = sessions.begin();

    expect(sessions.isCurrent(failed)).toBe(false);
    expect(sessions.isCurrent(recovered)).toBe(true);
  });
});
