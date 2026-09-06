//! Hit testing — port of frontend/src/features/pcp/brush.ts plus the 2D rect
//! scatter hit used by pair plot / facet / PCA / distribution panels.

pub const HIT_LEGACY_VERTEX: u32 = 0;
pub const HIT_SEGMENT: u32 = 1;

#[inline]
fn point_in_rect(x: f64, y: f64, r: [f64; 4]) -> bool {
    x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]
}

/// Liang–Barsky segment-rect intersection (matches TS segmentIntersectsRect).
pub fn segment_intersects_rect(ax: f64, ay: f64, bx: f64, by: f64, r: [f64; 4]) -> bool {
    if point_in_rect(ax, ay, r) || point_in_rect(bx, by, r) {
        return true;
    }
    let dx = bx - ax;
    let dy = by - ay;
    let mut t0 = 0.0f64;
    let mut t1 = 1.0f64;
    let p = [-dx, dx, -dy, dy];
    let q = [ax - r[0], r[2] - ax, ay - r[1], r[3] - ay];
    for i in 0..4 {
        if p[i] == 0.0 {
            if q[i] < 0.0 {
                return false;
            }
            continue;
        }
        let ratio = q[i] / p[i];
        if p[i] < 0.0 {
            if ratio > t1 {
                return false;
            }
            if ratio > t0 {
                t0 = ratio;
            }
        } else {
            if ratio < t0 {
                return false;
            }
            if ratio < t1 {
                t1 = ratio;
            }
        }
    }
    true
}

/// Nearest polyline within threshold — matches TS nearestRow semantics
/// (distance to segments only, threshold is an upper bound).
pub fn distance_point_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    if dx == 0.0 && dy == 0.0 {
        return ((px - ax).powi(2) + (py - ay).powi(2)).sqrt();
    }
    let t = (((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    ((px - (ax + t * dx)).powi(2) + (py - (ay + t * dy)).powi(2)).sqrt()
}

/// Row-filter core shared by all brush ops:
///   points: row-major [row][k][xy]
///   active: u8 per row (1 = test this row)
///   out:    u8 per row written with 1 when hit
#[no_mangle]
pub extern "C" fn hit_rows_polyline(
    points_ptr: usize,
    n_rows: usize,
    n_axes: usize,
    mode: u32,
    rect_ptr: usize,
    active_ptr: usize,
    out_ptr: usize,
) -> usize {
    unsafe {
        let pts = std::slice::from_raw_parts(points_ptr as *const f64, n_rows * n_axes * 2);
        let active = std::slice::from_raw_parts(active_ptr as *const u8, n_rows);
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut u8, n_rows);
        let r: [f64; 4] = std::ptr::read(rect_ptr as *const [f64; 4]);
        let mut hits = 0usize;
        for row in 0..n_rows {
            if active[row] == 0 {
                out[row] = 0;
                continue;
            }
            let base = row * n_axes * 2;
            // legacyVertex: any vertex inside
            let mut hit = false;
            for k in 0..n_axes {
                if point_in_rect(pts[base + k * 2], pts[base + k * 2 + 1], r) {
                    hit = true;
                    break;
                }
            }
            // segment: any segment crossing (also implies vertex test passed earlier in TS)
            if !hit && mode == HIT_SEGMENT && n_axes > 1 {
                for k in 0..n_axes - 1 {
                    if segment_intersects_rect(
                        pts[base + k * 2],
                        pts[base + k * 2 + 1],
                        pts[base + (k + 1) * 2],
                        pts[base + (k + 1) * 2 + 1],
                        r,
                    ) {
                        hit = true;
                        break;
                    }
                }
            }
            out[row] = if hit { 1 } else { 0 };
            if hit {
                hits += 1;
            }
        }
        hits
    }
}

/// Scatter rows against one value-space rect:
///   values: row-major [row][2] (xv, yv)
/// Returns hit count; out[i]=1 for hits.
#[no_mangle]
pub extern "C" fn hit_rows_scatter(
    values_ptr: usize,
    n_rows: usize,
    rect_ptr: usize,
    active_ptr: usize,
    out_ptr: usize,
) -> usize {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n_rows * 2);
        let active = std::slice::from_raw_parts(active_ptr as *const u8, n_rows);
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut u8, n_rows);
        let r: [f64; 4] = std::ptr::read(rect_ptr as *const [f64; 4]);
        let mut hits = 0usize;
        for row in 0..n_rows {
            let ok = active[row] != 0
                && point_in_rect(vals[row * 2], vals[row * 2 + 1], r);
            out[row] = if ok { 1 } else { 0 };
            if ok {
                hits += 1;
            }
        }
        hits
    }
}

/// Value-interval band hit (histogram range drag / distribution panel):
///   values: [row] × f64 on the value axis
#[no_mangle]
pub extern "C" fn hit_rows_band(
    values_ptr: usize,
    n_rows: usize,
    lo: f64,
    hi: f64,
    active_ptr: usize,
    out_ptr: usize,
) -> usize {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n_rows);
        let active = std::slice::from_raw_parts(active_ptr as *const u8, n_rows);
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut u8, n_rows);
        let mut hits = 0usize;
        for row in 0..n_rows {
            let ok = active[row] != 0 && vals[row] >= lo && vals[row] <= hi;
            out[row] = if ok { 1 } else { 0 };
            if ok {
                hits += 1;
            }
        }
        hits
    }
}

/// Nearest polyline row to a screen point (hover). Returns nearest row index
/// or -1 (i32 to keep the JS ABI numeric — row counts stay well under 2^31).
#[no_mangle]
pub extern "C" fn nearest_row(
    points_ptr: usize,
    n_rows: usize,
    n_axes: usize,
    px: f64,
    py: f64,
    threshold: f64,
    active_ptr: usize,
) -> i32 {
    unsafe {
        let pts = std::slice::from_raw_parts(points_ptr as *const f64, n_rows * n_axes * 2);
        let active = std::slice::from_raw_parts(active_ptr as *const u8, n_rows);
        let mut best: i32 = -1;
        let mut best_distance = threshold;
        for row in 0..n_rows {
            if active[row] == 0 {
                continue;
            }
            let base = row * n_axes * 2;
            if n_axes < 2 {
                continue;
            }
            for k in 0..n_axes - 1 {
                let d = distance_point_to_segment(
                    px,
                    py,
                    pts[base + k * 2],
                    pts[base + k * 2 + 1],
                    pts[base + (k + 1) * 2],
                    pts[base + (k + 1) * 2 + 1],
                );
                if d < best_distance {
                    best_distance = d;
                    best = row as i32;
                }
            }
        }
        best
    }
}
