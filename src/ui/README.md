# UI and responsive layout

`PlayerLayoutController` is the single owner of responsive container sizing. With
`responsive: true`, it derives height from available width, caps the result to
the visual viewport, reacts to resize/orientation/fullscreen changes, and can
follow decoded video dimensions through `aspectRatio: "video"`.

The active optional control overlay is implemented under `src/control/` and is
created by `TeslaPlayer` when `controls: true`. It is shared by all playback
engines; Jessibuca's internal controls stay disabled to prevent duplicate UI.

Current controls include play/pause, stop, VOD seek, elapsed/duration time,
mute/volume, screenshot, and fullscreen. The bar auto-hides while playing and
supports keyboard shortcuts (Space/K, M, F, Left/Right) plus double-click
fullscreen. Controls call public `TeslaPlayer` methods and never manipulate
Worker, decoder, audio, or renderer internals directly.
