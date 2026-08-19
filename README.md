# Motes

[![CI](https://github.com/bcwatson22/motes/actions/workflows/ci.yml/badge.svg)](https://github.com/bcwatson22/motes/actions/workflows/ci.yml)
![Coverage 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)

A drifting particle field for a canvas, in about 4KB. The simulation is written in [Rust](https://www.rust-lang.org/) and compiled to [WebAssembly](https://webassembly.org/); the drawing stays in [TypeScript](https://www.typescriptlang.org/). Built for [engaging.engineering](https://www.engaging.engineering), where it replaced a general-purpose particle engine and took 14% off the site's client JavaScript.

To use it, run `npm i motes` — there is no asset to host and no path to configure, because the compiled module is inlined into the package.

```js
import { createField } from 'motes';

const field = await createField(document.querySelector('canvas'), {
  color: '#ffffff',
});

// on unmount
field.destroy();
```

## Options

<table>
  <tr>
    <td width="120"><code>color</code></td>
    <td>
      Required. Any CSS colour — <code>var(--brand-blue)</code>, <code>oklch(...)</code> and keywords all work, because the value is resolved against the document before drawing rather than parsed.
    </td>
  </tr>
  <tr>
    <td width="120"><code>opacity</code></td>
    <td>
      Defaults to <code>0.3</code>. How solid a particle is at rest. Worth raising on a light background — see below.
    </td>
  </tr>
  <tr>
    <td width="120"><code>respectReducedMotion</code></td>
    <td>
      Defaults to <code>true</code>. Set it false only if the animation is genuinely essential rather than decorative — see <a href="#accessibility">Accessibility</a>.
    </td>
  </tr>
</table>

`createField` resolves to `{ destroy }`. Call it on unmount: it cancels the animation frame and removes the window listeners. The canvas is sized from its own `clientWidth` and `clientHeight` with the backing store scaled by `devicePixelRatio`, so give it dimensions in CSS and it will be sharp on a retina display.

## Stack

### Rust

<table>
  <tr>
    <td width="58">
      <img src="https://cdn.simpleicons.org/rust" alt="Rust icon" width="32" />
    </td>
    <td>
      The simulation — spawn, drift, edge wrapping, and the pointer bubble. It writes what the canvas needs rather than what the simulation thinks in: each particle's final radius and alpha, already interpolated, so the drawing half recomputes nothing.
    </td>
  </tr>
</table>

### WebAssembly

<table>
  <tr>
    <td width="58">
      <img src="https://cdn.simpleicons.org/webassembly" alt="WebAssembly icon" width="32" />
    </td>
    <td>
      The module keeps <code>[x, y, vx, vy, radius, alpha]</code> per particle in its own linear memory and exposes a pointer to it. JavaScript lays a <code>Float32Array</code> over that same memory and reads it directly — one <code>tick()</code> call per frame, then ordinary canvas arcs. Calling into WebAssembly once per <em>particle</em> is what makes naive ports slower than the JavaScript they replace.
    </td>
  </tr>
</table>

### TypeScript

<table>
  <tr>
    <td width="58">
      <img src="https://cdn.simpleicons.org/typescript" alt="TypeScript icon" width="32" />
    </td>
    <td>
      The drawing half: instantiate, size the canvas, track the pointer, run the loop. Deliberately no <code>wasm-bindgen</code> — the whole interface is a pointer and a handful of floats, which <code>extern "C"</code> expresses directly. Bindings would add a code generator, a directory of generated glue and a build step to say what six exported functions already say.
    </td>
  </tr>
</table>

### Vitest

<table>
  <tr>
    <td width="58">
      <img src="https://cdn.simpleicons.org/vitest" alt="Vitest icon" width="32" />
    </td>
    <td>
      100% coverage of the drawing half, with the module mocked out. The simulation is tested where it is written, in Rust, with <code>cargo test</code>. Both run in CI, along with a job that rebuilds the committed artifact and fails if it has drifted from the crate.
    </td>
  </tr>
</table>

## Some numbers, honestly

The simulation is not why this is small. Benchmarked against the same loop in hand-written JavaScript, at 296 particles:

<table>
  <tr>
    <td width="180">JavaScript <code>tick()</code></td>
    <td>0.79µs per frame</td>
  </tr>
  <tr>
    <td width="180">WebAssembly <code>tick()</code></td>
    <td>0.57µs per frame</td>
  </tr>
</table>

That is a real speedup on **0.005% of a 60fps frame budget**. The bottleneck is the few hundred `arc()` calls, and those are identical either way. If you are weighing this against a couple of hundred lines of your own JavaScript, choose it for the size and for not writing it — not for the arithmetic.

The module is inlined as base64, which costs about 680 bytes gzipped over fetching it separately. That trade is right at 4KB and would be indefensible at 200KB.

## Two things that will surprise you

**The particle count is not the number you pass.** It is scaled by canvas area against a 1920×1080 reference, so a 1280×800 canvas gets about half of it. This matches the convention the effect was ported from, and means a field looks about as dense on a phone as on a desktop rather than becoming soup.

**A dark colour at the default opacity looks grey.** Brand blue at `0.3` over a near-white page composites to 14% saturation, against the colour's own 73%. On a light background raise `opacity` to somewhere near `0.55`; the bubble follows, being derived as twice the resting value.

## Accessibility

**The field honours `prefers-reduced-motion` by default.** Where someone has
asked their system for less motion, it draws a single frame and never starts the
animation loop — the particles are there, they are simply still. The guidance is
to remove the motion rather than the content, and an empty canvas is a missing
feature rather than a considerate one.

It subscribes rather than reading the preference once, so changing the setting
with the page open stops or starts the field without a reload.

Pass `respectReducedMotion: false` to opt out. There are cases where an
animation carries meaning and removing it removes information — but a drifting
background is not one of them, so the default is on and the escape hatch is
explicit.

The canvas itself carries no information, so give it `aria-hidden="true"` and
keep it out of the accessibility tree:

```html
<canvas aria-hidden="true"></canvas>
```

## Content Security Policy

Instantiating WebAssembly is a form of code generation, so a page with a CSP needs to allow it:

```
script-src 'self' 'wasm-unsafe-eval';
```

`'wasm-unsafe-eval'` rather than `'unsafe-eval'` — the narrow grant permits WebAssembly without permitting `eval()` across the whole page.

## Development

To get it running locally, run `pnpm i` and then `pnpm verify` to run lint, format, types, coverage and the build — the same set CI runs.

Changing the simulation needs a Rust toolchain with the wasm target:

```bash
rustup target add wasm32-unknown-unknown
pnpm wasm
```

That rebuilds `src/wasm.ts` — commit the result. It is generated and committed so nobody installing this package needs Rust, and CI fails if it has drifted from the crate.

## Licence

MIT
