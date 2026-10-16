# FrameEase

[![jsDelivr](https://data.jsdelivr.com/v1/package/npm/frame-ease/badge)](https://www.jsdelivr.com/package/npm/frame-ease)
[![license](https://img.shields.io/npm/l/frame-ease)](LICENSE)

![FrameEase GUI](https://cdn.jsdelivr.net/npm/frame-ease@0.1.1/docs/frame-ease.gif)

[日本語](README.ja.md) | [About](#about) | [Why FrameEase?](#why-frameease) | [Getting started](#getting-started) | [API](#api) | [Options](#options) | [Limitations](#limitations)

## About

An easing library for creative coding.
Pass `frameCount` and get the value for that moment. Loops, back-and-forth and waits are all worked out for you.

- [p5.js Web Editor](https://editor.p5js.org/yuta.aoki31/sketches/coVE5pLmj)

## Why FrameEase?

### ⏱ Runs on frameCount alone

Time is counted in frames. No tweens to create, nothing to start or stop.
The same frame always gives the same value, so exported frames never drift.

### 🎛 Tune it by eye

Move the points of the curve in the GUI and the sketch changes right away.
When it looks right, copy and paste it into sketch.js.

### 🪶 Light when you publish

Swap in `frame-ease.core.min.js`, which has no GUI, only the math.
The values you pasted keep working.

## Getting started

### Installation

```html
<script src="https://cdn.jsdelivr.net/npm/frame-ease@0.1.1/frame-ease.min.js"></script>
```

### Usage

```js
// ---- frame-ease state ----
FrameEase.importState({
  move: { duration: 60, loopDelay: 30, stagger: 6, loop: true, alternate: true },
});
// ---- frame-ease state end ----

const N = 8; // number of circles
let move;

function setup() {
  createCanvas(600, 400);
  move = FrameEase('move');
  FrameEase.gui();
}

function draw() {
  background(20);
  noStroke();
  fill(240);
  for (let i = 0; i < N; i++) {
    const x = lerp(60, width - 60, move(frameCount - 1, { index: i }));
    const y = map(i, 0, N - 1, 60, height - 60);
    circle(x, y, 24);
  }
}
```

Press E to show or hide the GUI. Double-click to add a point, drag to move it.

That's it 🎉

### GUI controls

#### Show / hide

Press E. It works wherever the pointer is. It does nothing while Shift is held or while you are typing in a text field.
Use `FrameEase.gui({ key: 'g' })` to pick another key.
This is the only key that works while the panel is minimized.

#### Curve

| Action | Result |
|---|---|
| Double-click an empty spot on the graph | Add a point there |
| Drag a point | Move it. Shift locks to horizontal or vertical. The start point is fixed; the end point moves only vertically |
| Right-click a point | Delete it (the end points can't be deleted) |
| Drag a handle | Change the slope. Alt changes one side only |
| Double-click a handle | Reset the slope to auto |

#### Values

| Action | Result |
|---|---|
| Drag a section of the strip sideways | Change the value. Shift steps by 10 |
| Click a number | Type a value. ↑↓ step by 1, Shift by 10. Enter to confirm, Esc to cancel |

#### Keys (with the pointer over the panel)

| Key | Result |
|---|---|
| 1–9 | Switch easings |
| Delete / Backspace | Delete the selected point (the end points can't be deleted) |
| ← → ↑ ↓ | Move the selected point by 0.01. Shift by 0.1. The end point moves only with ↑↓ |
| Esc | Deselect the point |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Shift + Z, Ctrl/Cmd + Y | Redo |

#### Playback (p5.js global mode only)

| Action | Result |
|---|---|
| Space (with the pointer over the panel) | Pause / resume |
| ← → (while paused, with no point selected) | Step 1 frame. Shift steps 10 |
| Drag the playhead triangle | Pause and scrub to any frame. While paused, you can grab anywhere on the line |

Only `frameCount` stops. Anything driven by `deltaTime` or `millis()` keeps running.

## API

### `FrameEase(name)`

Creates an easing. Its values are read from `FrameEase.importState()`.

### `move(frame)`

The value at that frame. Goes from 0 to 1. Some curves go above 1 or below 0.

p5.js's `frameCount` starts at 1, so write `move(frameCount - 1)` to start from 0.

To run in seconds, use `move(millis() / (1000 / getTargetFrameRate()))`.

### `move(frame, { index, between })`

`index` shifts the timing by `stagger` frames per index.
`between` interpolates between two curves. 0 is the first curve, 1 the second. Timing settings are shared. Make the second curve in the GUI.

```js
move(frameCount, { index: i });                  // shift timing along a row
move(frameCount, { index: i, between: i / 9 });  // change the shape along a row too
move(frameCount, { between: mouseX / width });   // change the shape with the mouse
```

### `move.curve(t)`

The value of the curve at t (0–1).

### `FrameEase.gui()`

Shows the GUI. Remove this line when you publish.

### `FrameEase.importState(state)`

Write the values here. This is the shape the GUI's copy button gives you.
You can also write it by hand. The keys are listed under Options.

```js
// ---- frame-ease state ----
FrameEase.importState({
  move: { duration: 60, loopDelay: 20, loop: true, alternate: true, points: '.4 .35, .7 1.06' }
});
// ---- frame-ease state end ----
```

The sketch always runs on the values in the code. Reload without pasting and you get the old values back.

## Options

Keys you write in `importState`.

| Name | Default | Description |
|---|---|---|
| `duration` | `60` | Length of the motion in frames |
| `delay` | `0` | Frames to wait before the first run only |
| `loopDelay` | `0` | Frames to hold after each run |
| `stagger` | `0` | Frames to shift per `index` |
| `loop` | `false` | Repeat |
| `alternate` | `false` | `true` goes back and forth. `'mirror'` uses the point-symmetric curve on the way back |
| `points` | `''` | Points in between, as `'x y, x y'` |
| `startSlope` | auto | Slope at the start |
| `endSlope` | auto | Slope at the end |
| `endY` | `1` | Value at the end |
| `between` | none | The second curve |

### Files

| File | Description |
|---|---|
| `frame-ease.min.js` | With GUI. For working on a piece |
| `frame-ease.core.min.js` | Without GUI. For published pieces |
| `frame-ease.js` | Not minified |

## Limitations

- Time is counted in frames, so if the frame rate drops, the motion takes longer
- Works without p5.js. Multiply seconds by 60 and pass that (`move(seconds * 60)`)
- Pause, frame stepping and scrubbing work only in p5.js global mode

## License

MIT. The curve presets in the GUI are based on Robert Penner's Easing Equations (BSD-3-Clause). See [LICENSE](LICENSE).
