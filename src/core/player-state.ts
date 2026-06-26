// Small lifecycle state machine shared by the standalone HTTP-FLV player.
export type TeslaPlayerState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
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
    return this.state === 'loading' || this.state === 'playing';
  }
}
