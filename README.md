# motes

[![CI](https://github.com/bcwatson22/motes/actions/workflows/ci.yml/badge.svg)](https://github.com/bcwatson22/motes/actions/workflows/ci.yml)
![Coverage 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)

A drifting particle field for a canvas, in about 4KB. The simulation is written
in Rust and compiled to WebAssembly; the drawing stays in JavaScript.

```bash
npm i motes
```

```js
import { createField } from 'motes';

const field = await createField(document.querySelector('canvas'), {
  color: '#ffffff',
});

// later
field.destroy();
```

There is no asset to host and no path to configure — the compiled module is
inlined into the package.

## Options

| Option    | Default  |                                                                                                                               |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `color`   | required | Any CSS colour. `var(--brand-blue)`, `oklch(...)` and keywords all work — it is resolved against the document before drawing. |
| `opacity` | `0.3`    | How solid a particle is at rest. Worth raising on a light background; see below.                                              |

`createField` resolves to `{ destroy }`. Call it on unmount: it cancels the
animation frame and removes the window listeners.

The canvas is sized from its own `clientWidth` and `clientHeight`, with the
backing store scaled by `devicePixelRatio`, so give it dimensions in CSS and it
will be sharp on a retina display.

## How it works

Rust owns the simulation, JavaScript owns the drawing.

The module keeps `[x, y, vx, vy, bubble]` per particle in one flat block of its
own linear memory and exposes a pointer to it. JavaScript lays a `Float32Array`
over that same memory and reads it directly each frame — one `tick()` call, then
ordinary canvas arcs.

That split is the whole design. Calling into WebAssembly once per particle is
what makes naive ports slower than the JavaScript they replace; calling in once
per _frame_ and reading a buffer is what makes this worth doing at all.

**There is no `wasm-bindgen`.** The entire interface is a pointer and a handful
of floats, which `extern "C"` expresses directly. Bindings would add a code
generator, a directory of generated glue and a build step to say what five
exported functions already say. The module is 4KB because of that, not in spite
of it.

## Some numbers, honestly

The simulation is not why this is fast. Benchmarked against the same loop in
hand-written JavaScript, at 296 particles:

|                      | per frame |
| -------------------- | --------- |
| JavaScript `tick()`  | 0.79µs    |
| WebAssembly `tick()` | 0.57µs    |

That is a real speedup on **0.005% of a 60fps frame budget**. The bottleneck is
the few hundred `arc()` calls, and those are identical either way. If you are
choosing this over a few hundred lines of your own JavaScript, choose it for the
size and for not writing it — not for the arithmetic.

The module is inlined as base64, which costs about 680 bytes gzipped over
fetching it separately. That trade is right at 4KB and would be indefensible at
200KB.

## Two things that will surprise you

**The particle count is not the number you pass.** `count` is scaled by canvas
area against a 1920×1080 reference, so a 1280×800 canvas gets about half of it.
This matches the convention the effect was ported from, and means a field looks
about as dense on a phone as on a desktop rather than becoming soup.

**A dark colour at the default opacity looks grey.** Brand blue at `0.3` over a
near-white page composites to 14% saturation, against the colour's own 73%. On a
light background raise `opacity` to somewhere near `0.55`. The bubble opacity is
derived as twice the resting value, so it follows.

## Content Security Policy

Instantiating WebAssembly is a form of code generation, so a page with a CSP
needs to allow it:

```
script-src 'self' 'wasm-unsafe-eval';
```

`'wasm-unsafe-eval'` rather than `'unsafe-eval'` — the narrow grant permits
WebAssembly without permitting `eval()` across the whole page.

## Development

```bash
pnpm install
pnpm verify        # lint, format, types, coverage, build
```

Changing the simulation needs a Rust toolchain with the wasm target:

```bash
rustup target add wasm32-unknown-unknown
pnpm wasm          # rebuilds src/wasm.ts — commit the result
```

`src/wasm.ts` is generated and committed, so nobody installing this package
needs Rust. CI rebuilds it and fails if it has drifted from the crate.

The simulation is tested in Rust with `cargo test`; the drawing half is tested
in vitest, at 100% coverage. Both run in CI.

## Licence

MIT
