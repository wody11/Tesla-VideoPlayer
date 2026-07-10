/*
 * MP4 no-video loading facade. MSE/video based paths are disabled by design.
 */

export class Mp4Loader {
  readonly mseDisabled = true;
  readonly disabledReason = 'MSE/video tag MP4 fallback is disabled in Tesla no-video mode.';
}

