//! graph-core — shared WASM compute engine for all DAVIS-PCP graph views.
//!
//! Raw `extern "C"` ABI over a linear-memory arena (no wasm-bindgen): the JS
//! side writes columnar sample data + parameters into WASM memory via exported
//! allocators, calls one op, and reads back flat result buffers. All state
//! lives in a single arena that the host resets between ops.

mod geom;
mod hit;
mod stats;

#[cfg(test)]
mod tests;

pub use geom::*;
pub use hit::*;
pub use stats::*;

/// Bump arena over WASM linear memory. Grown with `memory.grow`; never freed
/// per-op — the host calls `arena_reset()` between operations.
pub struct Arena {
    data: Vec<u8>,
    len: usize,
}

impl Arena {
    pub fn new() -> Self {
        Arena { data: Vec::new(), len: 0 }
    }

    #[inline]
    pub fn reset(&mut self) {
        self.len = 0;
    }

    /// Ensure capacity without moving the buffer later: grows once up front.
    pub fn reserve_min(&mut self, bytes: usize) {
        if self.data.len() < bytes {
            self.data.resize(bytes, 0);
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn alloc(&mut self, size: usize, align: usize) -> usize {
        let aligned = (self.len + (align - 1)) & !(align - 1);
        let end = aligned + size;
        if end > self.data.len() {
            self.data.resize(end.max(self.data.len() * 2), 0);
        }
        self.len = end;
        // Absolute linear-memory pointer — the host addresses the arena via
        // the exported memory, so offsets alone are meaningless.
        (self.data.as_ptr() as usize) + aligned
    }

    pub fn as_ptr(&self) -> *const u8 {
        self.data.as_ptr()
    }

    pub fn as_mut_ptr(&mut self) -> *mut u8 {
        self.data.as_mut_ptr()
    }

    /// Typed view helpers (little-endian; wasm32 is LE).
    pub fn write_f32(&mut self, offset: usize, value: f32) {
        unsafe {
            let p = self.as_mut_ptr().add(offset) as *mut f32;
            p.write_unaligned(value);
        }
    }
}

static mut ARENA: Option<Arena> = None;

fn arena() -> &'static mut Arena {
    unsafe {
        let ptr = &raw mut ARENA;
        if (*ptr).is_none() {
            *ptr = Some(Arena::new());
        }
        (*ptr).as_mut().unwrap()
    }
}
