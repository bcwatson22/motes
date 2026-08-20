//! Particle simulation for the site's background field.
//!
//! Rust owns the simulation; JavaScript owns the drawing. The state lives in
//! one flat `f32` buffer in linear memory, and JS reads it directly each frame
//! and issues the canvas calls itself. Nothing crosses the boundary per
//! particle, which is what makes this cheaper than calling into WASM to draw.
//!
//! The buffer holds what the canvas needs rather than what the simulation
//! thinks in: a particle's final radius and alpha, already interpolated. The
//! drawing half reads four numbers and issues an arc, and every sum lives on
//! this side of the boundary.
//!
//! There is deliberately no `wasm-bindgen` here. The whole interface is a
//! pointer and a handful of numbers, so bindings would add a code generator,
//! a build step and a JS glue file to express what five `extern "C"` functions
//! already say.

// no_std on the wasm target only. Host builds — which is what `cargo test`
// produces — keep std, so the test harness links normally.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

/// `[x, y, vx, vy, radius, alpha]` per particle. The velocities are the
/// simulation's own business; the drawing half reads 0, 1, 4 and 5.
const STRIDE: usize = 6;

/// Ceiling on the buffer. Linear memory is never grown: a `Float32Array` view
/// over `memory.buffer` silently detaches if it is, and reads zeros from then
/// on. Allocating for the worst case is a few hundred kilobytes and removes
/// that failure mode entirely.
const MAX: usize = 8192;

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = core::f32::consts::TAU;

/// Any non-zero constant. xorshift degenerates to all-zeroes if seeded with 0.
const INITIAL_SEED: u32 = 0x9e37_79b9;

/// The reference area tsparticles scales its particle count against.
const DENSITY_WIDTH: f32 = 1920.0;
const DENSITY_HEIGHT: f32 = 1080.0;

struct State {
    data: [f32; MAX * STRIDE],
    count: usize,
    width: f32,
    height: f32,
    seed: u32,
    configured: f32,
    speed: f32,
    size: f32,
    bubble_size: f32,
    opacity: f32,
    bubble_opacity: f32,
    bubble_range: f32,
}

/// `UnsafeCell` rather than `static mut`: the latter now trips `static_mut_refs`
/// on every access, and the workarounds for that trip clippy's `deref_addrof`
/// in turn. This says the same thing without arguing with either lint.
struct Shared(core::cell::UnsafeCell<State>);

// Single-threaded by construction: WebAssembly on the main thread, one
// instance per page. There is no second thread to race with.
unsafe impl Sync for Shared {}

/// Every field is zero so the whole static lands in `.bss`, which WebAssembly
/// zeroes at instantiation for free. A single non-zero field here would force
/// the entire struct — the 160KB buffer included — to be emitted as a data
/// segment in the `.wasm`. The seed is therefore established by `configure`
/// rather than declared here.
static STATE: Shared = Shared(core::cell::UnsafeCell::new(State {
    data: [0.0; MAX * STRIDE],
    count: 0,
    width: 0.0,
    height: 0.0,
    seed: 0,
    configured: 0.0,
    speed: 0.0,
    size: 0.0,
    bubble_size: 0.0,
    opacity: 0.0,
    bubble_opacity: 0.0,
    bubble_range: 0.0,
}));

#[allow(clippy::mut_from_ref)]
fn state() -> &'static mut State {
    unsafe { &mut *STATE.0.get() }
}

/// xorshift32. Deterministic from a fixed seed, so a given viewport always
/// produces the same field — which is what makes the simulation assertable in
/// a test rather than only observable on screen.
fn random(s: &mut State) -> f32 {
    s.seed ^= s.seed << 13;
    s.seed ^= s.seed >> 17;
    s.seed ^= s.seed << 5;
    (s.seed as f32) / 4_294_967_296.0
}

/// A fully bubbled particle is twice as solid as one at rest — the pair the
/// effect was ported from was 0.3 and 0.6. Derived rather than configured
/// separately, so raising one cannot silently invert the relationship.
fn bubble_opacity_for(opacity: f32) -> f32 {
    let doubled = opacity * 2.0;

    if doubled > 1.0 {
        1.0
    } else {
        doubled
    }
}

/// Set the constants. Called once from JS before `resize`.
///
/// The drawing values — size and opacity, and what they become under the
/// pointer — live here rather than on the JavaScript side because interpolating
/// between them is per-particle, per-frame arithmetic. Doing it here means the
/// drawing half reads a finished radius and alpha instead of recomputing them
/// for every particle on every frame.
#[no_mangle]
pub extern "C" fn configure(
    configured: f32,
    speed: f32,
    size: f32,
    bubble_size: f32,
    opacity: f32,
    bubble_range: f32,
) {
    let s = state();

    s.configured = configured;
    s.speed = speed;
    s.size = size;
    s.bubble_size = bubble_size;
    s.opacity = opacity;
    s.bubble_opacity = bubble_opacity_for(opacity);
    s.bubble_range = bubble_range;

    /* Seeded once, on the first call. configure is how settings change while
    a field is running, and re-seeding there would make every later spawn
    repeat the same positions the first ones took. */
    if s.seed == 0 {
        s.seed = INITIAL_SEED;
    }
}

/// How many particles a canvas of this size gets.
///
/// tsparticles scales the configured count by canvas area over a 1920x1080
/// reference (`ParticlesManager.js`), so the configured number is never the
/// rendered number. Its formula divides by `pixelRatio` squared against a
/// backing-store size, which cancels — leaving plain CSS-pixel area.
fn scaled_count(width: f32, height: f32, configured: f32) -> usize {
    let factor = (width * height) / (DENSITY_WIDTH * DENSITY_HEIGHT);
    let scaled = configured * factor;

    if scaled < 0.0 {
        return 0;
    }

    let n = scaled as usize;

    if n > MAX {
        MAX
    } else {
        n
    }
}

/// `direction: 'none'` means a particle drifts along a fixed random bearing,
/// so spawning needs one sine and one cosine each. `libm` is a dependency and a
/// few kilobytes to provide that; a Bhaskara-style approximation is a dozen
/// lines and is accurate to about half a percent, which is indistinguishable
/// once it has been multiplied by a speed of 0.25.
fn sin(x: f32) -> f32 {
    // Wrap to [-PI, PI].
    let mut a = x;

    while a > PI {
        a -= TAU;
    }
    while a < -PI {
        a += TAU;
    }

    let b = 4.0 / PI;
    let c = -4.0 / (PI * PI);
    let y = b * a + c * a * abs(a);

    // Second pass; without it the error is nearer 5%.
    0.225 * (y * abs(y) - y) + y
}

fn cos(x: f32) -> f32 {
    sin(x + PI / 2.0)
}

/// Newton's method from a bit-hack seed. `f32::sqrt` lives on std's impl and
/// is unavailable under no_std, and the bubble needs true distance rather than
/// squared distance — a falloff computed on d² bunches far too tightly around
/// the pointer.
fn sqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }

    let seed = 0x1fbd_1df5 + (x.to_bits() >> 1);
    let mut y = f32::from_bits(seed);

    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);

    y
}

fn abs(x: f32) -> f32 {
    if x < 0.0 {
        -x
    } else {
        x
    }
}

/// tsparticles advances by `speed` per frame at 60fps rather than per second,
/// so a delta in milliseconds is scaled to sixtieths of a second to match.
const FRAME_MS: f32 = 1000.0 / 60.0;

/// Advance the field by `dt` milliseconds.
///
/// `out_mode: 'out'` — a particle that leaves the canvas re-enters from the
/// opposite edge, offset by its radius so it slides in rather than appearing
/// mid-frame.
#[no_mangle]
pub extern "C" fn tick(dt: f32, pointer_x: f32, pointer_y: f32) {
    let s = state();

    let step = dt / FRAME_MS;
    let r = s.size;
    let w = s.width;
    let h = s.height;

    let range = s.bubble_range;
    let range_squared = range * range;

    let mut i = 0;

    while i < s.count {
        let o = i * STRIDE;

        let travel = s.speed * step;
        let mut x = s.data[o] + s.data[o + 2] * travel;
        let mut y = s.data[o + 1] + s.data[o + 3] * travel;

        if x < -r {
            x = w + r;
        } else if x > w + r {
            x = -r;
        }

        if y < -r {
            y = h + r;
        } else if y > h + r {
            y = -r;
        }

        s.data[o] = x;
        s.data[o + 1] = y;

        /* 0 at rest, 1 directly under the pointer, falling off linearly with
        distance across the bubble radius.

        Recomputed from the pointer every frame rather than eased toward a
        target over time: the hover bubble tracks the pointer, so it has to
        land the moment the pointer arrives. Easing it over the configured
        `duration` made the field take two seconds to respond, which reads
        as nothing happening. */
        let dx = x - pointer_x;
        let dy = y - pointer_y;
        let distance_squared = dx * dx + dy * dy;

        let bubble = if distance_squared < range_squared {
            1.0 - sqrt(distance_squared) / range
        } else {
            0.0
        };

        /* Interpolated here rather than handed over as a progress value for
        the drawing half to expand. It is two multiply-adds per particle per
        frame either way, and this side is the one compiled for it. */
        s.data[o + 4] = s.size + (s.bubble_size - s.size) * bubble;
        s.data[o + 5] = s.opacity + (s.bubble_opacity - s.opacity) * bubble;

        i += 1;
    }
}

#[no_mangle]
pub extern "C" fn data_ptr() -> *const f32 {
    state().data.as_ptr()
}

#[no_mangle]
pub extern "C" fn stride() -> usize {
    STRIDE
}

#[no_mangle]
pub extern "C" fn count() -> usize {
    state().count
}

/// Reflow to a new canvas size. Existing particles keep their positions, so a
/// resize does not restart the field; only the shortfall is spawned.
#[no_mangle]
pub extern "C" fn resize(width: f32, height: f32) {
    let s = state();

    /* Existing particles are carried into the new box in proportion, rather
    than left where they were.

    Spawning only the shortfall is what makes this necessary: grow the
    canvas and the particles already on it stay in the region they were
    spawned into, while the newcomers spread over the whole of the larger
    one. The old region ends up holding its own particles plus a share of
    the new, and the space just revealed holds only its share — which reads
    as a field that is denser on one side.

    One multiply each, so there is no reason to defer it to a debounced
    handler: it can run on every resize event and the field simply follows
    the window. */
    if s.count > 0 && s.width > 0.0 && s.height > 0.0 {
        let horizontal = width / s.width;
        let vertical = height / s.height;

        let mut i = 0;

        while i < s.count {
            let o = i * STRIDE;

            s.data[o] *= horizontal;
            s.data[o + 1] *= vertical;

            i += 1;
        }
    }

    s.width = width;
    s.height = height;

    let next = scaled_count(width, height, s.configured);
    let mut i = s.count;

    while i < next {
        let o = i * STRIDE;

        let angle = random(s) * TAU;

        s.data[o] = random(s) * width;
        s.data[o + 1] = random(s) * height;
        /* A unit bearing, with speed applied in `tick` rather than baked in
        here. Baking it means a later change to speed moves only the
        particles spawned after it, which looks like a bug. */
        s.data[o + 2] = cos(angle);
        s.data[o + 3] = sin(angle);
        s.data[o + 4] = s.size;
        s.data[o + 5] = s.opacity;

        i += 1;
    }

    s.count = next;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The module is a single global, and cargo runs tests in parallel — so
    /// every test that touches the simulation has to hold this first.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        // A test that panics mid-way poisons the mutex; the state is reset by
        // the next `reset()` regardless, so the poison carries no information.
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn reset() {
        let s = state();

        s.count = 0;
        /* configure only seeds when this is zero, so a full reset clears it
        first. */
        s.seed = 0;
        // configure re-seeds, so this is a full reset.
        configure(600.0, 0.25, 2.2, 4.0, 0.3, 175.0);
    }

    #[test]
    fn scales_the_count_by_canvas_area() {
        // 1280x800 is 47.4% of the 1920x1080 reference.
        assert_eq!(scaled_count(1280.0, 800.0, 600.0), 296);
        // The reference area itself yields the configured number.
        assert_eq!(scaled_count(1920.0, 1080.0, 600.0), 600);
        // And a degenerate canvas yields nothing rather than panicking.
        assert_eq!(scaled_count(0.0, 0.0, 600.0), 0);
    }

    #[test]
    fn caps_the_count_at_the_buffer_size() {
        assert_eq!(scaled_count(100_000.0, 100_000.0, 600.0), MAX);
    }

    #[test]
    fn spawns_inside_the_canvas() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        let s = state();

        assert_eq!(s.count, 296);

        for i in 0..s.count {
            let o = i * STRIDE;

            assert!((0.0..=1280.0).contains(&s.data[o]));
            assert!((0.0..=800.0).contains(&s.data[o + 1]));
        }
    }

    /// A resize should reflow the field, not restart it.
    #[test]
    fn keeps_existing_particles_across_a_resize() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        let before = state().count;

        resize(1920.0, 1080.0);

        /* Reflowed, not restarted: the field grows to the count the new area
        calls for rather than being thrown away and respawned. */
        assert_eq!(before, 296);
        assert_eq!(state().count, 600);
    }

    /// Spawning only the shortfall would otherwise leave the particles already
    /// on the canvas bunched in the region they were spawned into, and the
    /// space just revealed holding only its share of the newcomers.
    #[test]
    fn carries_existing_particles_into_the_new_box() {
        let _guard = lock();

        reset();
        resize(1000.0, 500.0);

        let s = state();

        // A particle at a known fraction of the way across.
        s.data[0] = 500.0;
        s.data[1] = 250.0;

        resize(2000.0, 1000.0);

        let s = state();

        assert_eq!(s.data[0], 1000.0);
        assert_eq!(s.data[1], 500.0);
    }

    #[test]
    fn spreads_the_whole_field_rather_than_one_half_of_it() {
        let _guard = lock();

        reset();
        resize(600.0, 600.0);

        // Double the width. Half the particles should end up in each half.
        resize(1200.0, 600.0);

        let s = state();
        let mut right = 0;

        for i in 0..s.count {
            if s.data[i * STRIDE] > 600.0 {
                right += 1;
            }
        }

        let share = right as f32 / s.count as f32;

        assert!(
            (share - 0.5).abs() < 0.1,
            "{right} of {} particles landed in the new half",
            s.count
        );
    }

    /// The first resize has no previous box to scale from.
    #[test]
    fn survives_a_first_resize_from_nothing() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        assert_eq!(state().count, 296);
    }

    /// Checked against std's `sin`, which the host build has — the wasm build
    /// is the only one that needs the approximation.
    #[test]
    fn approximates_sine_closely_enough() {
        // Half a percent of full scale. At speed 0.25 that is a positional
        // error under a hundredth of a pixel per frame.
        let cases = [0.0, 0.5, 1.0, PI / 2.0, PI, 4.0, TAU, -1.0, -PI, 12.0];

        for x in cases {
            let error = abs(sin(x) - x.sin());

            assert!(error < 0.005, "sin({x}) was off by {error}");
        }
    }

    #[test]
    fn approximates_cosine_closely_enough() {
        for x in [0.0, 0.5, 1.0, PI / 2.0, PI, 4.0, TAU, -1.0] {
            let error = abs(cos(x) - x.cos());

            assert!(error < 0.005, "cos({x}) was off by {error}");
        }
    }

    /// Bearings are unit vectors, so every particle travels at exactly the
    /// configured speed whatever its direction. A sloppier trig approximation
    /// would make some measurably faster than others.
    #[test]
    fn gives_every_particle_the_same_bearing_magnitude() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        let s = state();

        for i in 0..s.count {
            let o = i * STRIDE;
            let magnitude = (s.data[o + 2].powi(2) + s.data[o + 3].powi(2)).sqrt();

            assert!((magnitude - 1.0).abs() < 0.008, "bearing was {magnitude}");
        }
    }

    /// The reason the bearing is stored rather than the velocity: a change to
    /// speed has to move the particles already on screen, not just the next
    /// ones to spawn.
    #[test]
    fn applies_a_speed_change_to_existing_particles() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        one_particle_at(640.0, 400.0);

        let s = state();
        s.data[2] = 1.0;
        s.data[3] = 0.0;

        tick(FRAME_MS, -1e9, -1e9);
        let slow = state().data[0] - 640.0;

        // Same particle, four times the speed, no respawn.
        configure(600.0, 1.0, 2.2, 4.0, 0.3, 175.0);

        let s = state();
        s.data[0] = 640.0;

        tick(FRAME_MS, -1e9, -1e9);
        let fast = state().data[0] - 640.0;

        assert!((slow - 0.25).abs() < 0.01, "moved {slow}px at speed 0.25");
        assert!((fast - 1.0).abs() < 0.01, "moved {fast}px at speed 1.0");
    }

    /// configure is how a running field changes settings, so calling it twice
    /// must not restart the sequence the spawner draws from.
    #[test]
    fn keeps_its_place_in_the_sequence_across_a_reconfigure() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        let seed_before = state().seed;

        configure(600.0, 0.5, 2.2, 4.0, 0.3, 175.0);

        assert_eq!(state().seed, seed_before);
    }

    #[test]
    fn drifts_at_the_configured_speed() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        let (x, y) = (state().data[0], state().data[1]);

        tick(FRAME_MS, -1e9, -1e9);

        let s = state();
        let moved = ((s.data[0] - x).powi(2) + (s.data[1] - y).powi(2)).sqrt();

        // One frame at speed 0.25 moves a particle 0.25px along its bearing.
        assert!((moved - 0.25).abs() < 0.01, "moved {moved}px in one frame");
    }

    /// dt is milliseconds, so a double-length frame must move twice as far —
    /// otherwise the field speeds up and slows down with the frame rate.
    #[test]
    fn scales_movement_by_the_frame_time() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        let x = state().data[0];
        tick(FRAME_MS, -1e9, -1e9);
        let one = state().data[0] - x;

        reset();
        resize(1280.0, 800.0);
        let x = state().data[0];
        tick(FRAME_MS * 2.0, -1e9, -1e9);
        let two = state().data[0] - x;

        assert!((two - one * 2.0).abs() < 0.001);
    }

    /// `out_mode: 'out'` — off one edge, back on the opposite one.
    #[test]
    fn wraps_a_particle_that_leaves_the_canvas() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        let s = state();

        // Park one just past the left edge, heading further left.
        s.data[0] = -3.0;
        s.data[1] = 400.0;
        s.data[2] = -1.0;
        s.data[3] = 0.0;

        tick(FRAME_MS, -1e9, -1e9);

        // Re-entered from the right, offset by the radius.
        assert!(state().data[0] > 1280.0);
    }

    #[test]
    fn wraps_on_every_edge() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        let cases = [
            // (x, y, vx, vy, expect_x_beyond_right, expect_y_beyond_bottom)
            (-3.0, 400.0, -1.0, 0.0, true, false),
            (1283.0, 400.0, 1.0, 0.0, false, false),
            (640.0, -3.0, 0.0, -1.0, false, true),
            (640.0, 803.0, 0.0, 1.0, false, false),
        ];

        for (x, y, vx, vy, beyond_right, beyond_bottom) in cases {
            let s = state();

            s.data[0] = x;
            s.data[1] = y;
            s.data[2] = vx;
            s.data[3] = vy;

            tick(FRAME_MS, -1e9, -1e9);

            let s = state();

            if beyond_right {
                assert!(s.data[0] > 1280.0);
            }
            if beyond_bottom {
                assert!(s.data[1] > 800.0);
            }

            // Whatever happened, it stayed within a radius of the canvas.
            assert!(s.data[0] >= -3.0 && s.data[0] <= 1283.0);
            assert!(s.data[1] >= -3.0 && s.data[1] <= 803.0);
        }
    }

    /// Everything below drives one particle at a known position so the
    /// pointer distance is exact rather than incidental.
    fn one_particle_at(x: f32, y: f32) {
        let s = state();

        s.count = 1;
        s.data[0] = x;
        s.data[1] = y;
        s.data[2] = 0.0;
        s.data[3] = 0.0;
        s.data[4] = s.size;
        s.data[5] = s.opacity;
    }

    /// How far along the bubble a particle is, recovered from the radius the
    /// simulation wrote. The progress value itself is no longer stored — the
    /// buffer carries the finished numbers the canvas needs.
    fn bubble_of(index: usize) -> f32 {
        let s = state();
        let radius = s.data[index * STRIDE + 4];

        (radius - s.size) / (s.bubble_size - s.size)
    }

    #[test]
    fn fully_bubbles_the_particle_under_the_pointer() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        one_particle_at(640.0, 400.0);

        tick(FRAME_MS, 640.0, 400.0);

        let s = state();

        assert!((s.data[4] - s.bubble_size).abs() < 0.001);
        assert!((s.data[5] - s.bubble_opacity).abs() < 0.001);
    }

    /// The whole point of the correction: the bubble tracks the pointer, so it
    /// has to land on the frame the pointer arrives. Easing it over a duration
    /// made the field take two seconds to respond, which reads as nothing
    /// happening at all.
    #[test]
    fn bubbles_on_the_first_frame() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        one_particle_at(640.0, 400.0);

        tick(FRAME_MS, 640.0, 400.0);
        let immediate = state().data[4];

        tick(FRAME_MS, 640.0, 400.0);

        assert_eq!(immediate, state().data[4]);
    }

    /// Linear in distance: a particle halfway across the radius is halfway
    /// bubbled, which is what gives the field its gradient under the pointer.
    #[test]
    fn falls_off_linearly_with_distance() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        for (offset, expected) in [(0.0, 1.0), (43.75, 0.75), (87.5, 0.5), (131.25, 0.25)] {
            one_particle_at(640.0 + offset, 400.0);
            tick(FRAME_MS, 640.0, 400.0);

            let actual = bubble_of(0);

            assert!(
                (actual - expected).abs() < 0.01,
                "{offset}px from the pointer bubbled {actual}, expected {expected}"
            );
        }
    }

    #[test]
    fn leaves_a_particle_outside_the_radius_alone() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        one_particle_at(640.0, 400.0);

        // 176px away, just outside the 175px bubble distance.
        tick(FRAME_MS, 816.0, 400.0);

        let s = state();

        assert_eq!(s.data[4], s.size);
        assert_eq!(s.data[5], s.opacity);
    }

    /// The radius is a circle, not a bounding box: a particle diagonally
    /// 212px away must not bubble even though both axes are within range.
    #[test]
    fn measures_the_radius_as_a_circle() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        one_particle_at(790.0, 550.0);

        tick(FRAME_MS, 640.0, 400.0);

        assert_eq!(bubble_of(0), 0.0);
    }

    /// Drops the moment the pointer goes, for the same reason it lands the
    /// moment it arrives.
    #[test]
    fn returns_to_rest_when_the_pointer_leaves() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        one_particle_at(640.0, 400.0);

        tick(FRAME_MS, 640.0, 400.0);
        assert!(bubble_of(0) > 0.9);

        tick(FRAME_MS, -1e9, -1e9);

        let s = state();

        assert_eq!(s.data[4], s.size);
        assert_eq!(s.data[5], s.opacity);
    }

    /// The interpolation the drawing half used to do. It lives here now, so it
    /// is asserted here.
    #[test]
    fn writes_a_resting_particle_at_the_configured_size_and_opacity() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        one_particle_at(640.0, 400.0);

        tick(FRAME_MS, -1e9, -1e9);

        let s = state();

        assert_eq!(s.data[4], 2.2);
        assert_eq!(s.data[5], 0.3);
    }

    #[test]
    fn interpolates_halfway_across_the_bubble() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        // 87.5px is half of the 175px radius.
        one_particle_at(640.0 + 87.5, 400.0);

        tick(FRAME_MS, 640.0, 400.0);

        let s = state();

        // Halfway between 2.2 and 4.0, and between 0.3 and 0.6.
        assert!((s.data[4] - 3.1).abs() < 0.02, "radius was {}", s.data[4]);
        assert!((s.data[5] - 0.45).abs() < 0.01, "alpha was {}", s.data[5]);
    }

    /// Twice the resting opacity, as the pair this was ported from had at 0.3
    /// and 0.6 — derived, so raising one cannot invert the relationship.
    #[test]
    fn doubles_the_opacity_for_a_fully_bubbled_particle() {
        assert!((bubble_opacity_for(0.3) - 0.6).abs() < 0.0001);
        assert!((bubble_opacity_for(0.4) - 0.8).abs() < 0.0001);
    }

    #[test]
    fn never_exceeds_full_opacity() {
        assert_eq!(bubble_opacity_for(0.7), 1.0);
        assert_eq!(bubble_opacity_for(1.0), 1.0);
    }

    /// A resize spawns into a field that is already configured, so the new
    /// particles have to arrive at rest rather than at zero — otherwise they
    /// are invisible until the first tick reaches them.
    #[test]
    fn spawns_particles_ready_to_draw() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);

        let s = state();

        for i in 0..s.count {
            let o = i * STRIDE;

            assert_eq!(s.data[o + 4], 2.2);
            assert_eq!(s.data[o + 5], 0.3);
        }
    }

    #[test]
    fn approximates_square_roots_closely_enough() {
        for x in [0.0, 1.0, 2.0, 16.0, 175.0, 1024.0, 30625.0] {
            let error = abs(sqrt(x) - x.sqrt());

            assert!(error < 0.01, "sqrt({x}) was off by {error}");
        }
    }

    #[test]
    fn treats_a_negative_square_root_as_zero() {
        assert_eq!(sqrt(-1.0), 0.0);
    }

    #[test]
    fn is_deterministic_from_its_seed() {
        let _guard = lock();

        reset();
        resize(1280.0, 800.0);
        let a = state().data[0];

        reset();
        resize(1280.0, 800.0);

        assert_eq!(state().data[0], a);
    }
}
