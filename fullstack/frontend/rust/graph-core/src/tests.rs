//! Host-side unit tests — parity with the TS reference implementation.

use crate::*;

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn signed_noise_matches_ts_recipe() {
    // Same FNV/xorshift constants as TS; verify range + determinism + seed sensitivity.
    let a = signed_noise(42, "IRIS-001", "petal");
    let b = signed_noise(42, "IRIS-001", "petal");
    assert_eq!(a, b);
    assert!(a >= -1.0 && a <= 1.0);
    assert_ne!(signed_noise(43, "IRIS-001", "petal"), a);
}

#[test]
fn segment_intersection_liang_barsky() {
    let r = [10.0, 10.0, 20.0, 20.0];
    // crossing without vertices inside
    assert!(hit::segment_intersects_rect(0.0, 15.0, 30.0, 15.0, r));
    // outside
    assert!(!hit::segment_intersects_rect(0.0, 25.0, 30.0, 25.0, r));
    // diagonal through corner
    assert!(hit::segment_intersects_rect(5.0, 5.0, 25.0, 25.0, r));
}

#[test]
fn hit_rows_polyline_modes() {
    // Row 'a': (0,15)→(30,15) passes through rect [10,20]²
    let points = vec![0.0, 15.0, 30.0, 15.0];
    let active = [1u8];
    let mut out = [0u8; 1];
    let rect = [10.0f64, 10.0, 20.0, 20.0];
    let n = hit_rows_polyline(
        points.as_ptr() as usize,
        1,
        2,
        hit::HIT_LEGACY_VERTEX,
        rect.as_ptr() as usize,
        active.as_ptr() as usize,
        out.as_mut_ptr() as usize,
    );
    assert_eq!(n, 0); // no vertex inside
    let n = hit_rows_polyline(
        points.as_ptr() as usize,
        1,
        2,
        hit::HIT_SEGMENT,
        rect.as_ptr() as usize,
        active.as_ptr() as usize,
        out.as_mut_ptr() as usize,
    );
    assert_eq!(n, 1);
    assert_eq!(out[0], 1);
}

#[test]
fn nearest_row_threshold() {
    // 'near' at y=12, 'far' at y=19.5; query (15,13), threshold 8 → near wins.
    let points = vec![0.0, 12.0, 30.0, 12.0, 0.0, 19.5, 30.0, 19.5];
    let active = [1u8, 1];
    let best = unsafe {
        hit::nearest_row(points.as_ptr() as usize, 2, 2, 15.0, 13.0, 8.0, active.as_ptr() as usize)
    };
    assert_eq!(best, 0);
    let none = unsafe {
        hit::nearest_row(points.as_ptr() as usize, 2, 2, 15.0, 100.0, 8.0, active.as_ptr() as usize)
    };
    assert_eq!(none, -1);
}

#[test]
fn geometry_horizontal_layout_and_clamp() {
    let keys = vec!["x".to_string(), "y".to_string()];
    let specs = vec![
        geom::AxisSpec { is_categorical: false, min: 0.0, max: 10.0 },
        geom::AxisSpec { is_categorical: false, min: 0.0, max: 10.0 },
    ];
    let reversed = vec![false, false];
    let ids = vec!["r0".to_string()];
    let values = vec![5.0, 5.0];
    let result = create_geometry(&geom::GeometryParams {
        width: 800.0,
        height: 400.0,
        orientation: geom::ORIENT_HORIZONTAL,
        axis_keys: &keys,
        axis_specs: &specs,
        reversed: &reversed,
        jitter_enabled: false,
        jitter_mode: geom::JITTER_MODE_PIXEL,
        jitter_amount: 6.0,
        jitter_seed: 42,
        row_ids: &ids,
        row_values: &values,
    });
    assert!(approx(result.bounds[0], 72.0)); // left
    assert!(approx(result.bounds[1], 728.0)); // right
    assert!(approx(result.bounds[2], 62.0)); // top
    assert!(approx(result.bounds[3], 336.0)); // bottom
    // axis anchors at bounds.left and bounds.right for 2 axes
    assert!(approx(result.axis_pos[0], 72.0));
    assert!(approx(result.axis_pos[1], 728.0));
    // midpoint value on both axes → vertical center
    assert!(approx(result.points[1], (62.0 + 336.0) / 2.0));
    assert!(approx(result.points[2], 728.0));
    assert!(approx(result.points[3], (62.0 + 336.0) / 2.0));

    // Out-of-range raw clamps to band.
    let values = vec![99.0, -5.0];
    let result = create_geometry(&geom::GeometryParams {
        row_values: &values,
        ..same(&keys, &specs, &reversed, &ids)
    });
    assert!(approx(result.points[1], 62.0)); // top clamp
    assert!(approx(result.points[3], 336.0)); // bottom clamp
}

fn same<'a>(
    keys: &'a [String],
    specs: &'a [geom::AxisSpec],
    reversed: &'a [bool],
    ids: &'a [String],
) -> geom::GeometryParams<'a> {
    geom::GeometryParams {
        width: 800.0,
        height: 400.0,
        orientation: geom::ORIENT_HORIZONTAL,
        axis_keys: keys,
        axis_specs: specs,
        reversed,
        jitter_enabled: false,
        jitter_mode: geom::JITTER_MODE_PIXEL,
        jitter_amount: 6.0,
        jitter_seed: 42,
        row_ids: ids,
        row_values: &[],
    }
}

#[test]
fn histogram_bin_edges_half_open_last_closed() {
    // 12 values spread over [0,12): bins of width 1.
    let vals: Vec<f64> = (0..12).map(|i| i as f64).collect();
    let mut bins = vec![0u32; 4];
    histogram_bins(vals.as_ptr() as usize, 12, 0.0, 12.0, 4, bins.as_mut_ptr() as usize);
    assert_eq!(bins, vec![3, 3, 3, 3]);
    // boundary value exactly at max lands in last bin
    let v = vec![12.0f64];
    histogram_bins(v.as_ptr() as usize, 1, 0.0, 12.0, 4, bins.as_mut_ptr() as usize);
    assert_eq!(bins, vec![0, 0, 0, 1]);
}

#[test]
fn box_stats_quartiles_match_ts_linear_interp() {
    let mut vals: Vec<f64> = (1..=9).map(|i| i as f64).collect(); // 1..9
    vals.shuffle_seeded();
    let scratch = vec![0.0f64; vals.len()];
    let mut out = [0.0f64; 6];
    box_stats(vals.as_ptr() as usize, vals.len(), scratch.as_ptr() as usize, out.as_mut_ptr() as usize);
    assert!(approx(out[0], 1.0));
    assert!(approx(out[1], 3.0)); // q1 of 1..9 = 3
    assert!(approx(out[2], 5.0));
    assert!(approx(out[3], 7.0));
    assert!(approx(out[4], 9.0));
    assert_eq!(out[5], 1.0);
}

trait ShuffleSeeded {
    fn shuffle_seeded(&mut self);
}
impl ShuffleSeeded for Vec<f64> {
    fn shuffle_seeded(&mut self) {
        // order irrelevant to the assertion; keep simple reversal
        self.reverse();
    }
}

#[test]
fn silhouette_order_sorts_by_label_then_desc_width() {
    // rows: (label, s) = (1, .1), (0, .9), (1, .5), (0, .2)
    let labels: Vec<i32> = vec![1, 0, 1, 0];
    let sil: Vec<f64> = vec![0.1, 0.9, 0.5, 0.2];
    let mut out = vec![0u32; 4];
    silhouette_order(labels.as_ptr() as usize, sil.as_ptr() as usize, 4, out.as_mut_ptr() as usize);
    assert_eq!(out, vec![1, 3, 2, 0]); // cluster0(.9,.2), cluster1(.5,.1)
}

#[test]
fn finite_min_max_skips_nan() {
    let vals = vec![f64::NAN, 3.0, f64::NAN, -2.5, 7.0];
    let mut out = [0.0f64; 2];
    let ok = finite_min_max(vals.as_ptr() as usize, vals.len(), out.as_mut_ptr() as usize);
    assert_eq!(ok, 1);
    assert!(approx(out[0], -2.5));
    assert!(approx(out[1], 7.0));
    let empty = vec![f64::NAN];
    assert_eq!(finite_min_max(empty.as_ptr() as usize, 1, out.as_mut_ptr() as usize), 0);
}
