# Motes

[![CI](https://github.com/bcwatson22/motes/actions/workflows/ci.yml/badge.svg)](https://github.com/bcwatson22/motes/actions/workflows/ci.yml)
![Coverage 100%](https://img.shields.io/badge/coverage-100%25-2EBB4F?labelColor=343B42)

A drifting particle field for a canvas, in 4.3KB gzipped. The simulation is written in [Rust](https://www.rust-lang.org/) and compiled to [WebAssembly](https://webassembly.org/); the drawing stays in [TypeScript](https://www.typescriptlang.org/). Built for [engaging.engineering](https://www.engaging.engineering), where it replaced a general-purpose particle engine and took 14% off the site's client JavaScript.

To use it, run `npm i @bcwatson22/motes` — there is no asset to host and no path to configure, because the compiled module is inlined into the package.

```js
import { createField } from '@bcwatson22/motes';

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
    <td width="120"><code>count</code></td>
    <td>
      Defaults to <code>600</code>. Scaled by canvas area against a 1920&times;1080 reference, so it is not the number that appears on screen — see below.
    </td>
  </tr>
  <tr>
    <td width="120"><code>speed</code></td>
    <td>Defaults to <code>0.25</code>. Pixels per frame at 60fps, scaled by the real frame time.</td>
  </tr>
  <tr>
    <td width="120"><code>size</code></td>
    <td>Defaults to <code>2.2</code>. A particle's radius at rest.</td>
  </tr>
  <tr>
    <td width="120"><code>bubbleSize</code></td>
    <td>Defaults to <code>4</code>. What it grows to directly under the pointer.</td>
  </tr>
  <tr>
    <td width="120"><code>bubbleDistance</code></td>
    <td>Defaults to <code>175</code>. How far the pointer's influence reaches, in CSS pixels.</td>
  </tr>
  <tr>
    <td width="120"><code>respectReducedMotion</code></td>
    <td>
      Defaults to <code>true</code>. Set it false only if the animation is genuinely essential rather than decorative — see <a href="#accessibility">Accessibility</a>.
    </td>
  </tr>
</table>

### Changing settings while it runs

`createField` resolves to `{ update, destroy }`.

```js
field.update({ speed: 1.5, color: 'var(--brand-blue)' });
```

`update` merges into the current settings, so anything you leave out stays as
it was, and a value passed as `undefined` is ignored rather than blanking a
default — which is what a caller spreading optional props usually means.

Everything but `count` applies on the very next frame with **no respawn**,
because the simulation reads these values every tick rather than baking them
into each particle. `count` is the exception: it decides how many particles
exist, so changing it spawns the shortfall or drops the surplus.

That makes `update` the right tool for a control someone drags. Destroying and
recreating the field on every input event restarts the animation on every pixel
of the drag; this does not.

`destroy` cancels the animation frame and removes the window listeners. Call it on unmount.

The field follows the window on its own: resizing reflows it, carrying the particles already on the canvas into the new box in proportion and spawning whatever the new area calls for. There is no need to debounce that or to recreate the field — it is a multiply per particle. The canvas is sized from its own `clientWidth` and `clientHeight` with the backing store scaled by `devicePixelRatio`, so give it dimensions in CSS and it will be sharp on a retina display.

## Usage with React

The package ships no React binding, and deliberately: the whole interface is one
function that takes a canvas, and wrapping it costs about forty lines. Those
forty lines are below rather than in the dependency tree, because a React entry
point would double the surface area and the release burden of a package this
size.

This is what the site it was built for actually runs.

```tsx
'use client';

import { createField, type Field } from '@bcwatson22/motes';
import { useEffect, useRef } from 'react';

const ParticlesCanvas = ({ color = '#ffffff' }: { color?: string }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    /* These two cover different races. `field` is what the cleanup destroys
       when the component unmounts normally; `cancelled` is what stops a field
       that arrives after the cleanup has already run. */
    let field: Field | undefined;
    let cancelled = false;

    createField(ref.current, { color })
      .then((created) => {
        /* Unmounted while the module was still instantiating. Without this the
           field runs on with nothing holding a reference to stop it. */
        if (cancelled) {
          created.destroy();

          return;
        }

        /* Kept so the cleanup below has something to destroy. Assigned in
           one closure and read in another, which is why it can look unused. */
        field = created;
      })
      /* Not worth an error boundary: the page is correct without a decorative
         background. */
      .catch(() => {});

    return () => {
      cancelled = true;
      field?.destroy();
    };
  }, [color]);

  /* Decoration, so there is nothing here to announce. */
  return <canvas ref={ref} aria-hidden="true" />;
};

export { ParticlesCanvas };
```

The two variables are the part worth copying, because they cover different
races and neither covers the other:

<table>
  <tr>
    <td width="230"><strong>Unmounted before it resolves</strong></td>
    <td>Cleanup runs first, so <code>field</code> is still undefined and destroys nothing. The promise then resolves, sees <code>cancelled</code>, and destroys immediately. A route change or a Suspense boundary resolving will do this.</td>
  </tr>
  <tr>
    <td width="230"><strong>Unmounted after it resolves</strong></td>
    <td>Cleanup calls <code>field.destroy()</code> on the handle. This is the common case, since most unmounts happen long after mount.</td>
  </tr>
</table>

Drop the assignment and the second case leaks: the field starts its animation
loop and the component goes away with nothing holding a reference to stop it.
Drop the flag and the first case leaks the same way. Both are needed.

### Using a ref instead

A `useRef` works too, and is equivalent for this component:

```tsx
const fieldRef = useRef<Field | null>(null);

useEffect(() => {
  if (!ref.current) return;

  let cancelled = false;

  createField(ref.current, { color })
    .then((created) => {
      if (cancelled) {
        created.destroy();

        return;
      }

      fieldRef.current = created;
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    fieldRef.current?.destroy();
    /* Cleared, unlike the `let`. A ref outlives the effect, so a stale handle
       would survive into the next run. */
    fieldRef.current = null;
  };
}, [color]);
```

Note it still needs `cancelled` — a ref does nothing about the pre-resolution
race — and it adds an obligation to null the ref on the way out. So for a
component that only creates and destroys, the plain `let` is less to get wrong.

The ref earns its keep the moment something _outside_ the effect needs the
field: a control that changes its options, a button that pauses it, anything
that has to reach the handle from an event. Then a local variable is not
enough, because nothing outside the effect can see it.

The canvas needs dimensions from CSS. `position: fixed; inset: 0` for a
full-page background, or any sized box for a contained one; the field reads
`clientWidth` and `clientHeight` and scales its backing store to match.

### Deferring it

A decorative background should not compete with the page for the main thread
while that page is still painting. The site gates the canvas behind
`requestIdleCallback`, so both the work and the module land after the page is
interactive:

```tsx
'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

const ParticlesCanvas = dynamic(() => import('./ParticlesCanvas'), {
  ssr: false,
});

const Particles = () => {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    /* Safari only shipped requestIdleCallback in 18.4, hence the fallback. The
       timeout is the backstop for a browser that never goes idle. */
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(() => setIsReady(true), {
        timeout: 2000,
      });

      return () => window.cancelIdleCallback(handle);
    }

    const handle = window.setTimeout(() => setIsReady(true), 200);

    return () => window.clearTimeout(handle);
  }, []);

  return isReady ? <ParticlesCanvas /> : null;
};

export { Particles };
```

### Following the colour scheme

`color` is read once per field, so changing it means recreating one — which
`useEffect` already does if you put it in the dependencies. Subscribe to the
media query rather than reading it once, or the field will keep whichever scheme
was in force at mount:

```tsx
const query = '(prefers-color-scheme: dark)';

const subscribe = (onChange: () => void) => {
  const list = window.matchMedia(query);

  list.addEventListener('change', onChange);

  return () => list.removeEventListener('change', onChange);
};

const isDark = useSyncExternalStore(
  subscribe,
  () => window.matchMedia(query).matches,
  /* Server snapshot. Never reaches the screen — the canvas is painted after
     mount — so it only has to be stable. */
  () => true,
);
```

Reduced motion needs no equivalent: the package honours it itself, and keeps
following it while the page is open. See [Accessibility](#accessibility).

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

The module is inlined as base64, which costs about 680 bytes gzipped over fetching it separately. That trade is right at this size and would be indefensible at 200KB.

For the avoidance of the usual ambiguity about what a size claim covers:

<table>
  <tr>
    <td width="260">The WebAssembly module</td>
    <td>4,026 bytes</td>
  </tr>
  <tr>
    <td width="260">What you install, minified</td>
    <td>9,171 bytes</td>
  </tr>
  <tr>
    <td width="260"><strong>What you ship, gzipped</strong></td>
    <td><strong>4,323 bytes</strong></td>
  </tr>
</table>

The headline number is the last one, because it is the one that reaches a
browser. Inlined base64 does not compress as well as the raw module it encodes,
which is why the middle row is more than double the first.

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
