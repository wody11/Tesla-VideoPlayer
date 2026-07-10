/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export class TeslaPlayerError extends Error {
  constructor(
    message: string,
    readonly code: string = 'TESLA_PLAYER_ERROR',
    readonly fatal = true
  ) {
    super(message);
    this.name = 'TeslaPlayerError';
  }
}

export function toPlayerError(error: unknown, code = 'TESLA_PLAYER_ERROR'): TeslaPlayerError {
  if (error instanceof TeslaPlayerError) return error;
  if (error instanceof Error) return new TeslaPlayerError(error.message, code);
  return new TeslaPlayerError(String(error), code);
}

