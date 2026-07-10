/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export type TeslaPlayerState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'stopped'
  | 'error'
  | 'destroyed';

export class PlayerStateMachine {
  private state: TeslaPlayerState = 'idle';

  get current(): TeslaPlayerState {
    return this.state;
  }

  transition(next: TeslaPlayerState): TeslaPlayerState {
    if (this.state === 'destroyed') return this.state;
    this.state = next;
    return this.state;
  }

  canAcceptMedia(): boolean {
    return this.state === 'loading' || this.state === 'playing' || this.state === 'seeking';
  }
}

