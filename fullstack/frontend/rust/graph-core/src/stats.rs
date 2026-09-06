//! Aggregation ops: histograms, box stats, silhouette ordering.
//! All operate on active-filtered f64 value slices and write flat outputs.

use crate::arena;

/// Histogram binning — matches TS `Math.min(bins-1, floor((v-min)/(max-min)*bins))`.
#[no_mangle]
pub extern "C" fn histogram_bins(
    values_ptr: usize,
    n: usize,
    min: f64,
    max: f64,
    bins: u32,
    out_ptr: usize,
) -> usize {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n);
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut u32, bins as usize);
        for c in out.iter_mut() {
            *c = 0;
        }
        let span = if max == min { 1.0 } else { max - min };
        let nb = bins as usize;
        for v in vals {
            let mut b = (((v - min) / span) * bins as f64).floor() as isize;
            if b < 0 {
                b = 0;
            }
            let b = (b as usize).min(nb - 1);
            out[b] += 1;
        }
        vals.len()
    }
}

/// Grouped histogram: group_of[i] indexes the group slot per row (u32::MAX = skip).
#[no_mangle]
pub extern "C" fn histogram_grouped(
    values_ptr: usize,
    group_of_ptr: usize,
    n: usize,
    min: f64,
    max: f64,
    bins: u32,
    n_groups: u32,
    out_ptr: usize,
) -> usize {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n);
        let groups = std::slice::from_raw_parts(group_of_ptr as *const u32, n);
        let nb = bins as usize;
        let ng = n_groups as usize;
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut u32, ng * nb);
        for c in out.iter_mut() {
            *c = 0;
        }
        let span = if max == min { 1.0 } else { max - min };
        for (v, g) in vals.iter().zip(groups.iter()) {
            let gi = *g as usize;
            if gi >= ng {
                continue;
            }
            let b = (((*v - min) / span) * bins as f64).floor() as isize;
            let b = (b.max(0) as usize).min(nb - 1);
            out[gi * nb + b] += 1;
        }
        n
    }
}

fn quantile_sorted(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let position = (sorted.len() - 1) as f64 * q;
    let base = position.floor() as usize;
    let rest = position - base as f64;
    match sorted.get(base + 1) {
        Some(next) => sorted[base] + rest * (next - sorted[base]),
        None => sorted[base],
    }
}

/// Box stats for one group. Writes 5 × f64 [low,q1,median,q3,high].
/// Values are copied to a scratch buffer then sorted (matches TS boxStats).
#[no_mangle]
pub extern "C" fn box_stats(values_ptr: usize, n: usize, scratch_ptr: usize, out_ptr: usize) -> u32 {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n);
        let scratch = std::slice::from_raw_parts_mut(scratch_ptr as *mut f64, n);
        scratch[..n].copy_from_slice(vals);
        scratch.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        if n == 0 {
            *(out_ptr as *mut u32) = 0;
            return 0;
        }
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut f64, 6);
        out[0] = scratch[0];
        out[1] = quantile_sorted(scratch, 0.25);
        out[2] = quantile_sorted(scratch, 0.5);
        out[3] = quantile_sorted(scratch, 0.75);
        out[4] = scratch[n - 1];
        out[5] = 1.0; // valid flag
        1
    }
}

/// Silhouette row order: within each cluster sort by s descending (stable),
/// matching TS SilhouettePlot cluster.rows sort. Writes permutation out[i]
/// = source row index in display order.
#[no_mangle]
pub extern "C" fn silhouette_order(
    labels_ptr: usize,
    sil_ptr: usize,
    n: usize,
    out_ptr: usize,
) -> usize {
    unsafe {
        let labels = std::slice::from_raw_parts(labels_ptr as *const i32, n);
        let sil = std::slice::from_raw_parts(sil_ptr as *const f64, n);
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut u32, n);
        let mut idx: Vec<u32> = (0..n as u32).collect();
        // stable sort by (label asc, sil desc)
        idx.sort_by(|&a, &b| {
            let la = labels[a as usize];
            let lb = labels[b as usize];
            if la != lb {
                la.cmp(&lb)
            } else {
                sil[b as usize].partial_cmp(&sil[a as usize]).unwrap_or(std::cmp::Ordering::Equal)
            }
        });
        out.copy_from_slice(&idx);
        n
    }
}

/// Min/max over finite values only (NaN skipped) — matches TS Number.isFinite filters.
#[no_mangle]
pub extern "C" fn finite_min_max(values_ptr: usize, n: usize, out_ptr: usize) -> usize {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n);
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut f64, 2);
        let mut has = false;
        let mut mn = f64::INFINITY;
        let mut mx = f64::NEG_INFINITY;
        for v in vals {
            if v.is_finite() {
                has = true;
                if *v < mn {
                    mn = *v;
                }
                if *v > mx {
                    mx = *v;
                }
            }
        }
        out[0] = if has { mn } else { 0.0 };
        out[1] = if has { mx } else { 0.0 };
        if has {
            1
        } else {
            0
        }
    }
}

// ---------------------------------------------------------------------------
// Descriptive statistics (StatisticsPage table)
// ---------------------------------------------------------------------------

/// Full descriptive stats for one numeric column.
/// Writes 8 × f64: [count, missing, mean, std(sample), min, q1, median, q3,
/// max] — 9 slots total. NaN inputs count as missing. unique is computed by
/// the host (needs hashing); this op covers the sort-heavy path.
#[no_mangle]
pub extern "C" fn describe_numeric(
    values_ptr: usize,
    n: usize,
    scratch_ptr: usize,
    out_ptr: usize,
) -> u32 {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n);
        let finite = std::slice::from_raw_parts_mut(scratch_ptr as *mut f64, n);
        let mut m = 0usize;
        for v in vals.iter().take(n) {
            if v.is_finite() {
                finite[m] = *v;
                m += 1;
            }
        }
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut f64, 9);
        if m == 0 {
            for slot in out.iter_mut() {
                *slot = 0.0;
            }
            return 0;
        }
        finite[..m].sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let sum: f64 = finite[..m].iter().sum();
        let mean = sum / m as f64;
        let variance = if m > 1 {
            finite[..m].iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / (m - 1) as f64
        } else {
            0.0
        };
        out[0] = m as f64; // count
        out[1] = (n - m) as f64; // missing
        out[2] = mean;
        out[3] = variance.sqrt();
        out[4] = finite[0];
        out[5] = quantile_sorted(&finite[..m], 0.25);
        out[6] = quantile_sorted(&finite[..m], 0.5);
        out[7] = quantile_sorted(&finite[..m], 0.75);
        out[8] = finite[m - 1];
        1
    }
}

/// Pearson correlation matrix over k columns × n rows (pairwise complete:
/// a NaN in either column skips that pair, matching typical pandas behavior
/// closely enough for the heatmap). Writes k×k f64 row-major.
#[no_mangle]
pub extern "C" fn correlation_matrix(
    values_ptr: usize,
    n: usize,
    k: u32,
    out_ptr: usize,
) -> usize {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n * k as usize);
        let kk = k as usize;
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut f64, kk * kk);
        let col = |c: usize, i: usize| vals[i * kk + c];
        for i in 0..kk {
            for j in 0..kk {
                if i == j {
                    out[i * kk + j] = 1.0;
                    continue;
                }
                let mut sx = 0.0;
                let mut sy = 0.0;
                let mut cnt = 0usize;
                for r in 0..n {
                    let x = col(i, r);
                    let y = col(j, r);
                    if x.is_finite() && y.is_finite() {
                        sx += x;
                        sy += y;
                        cnt += 1;
                    }
                }
                if cnt == 0 {
                    out[i * kk + j] = f64::NAN;
                    continue;
                }
                let mx = sx / cnt as f64;
                let my = sy / cnt as f64;
                let mut sxy = 0.0;
                let mut sxx = 0.0;
                let mut syy = 0.0;
                for r in 0..n {
                    let x = col(i, r);
                    let y = col(j, r);
                    if x.is_finite() && y.is_finite() {
                        let dx = x - mx;
                        let dy = y - my;
                        sxy += dx * dy;
                        sxx += dx * dx;
                        syy += dy * dy;
                    }
                }
                let denom = (sxx * syy).sqrt();
                out[i * kk + j] = if denom == 0.0 { f64::NAN } else { sxy / denom };
            }
        }
        kk * kk
    }
}

/// Jittered scatter coordinates for one panel column (StatisticsPage strip /
/// Distribution lens points): writes [x,y] per row where
///   t   = (v-min)/(max-min) clamped to [0,1]
///   off = signed_noise(seed, rowIdHash, keyHash) * amount
/// Row ids arrive pre-hashed (u32 from the host's FNV-1a of "seed|id|key")
/// so WASM stays free of string parsing. Matches TS signedNoiseViz bit-for-bit.
#[no_mangle]
pub extern "C" fn jitter_points_1d(
    values_ptr: usize,
    noise_ptr: usize,
    n: usize,
    min: f64,
    max: f64,
    axis_pos: f64,
    cross_amount: f64,
    out_ptr: usize,
) -> usize {
    unsafe {
        let vals = std::slice::from_raw_parts(values_ptr as *const f64, n);
        let noise = std::slice::from_raw_parts(noise_ptr as *const f64, n);
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut f64, n * 2);
        let span = if max == min { 1.0 } else { max - min };
        for i in 0..n {
            let t = ((vals[i] - min) / span).clamp(0.0, 1.0);
            out[i * 2] = axis_pos + noise[i] * cross_amount;
            out[i * 2 + 1] = t;
        }
        n
    }
}

// ---------------------------------------------------------------------------
// K-Medoids (CLARA-style sampled PAM) — PCP draw simplification
// ---------------------------------------------------------------------------

struct XorShift32(u32);

impl XorShift32 {
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// Uniform integer in [0, bound) via rejection sampling (deterministic).
    fn next_below(&mut self, bound: u32) -> u32 {
        // Rejection threshold: largest multiple of bound below 2^32.
        let threshold = (0u32.wrapping_sub(bound)) % bound;
        loop {
            let x = self.next_u32();
            if x >= threshold {
                return x % bound;
            }
        }
    }
}

/// L1 distance over normalized t-space with early exit. NaN dims count only
/// when exactly one side is finite (penalty 1.0) — mirrors TS parity oracle.
#[inline]
fn l1_distance(
    a: &[f32],
    b: &[f32],
    d: usize,
    limit: f64,
) -> f64 {
    let mut sum = 0.0f64;
    for k in 0..d {
        let x = a[k];
        let y = b[k];
        if x.is_finite() && y.is_finite() {
            sum += (f64::from(x) - f64::from(y)).abs();
        } else if x.is_finite() != y.is_finite() {
            sum += 1.0;
        }
        if sum > limit {
            return sum;
        }
    }
    sum
}

pub struct KMedoidsResult {
    /// Input-row-order indexes of chosen medoids (k entries).
    pub medoid_indexes: Vec<u32>,
    /// Cluster sizes from the full assignment (k entries, sums to n).
    pub sizes: Vec<u32>,
    /// Nearest-medoid assignment per input row (n entries, values < k).
    pub assignment: Vec<u32>,
}

fn kmedoids_core(
    values: &[f64],
    n: usize,
    d: usize,
    target_k: usize,
    sample_size: usize,
    swap_rounds: usize,
    seed: u32,
    specs: &[(bool, f64, f64)],
) -> KMedoidsResult {
    // Normalize to t∈[0,1] with f32 storage (same rule as geom.rs: numeric
    // min-max, degenerate axis → 0.5, categorical already normalized).
    let mut tvals = vec![0f32; n * d];
    for r in 0..n {
        for a in 0..d {
            let (is_cat, min, max) = specs[a];
            let raw = values[r * d + a];
            let t = if is_cat {
                raw
            } else if max == min {
                0.5
            } else {
                (raw - min) / (max - min)
            };
            tvals[r * d + a] = t as f32;
        }
    }

    let k = if target_k >= n { n } else { target_k };
    if k == 0 {
        return KMedoidsResult { medoid_indexes: Vec::new(), sizes: Vec::new(), assignment: Vec::new() };
    }

    // Sample S rows (deterministic partial Fisher-Yates).
    let s = sample_size.min(n);
    let mut sample: Vec<u32> = (0..n as u32).collect();
    let mut rng = XorShift32(seed);
    if seed == 0 {
        rng.0 = 0x9E3779B9;
    }
    for i in 0..s {
        let j = i + (rng.next_below((n - i) as u32) as usize);
        sample.swap(i, j);
    }
    let sample = &sample[..s];

    let dist = |si: usize, sj: usize, limit: f64| -> f64 {
        let a = &tvals[sample[si] as usize * d..sample[si] as usize * d + d];
        let b = &tvals[sample[sj] as usize * d..sample[sj] as usize * d + d];
        l1_distance(a, b, d, limit)
    };

    // BUILD phase: greedy farthest-style selection with incremental bestDist.
    let mut medoids: Vec<usize> = Vec::with_capacity(k);
    let mut best_dist = vec![f64::INFINITY; s];
    // First medoid: sample slot closest to the sample mean (deterministic,
    // stable under row reordering better than slot 0).
    let mut mean = vec![0f64; d];
    for &ri in sample.iter() {
        for a in 0..d {
            let v = tvals[ri as usize * d + a];
            if v.is_finite() {
                mean[a] += f64::from(v);
            }
        }
    }
    for a in mean.iter_mut() {
        *a /= s as f64;
    }
    let mut first = 0usize;
    let mut first_cost = f64::INFINITY;
    for si in 0..s {
        let mut cost = 0.0f64;
        for a in 0..d {
            let v = tvals[sample[si] as usize * d + a];
            if v.is_finite() {
                cost += (f64::from(v) - mean[a]).abs();
            }
        }
        if cost < first_cost {
            first_cost = cost;
            first = si;
        }
    }
    medoids.push(first);
    for si in 0..s {
        best_dist[si] = dist(first, si, f64::INFINITY);
    }
    while medoids.len() < k {
        // Farthest-insert (PAM-lite): pick the sample row with the largest
        // uncovered distance. O(S·d) per round instead of the gain-sum's
        // O(S²·d) — k=300 × S=1500 × d=369 would otherwise take minutes.
        let mut best_si = 0usize;
        let mut best_d = -1.0f64;
        for si in 0..s {
            if best_dist[si] > best_d {
                best_d = best_dist[si];
                best_si = si;
            }
        }
        if best_d <= 0.0 {
            break;
        }
        for si in 0..s {
            let dd = dist(best_si, si, best_dist[si]);
            if dd < best_dist[si] {
                best_dist[si] = dd;
            }
        }
        medoids.push(best_si);
    }

    // SWAP phase: for each medoid, try replacing it with the worst-covered
    // member of its own cluster. Cost is evaluated incrementally: only the
    // swapped medoid's contribution changes, so each candidate swap is
    // O(T_eval·d) instead of O(T_eval·k·d).
    let t_eval = s.min(400);
    for _round in 0..swap_rounds {
        // Cluster membership under current medoids (sample slots).
        let mut owner = vec![0usize; s];
        for si in 0..s {
            let mut bi = 0usize;
            let mut bd = f64::INFINITY;
            for (mi, &m) in medoids.iter().enumerate() {
                let dd = dist(m, si, bd);
                if dd < bd {
                    bd = dd;
                    bi = mi;
                }
            }
            owner[si] = bi;
        }
        let mut improved = false;
        for mi in 0..medoids.len() {
            // Worst-covered member of this medoid's cluster.
            let mut worst_si = usize::MAX;
            let mut worst_d = -1.0f64;
            for si in 0..s {
                if owner[si] == mi && si != medoids[mi] {
                    let dd = dist(medoids[mi], si, f64::INFINITY);
                    if dd > worst_d {
                        worst_d = dd;
                        worst_si = si;
                    }
                }
            }
            if worst_si == usize::MAX {
                continue;
            }
            // Incremental cost: for each eval row, cost with medoids[mi]
            // replaced by worst_si = min over (other medoids, new candidate).
            let mut current_cost = 0.0f64;
            let mut swap_cost = 0.0f64;
            for si in 0..t_eval {
                // Current: distance to medoids[mi] and best other.
                let d_cur = dist(medoids[mi], si, f64::INFINITY);
                let mut d_other = f64::INFINITY;
                for (mj, &m) in medoids.iter().enumerate() {
                    if mj == mi {
                        continue;
                    }
                    let dd = dist(m, si, d_other);
                    if dd < d_other {
                        d_other = dd;
                    }
                }
                current_cost += d_cur.min(d_other);
                let d_new = dist(worst_si, si, f64::INFINITY);
                swap_cost += d_new.min(d_other);
            }
            if swap_cost + 1e-9 < current_cost {
                medoids[mi] = worst_si;
                improved = true;
            }
        }
        if !improved {
            break;
        }
    }

    // Full assignment: every input row → nearest medoid. NaN dims skip when
    // BOTH sides are NaN; one-sided NaN counts 1.0 (same as dist()).
    let medoid_rows: Vec<usize> = medoids.iter().map(|&si| sample[si] as usize).collect();
    let mut assignment = vec![0u32; n];
    let mut sizes = vec![0u32; medoid_rows.len()];
    for r in 0..n {
        let row = &tvals[r * d..r * d + d];
        let mut bi = 0usize;
        let mut bd = f64::INFINITY;
        for (mi, &m) in medoid_rows.iter().enumerate() {
            let mm = &tvals[m * d..m * d + d];
            let dd = l1_distance(row, mm, d, bd);
            if dd < bd {
                bd = dd;
                bi = mi;
            }
        }
        assignment[r] = bi as u32;
        sizes[bi] += 1;
    }

    KMedoidsResult {
        medoid_indexes: medoid_rows.iter().map(|&m| m as u32).collect(),
        sizes,
        assignment,
    }
}

/// K-Medoids (sampled PAM) for PCP draw simplification.
///
/// Host memory layout (params block, 36 bytes):
///   [0]  values_ptr u32   — f64 row-major [row][axis]
///   [4]  n_rows u32
///   [8]  n_axes u32
///   [12] target_k u32
///   [16] sample_size u32  — 0 = auto (min(n, 1500))
///   [20] swap_rounds u32
///   [24] seed u32
///   [28] specs_ptr u32    — n_axes × f64 triplets [is_cat, min, max]
///   [32] out_ptr u32      — descriptor destination
///
/// Writes descriptor (5 × u32): [medoidPtr, sizesPtr, assignPtr, k, okFlag].
/// Returns out_ptr. k ≥ n short-circuits to identity (every row a medoid).
#[no_mangle]
pub extern "C" fn compute_kmedoids(params_ptr: usize) -> usize {
    unsafe {
        let a = arena();
        let base = params_ptr;
        let rd_u32 = |off: usize| *((base + off) as *const u32);

        let values_ptr = rd_u32(0) as usize;
        let n = rd_u32(4) as usize;
        let d = rd_u32(8) as usize;
        let target_k = rd_u32(12) as usize;
        let sample_arg = rd_u32(16) as usize;
        let swap_rounds = rd_u32(20) as usize;
        let seed = rd_u32(24);
        let specs_ptr = rd_u32(28) as usize;
        let out_ptr = rd_u32(32) as usize;

        let values = std::slice::from_raw_parts(values_ptr as *const f64, n * d);
        let mut specs = Vec::with_capacity(d);
        for i in 0..d {
            let s = specs_ptr + i * 24;
            specs.push((
                *(s as *const f64) != 0.0,
                *((s + 8) as *const f64),
                *((s + 16) as *const f64),
            ));
        }

        let sample_size = if sample_arg == 0 { n.min(1500) } else { sample_arg };

        let result = if target_k >= n {
            // Identity: every row is its own medoid (sizes all 1).
            KMedoidsResult {
                medoid_indexes: (0..n as u32).collect(),
                sizes: vec![1; n],
                assignment: (0..n as u32).collect(),
            }
        } else {
            kmedoids_core(values, n, d, target_k, sample_size, swap_rounds, seed, &specs)
        };

        let k = result.medoid_indexes.len();
        let medoid_bytes = k * 4;
        let medoid_p = a.alloc(medoid_bytes.max(4), 4) as *mut u32;
        let sizes_p = a.alloc(result.sizes.len() * 4, 4) as *mut u32;
        let assign_p = a.alloc(result.assignment.len() * 4, 4) as *mut u32;
        std::ptr::copy_nonoverlapping(result.medoid_indexes.as_ptr(), medoid_p, k);
        std::ptr::copy_nonoverlapping(result.sizes.as_ptr(), sizes_p, result.sizes.len());
        std::ptr::copy_nonoverlapping(result.assignment.as_ptr(), assign_p, result.assignment.len());

        let desc = out_ptr as *mut u32;
        *desc.add(0) = medoid_p as u32;
        *desc.add(1) = sizes_p as u32;
        *desc.add(2) = assign_p as u32;
        *desc.add(3) = k as u32;
        *desc.add(4) = 1; // ok flag
        out_ptr
    }
}
