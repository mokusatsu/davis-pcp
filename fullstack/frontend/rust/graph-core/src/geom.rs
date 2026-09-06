//! PCP geometry — port of frontend/src/features/pcp/geometry.ts.
//! Bit-exact with the TS implementation (FNV-1a + xorshift16 jitter recipe).

use crate::arena;

pub const ORIENT_HORIZONTAL: u8 = 0;
pub const ORIENT_VERTICAL: u8 = 1;
pub const JITTER_MODE_PIXEL: u8 = 0;
pub const JITTER_MODE_LEGACY_RAW: u8 = 1;

#[derive(Clone, Copy)]
pub struct AxisSpec {
    pub is_categorical: bool,
    pub min: f64,
    pub max: f64,
}

fn hash_string(input: &str) -> u32 {
    let mut hash: u32 = 2166136261;
    for b in input.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    hash
}

/// Deterministic noise in [-1, 1] from seed|rowId|axis — matches TS signedNoise.
pub fn signed_noise(seed: i32, row_id: &str, key: &str) -> f64 {
    let mut x = hash_string(&format!("{}|{}|{}", seed, row_id, key));
    if x == 0 {
        x = 1;
    }
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    ((x as u32) as f64 / 4294967295.0) * 2.0 - 1.0
}

pub struct GeometryParams<'a> {
    pub width: f64,
    pub height: f64,
    pub orientation: u8,
    pub axis_keys: &'a [String],
    pub axis_specs: &'a [AxisSpec],
    pub reversed: &'a [bool],
    pub jitter_enabled: bool,
    pub jitter_mode: u8,
    pub jitter_amount: f64,
    pub jitter_seed: i32,
    /// Per visible row: id + raw values aligned to axis_keys.
    pub row_ids: &'a [String],
    /// row-major [row][axis] raw values.
    pub row_values: &'a [f64],
}

pub struct GeometryResult {
    /// Layout bounds {left,right,top,bottom}.
    pub bounds: [f64; 4],
    /// Per-axis anchor position along the cross axis.
    pub axis_pos: Vec<f64>,
    /// Row-major point coordinates [row][axis][xy].
    pub points: Vec<f64>,
    pub width: f64,
    pub height: f64,
}

pub fn create_geometry(p: &GeometryParams) -> GeometryResult {
    let n_axes = p.axis_keys.len();
    let n_rows = p.row_ids.len();
    let margin: [f64; 4] = if p.orientation == ORIENT_HORIZONTAL {
        [72.0, 72.0, 62.0, 64.0]
    } else {
        [84.0, 105.0, 66.0, 66.0]
    };
    let left = margin[0];
    let right = p.width - margin[1];
    let top = margin[2];
    let bottom = p.height - margin[3];

    let mut axis_pos = Vec::with_capacity(n_axes);
    for index in 0..n_axes {
        let ratio = if n_axes <= 1 { 0.5 } else { index as f64 / (n_axes - 1) as f64 };
        let pos = if p.orientation == ORIENT_HORIZONTAL {
            left + ratio * (right - left)
        } else {
            top + ratio * (bottom - top)
        };
        axis_pos.push(pos);
    }

    let mut points = vec![0.0f64; n_rows * n_axes * 2];
    for r in 0..n_rows {
        let row_id = &p.row_ids[r];
        for a in 0..n_axes {
            let spec = &p.axis_specs[a];
            let raw = p.row_values[r * n_axes + a];
            let apply_raw_jitter =
                p.jitter_enabled && p.jitter_mode == JITTER_MODE_LEGACY_RAW && !spec.is_categorical;
            let apply_pixel_jitter = p.jitter_enabled && p.jitter_mode == JITTER_MODE_PIXEL;

            // Categorical axes arrive pre-normalized by the host as t in [0,1]
            // (host maps category index → t); numeric use min-max here.
            let mut t = if spec.is_categorical {
                raw
            } else {
                let numeric = if apply_raw_jitter {
                    raw + signed_noise(p.jitter_seed, row_id, &p.axis_keys[a]) * 0.1
                } else {
                    raw
                };
                if spec.max == spec.min {
                    0.5
                } else {
                    (numeric - spec.min) / (spec.max - spec.min)
                }
            };
            if p.reversed[a] {
                t = 1.0 - t;
            }

            let slot = (r * n_axes + a) * 2;
            if p.orientation == ORIENT_HORIZONTAL {
                let mut y = bottom - t * (bottom - top);
                if apply_pixel_jitter {
                    y += signed_noise(p.jitter_seed, row_id, &p.axis_keys[a]) * p.jitter_amount;
                }
                points[slot] = axis_pos[a];
                points[slot + 1] = y.clamp(top, bottom);
            } else {
                let mut x = left + t * (right - left);
                if apply_pixel_jitter {
                    x += signed_noise(p.jitter_seed, row_id, &p.axis_keys[a]) * p.jitter_amount;
                }
                points[slot] = x.clamp(left, right);
                points[slot + 1] = axis_pos[a];
            }
        }
    }

    GeometryResult {
        bounds: [left, right, top, bottom],
        axis_pos,
        points,
        width: p.width,
        height: p.height,
    }
}

// ---------------------------------------------------------------------------
// Raw ABI exports. The host writes inputs into the arena via alloc_*, fills
// them, then calls compute_pcp_geometry which returns an output descriptor:
//   [0] points_ptr  [1] points_len(bytes)  [2] axis_pos_ptr  [3] bounds_ptr
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn arena_reset() {
    // Pre-grow to 64MB on first use: Vec::resize would otherwise relocate the
    // buffer mid-op and invalidate absolute pointers the host already holds.
    arena().reserve_min(64 * 1024 * 1024);
    arena().reset();
}

#[no_mangle]
pub extern "C" fn arena_alloc(size: usize) -> usize {
    arena().alloc(size, 16)
}

/// Compute PCP geometry.
///
/// Host memory layout (all written before the call):
///   params: [width f64, height f64, orientation u32, n_axes u32, n_rows u32,
///            jitter_enabled u32, jitter_mode u32, jitter_amount f64, jitter_seed i32,
///            reversed_ptr u32, specs_ptr u32, values_ptr u32, keys_ptr u32]
///   reversed_ptr → n_axes × u32 (0/1)
///   specs_ptr    → n_axes × [is_cat u32, min f64, max f64]
///   values_ptr   → n_rows*n_axes × f64  (categorical columns carry t∈[0,1])
///   keys_ptr     → n_axes × u32 absolute ptrs to NUL-terminated key strings
///                  (jitter determinism uses the real column name)
///   rowids_ptr   → n_rows × u32 absolute ptrs to NUL-terminated row-id strings
///                  (jitter determinism uses the real row id)
///
/// Returns packed descriptor ptr (6 × u32): pointsPtr, pointsLen, axisPosPtr,
/// boundsPtr, plus geometry dims echo. Output buffers live in the arena.
#[no_mangle]
pub extern "C" fn compute_pcp_geometry(params_ptr: usize) -> usize {
    unsafe {
        let a = arena();
        let base = params_ptr;
        let rd_u32 = |off: usize| *((base + off) as *const u32);
        let rd_f64 = |off: usize| *((base + off) as *const f64);

        let width = rd_f64(0);
        let height = rd_f64(8);
        let orientation = rd_u32(16) as u8;
        let n_axes = rd_u32(20) as usize;
        let n_rows = rd_u32(24) as usize;
        let jitter_enabled = rd_u32(28) != 0;
        let jitter_mode = rd_u32(32) as u8;
        let jitter_amount = rd_f64(40);
        let jitter_seed = rd_f64(48) as i32;
        let reversed_off = rd_u32(56) as usize;
        let specs_off = rd_u32(60) as usize;
        let values_off = rd_u32(64) as usize;
        let keys_off = rd_u32(68) as usize;
        let rowids_off = rd_u32(72) as usize;

        let mut axis_keys: Vec<String> = Vec::with_capacity(n_axes);
        for i in 0..n_axes {
            let s_ptr = *((keys_off + i * 4) as *const u32);
            let mut end = s_ptr;
            while *(end as *const u8) != 0 {
                end += 1;
            }
            let bytes = std::slice::from_raw_parts(s_ptr as *const u8, (end - s_ptr) as usize);
            axis_keys.push(String::from_utf8_lossy(bytes).into_owned());
        }
        let mut row_ids: Vec<String> = Vec::with_capacity(n_rows);
        for i in 0..n_rows {
            let s_ptr = *((rowids_off + i * 4) as *const u32);
            let mut end = s_ptr;
            while *(end as *const u8) != 0 {
                end += 1;
            }
            let bytes = std::slice::from_raw_parts(s_ptr as *const u8, (end - s_ptr) as usize);
            row_ids.push(String::from_utf8_lossy(bytes).into_owned());
        }
        let axis_keys_ref = &axis_keys;
        let mut reversed = Vec::with_capacity(n_axes);
        for i in 0..n_axes {
            reversed.push(*((reversed_off + i * 4) as *const u32) != 0);
        }
        // Host packs specs as 3 × f64 [is_cat, min, max] (24-byte stride).
        let mut specs = Vec::with_capacity(n_axes);
        for i in 0..n_axes {
            let s = specs_off + i * 24;
            specs.push(AxisSpec {
                is_categorical: *(s as *const f64) != 0.0,
                min: *((s + 8) as *const f64),
                max: *((s + 16) as *const f64),
            });
        }
        let values = std::slice::from_raw_parts(values_off as *const f64, n_rows * n_axes);

        let params = GeometryParams {
            width,
            height,
            orientation,
            axis_keys: axis_keys_ref,
            axis_specs: &specs,
            reversed: &reversed,
            jitter_enabled,
            jitter_mode,
            jitter_amount,
            jitter_seed,
            row_ids: &row_ids,
            row_values: values,
        };
        let result = create_geometry(&params);

        // NOTE: alloc() now returns absolute linear-memory pointers, so the
        // descriptor and output buffers can be written directly.
        let out_desc = a.alloc(6 * 4, 4);
        let points_bytes = result.points.len() * 8;
        let pts_ptr = a.alloc(points_bytes, 8);
        let axis_bytes = result.axis_pos.len() * 8;
        let ax_ptr = a.alloc(axis_bytes, 8);
        let bounds_ptr = a.alloc(4 * 8, 8);

        std::ptr::copy_nonoverlapping(result.points.as_ptr(), pts_ptr as *mut f64, result.points.len());
        std::ptr::copy_nonoverlapping(result.axis_pos.as_ptr(), ax_ptr as *mut f64, result.axis_pos.len());
        std::ptr::copy_nonoverlapping(result.bounds.as_ptr(), bounds_ptr as *mut f64, 4);

        let d = out_desc as *mut u32;
        *d.add(0) = pts_ptr as u32;
        *d.add(1) = points_bytes as u32;
        *d.add(2) = ax_ptr as u32;
        *d.add(3) = axis_bytes as u32;
        *d.add(4) = bounds_ptr as u32;
        *d.add(5) = 0;
        out_desc
    }
}
