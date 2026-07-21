# UI and controls

The active optional control overlay is implemented under `src/control/` and is
created by `TeslaPlayer` when `controls: true`.

Current controls:

- play/resume;
- pause;
- stop;
- volume;
- fullscreen;
- screenshot.

Controls are inserted inside the player container and destroyed when disabled or
when the player is destroyed. Keep controls independent of the playback engine:
they should call public `TeslaPlayer` methods rather than manipulating Worker,
decoder, audio, or renderer state directly.

The files under `src/ui/` are lightweight UI helpers and are not a second player
control system.
