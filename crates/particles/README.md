# particles

The simulation behind the site's background field, compiled to WebAssembly.

## What it does, and what it deliberately does not

Rust owns the **simulation**; JavaScript owns the **drawing**. The state is one
flat `f32` buffer in linear memory — `[x, y, vx, vy, bubble]` per particle — and
the canvas component reads it directly each frame and issues its own `arc()`
calls. Nothing crosses the WASM boundary per particle.

That split is the whole point. Calling into WASM once per draw is what makes
naive ports slower than the JavaScript they replace; calling in once per _frame_
and reading a buffer is what makes this cheaper.

**There is no `wasm-bindgen` and no `wasm-pack`.** The entire interface is a
pointer and a handful of `f32`s, which `extern "C"` expresses directly. Adding
bindings would mean a code generator, a `pkg/` directory of generated glue to
commit, lint and coverage ignore rules for that generated code, and a build step
— to express what five exported functions already say. The module is 3.4KB
because of this, not in spite of it.

## Interface

| Export                                                           | Purpose                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `configure(count, speed, radius, bubble_range, bubble_duration)` | Set the constants. Call once, before `resize`.                                   |
| `resize(width, height)`                                          | Reflow to a canvas size. Keeps existing particles and spawns only the shortfall. |
| `tick(dt, pointer_x, pointer_y)`                                 | Advance one frame.                                                               |
| `data_ptr()` / `count()` / `stride()`                            | Locate the buffer for a `Float32Array` view.                                     |

Memory is never grown — the buffer is allocated at `MAX` up front. A
`Float32Array` over `memory.buffer` detaches silently if the module grows its
memory, and reads zeros from then on; not growing removes that failure mode
rather than working around it.

## Building

```bash
pnpm wasm
```

Compiles to `wasm32-unknown-unknown` and emits `src/wasm.ts`, the module inlined
as base64. Inlining costs about 680 bytes gzipped and buys a package with no
asset to host, no path to configure and no second request — `npm i` is the whole
integration. That trade is right at 4KB and would be indefensible at 200KB.

**The generated file is committed.** Neither this package's CI nor anyone
installing it needs a Rust toolchain — the trade is that `src/wasm.ts` must be
rebuilt and committed whenever `src/lib.rs` changes. Building it during
`npm install` instead would put a Rust toolchain in the way of every consumer,
for a crate that changes about never.

You need a Rust toolchain with the wasm target to rebuild:

```bash
rustup target add wasm32-unknown-unknown
```

## Tests

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The simulation is tested here, in Rust. The package's own tests cover the
JavaScript half — that the module is instantiated, that the buffer is read, that
the canvas calls come out right — and mock this module out entirely.

`no_std` applies to the wasm target only, so the host build that `cargo test`
produces links against std and uses the ordinary test harness.
