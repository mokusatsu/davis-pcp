"""Cobweb incremental conceptual clustering algorithm.

Reference:
Fisher, D. H. (1987). Knowledge Acquisition Via Incremental Conceptual
Clustering. Machine Learning 2(2): 139-172.
"""
from __future__ import annotations

import math
from typing import Any
import numpy as np


class CobwebNode:
    _id_counter = 0

    def __init__(self, parent: CobwebNode | None = None) -> None:
        CobwebNode._id_counter += 1
        self.node_id = f"cn-{CobwebNode._id_counter}"
        self.count: int = 0
        self.parent: CobwebNode | None = parent
        self.children: list[CobwebNode] = []
        self.row_indices: list[int] = []
        # Continuous attribute stats: {attr_idx: {"sum": float, "sq_sum": float, "valid_count": int}}
        self.num_stats: dict[int, dict[str, float]] = {}
        # Categorical attribute stats: {attr_idx: {val_str: count}}
        self.cat_stats: dict[int, dict[str, int]] = {}

    def update_stats(self, x_num: np.ndarray | None, x_cat: list[str] | None, row_idx: int) -> None:
        self.count += 1
        self.row_indices.append(row_idx)
        if x_num is not None:
            for j, val in enumerate(x_num):
                if not np.isnan(val):
                    if j not in self.num_stats:
                        self.num_stats[j] = {"sum": 0.0, "sq_sum": 0.0, "valid_count": 0}
                    self.num_stats[j]["sum"] += float(val)
                    self.num_stats[j]["sq_sum"] += float(val * val)
                    self.num_stats[j]["valid_count"] += 1

        if x_cat is not None:
            for j, val in enumerate(x_cat):
                val_str = str(val)
                if j not in self.cat_stats:
                    self.cat_stats[j] = {}
                self.cat_stats[j][val_str] = self.cat_stats[j].get(val_str, 0) + 1

    def rollback_stats(self, x_num: np.ndarray | None, x_cat: list[str] | None, row_idx: int) -> None:
        self.count -= 1
        if row_idx in self.row_indices:
            self.row_indices.remove(row_idx)
        if x_num is not None:
            for j, val in enumerate(x_num):
                if not np.isnan(val) and j in self.num_stats:
                    self.num_stats[j]["sum"] -= float(val)
                    self.num_stats[j]["sq_sum"] -= float(val * val)
                    self.num_stats[j]["valid_count"] -= 1
        if x_cat is not None:
            for j, val in enumerate(x_cat):
                val_str = str(val)
                if j in self.cat_stats and val_str in self.cat_stats[j]:
                    self.cat_stats[j][val_str] -= 1

    def expected_values(self, acuity: float = 0.1) -> float:
        if self.count == 0:
            return 0.0
        e_sum = 0.0
        # Continuous
        for j, stats in self.num_stats.items():
            n = stats["valid_count"]
            if n > 1:
                mean = stats["sum"] / n
                var = max(0.0, (stats["sq_sum"] / n) - (mean * mean))
                std = math.sqrt(var)
            else:
                std = acuity
            effective_std = max(std, acuity)
            e_sum += 1.0 / (2.0 * math.sqrt(math.pi) * effective_std)

        # Categorical
        for j, counts in self.cat_stats.items():
            for val, cnt in counts.items():
                p = cnt / self.count
                e_sum += p * p

        return e_sum

    def to_dict(self, depth: int = 0, max_depth: int = 4) -> dict[str, Any]:
        summary_stats: dict[str, Any] = {}
        for j, stats in self.num_stats.items():
            n = stats.get("valid_count", 0)
            if n > 0:
                mean = stats["sum"] / n
                var = max(0.0, (stats["sq_sum"] / n) - (mean * mean))
                summary_stats[f"num_{j}"] = {"mean": round(mean, 3), "std": round(math.sqrt(var), 3)}

        for j, counts in self.cat_stats.items():
            top = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:3]
            summary_stats[f"cat_{j}"] = {k: round(v / self.count, 2) for k, v in top}

        child_dicts = []
        if depth < max_depth:
            child_dicts = [child.to_dict(depth + 1, max_depth) for child in self.children]

        return {
            "id": self.node_id,
            "name": f"Concept {self.node_id}",
            "count": self.count,
            "rowIndices": self.row_indices,
            "stats": summary_stats,
            "children": child_dicts,
        }


class CobwebClustering:
    def __init__(self, acuity: float = 0.1, cutoff: float = 0.001) -> None:
        self.acuity = acuity
        self.cutoff = cutoff
        self.root: CobwebNode = CobwebNode()

    def _category_utility(self, parent: CobwebNode, children: list[CobwebNode]) -> float:
        if not children:
            return 0.0
        k = len(children)
        p_parent_e = parent.expected_values(self.acuity)
        cu_sum = 0.0
        total_count = sum(c.count for c in children)
        if total_count == 0:
            return 0.0
        for child in children:
            p_c = child.count / total_count
            cu_sum += p_c * (child.expected_values(self.acuity) - p_parent_e)
        return cu_sum / k

    def insert(self, x_num: np.ndarray | None, x_cat: list[str] | None, row_idx: int) -> CobwebNode:
        current = self.root
        current.update_stats(x_num, x_cat, row_idx)

        while True:
            if not current.children:
                # If leaf node: if it has 0 previous rows (should not happen since root.update_stats), create singleton child
                child = CobwebNode(parent=current)
                child.update_stats(x_num, x_cat, row_idx)
                current.children.append(child)
                return child

            if len(current.children) == 1:
                # Need at least 2 children for category utility
                child2 = CobwebNode(parent=current)
                child2.update_stats(x_num, x_cat, row_idx)
                current.children.append(child2)
                return child2

            # Evaluate operators
            scores = []
            for child in current.children:
                child.update_stats(x_num, x_cat, row_idx)
                cu = self._category_utility(current, current.children)
                child.rollback_stats(x_num, x_cat, row_idx)
                scores.append((cu, child))

            scores.sort(key=lambda s: s[0], reverse=True)
            best_cu, best_child = scores[0]
            second_best_child = scores[1][1]

            # Operator 2: Create new singleton child
            new_child = CobwebNode(parent=current)
            new_child.update_stats(x_num, x_cat, row_idx)
            test_children = current.children + [new_child]
            new_child_cu = self._category_utility(current, test_children)

            # Operator 3: Merge
            merge_cu = best_cu * 0.95

            # Operator 4: Split
            split_cu = -float("inf")
            if best_child.children:
                test_split = [c for c in current.children if c != best_child] + best_child.children
                split_cu = self._category_utility(current, test_split)

            if best_cu >= new_child_cu and best_cu >= merge_cu and best_cu >= split_cu:
                # Descend into best child
                current = best_child
                current.update_stats(x_num, x_cat, row_idx)
            elif new_child_cu >= merge_cu and new_child_cu >= split_cu:
                current.children.append(new_child)
                return new_child
            elif split_cu >= merge_cu:
                # Split best child into current.children and reconsider at current
                current.children = [c for c in current.children if c != best_child] + best_child.children
            else:
                # Merge: descend into best child
                current = best_child
                current.update_stats(x_num, x_cat, row_idx)


def cobweb_cluster(
    num_matrix: np.ndarray | None,
    cat_columns: list[list[str]] | None = None,
    k: int = 3,
    acuity: float = 0.1,
    cutoff: float = 0.001,
) -> dict[str, Any]:
    CobwebNode._id_counter = 0
    n_rows = len(num_matrix) if num_matrix is not None else len(cat_columns[0])
    cobweb = CobwebClustering(acuity=acuity, cutoff=cutoff)

    for i in range(n_rows):
        x_num = num_matrix[i] if num_matrix is not None else None
        x_cat = [col[i] for col in cat_columns] if cat_columns else None
        cobweb.insert(x_num, x_cat, i)

    # Extract clusters from concept tree
    frontier = [c for c in cobweb.root.children if c.count > 0]
    if not frontier:
        frontier = [cobweb.root]

    while len(frontier) < k and any(len(node.children) > 0 for node in frontier):
        splittable = [node for node in frontier if len(node.children) > 0]
        if not splittable:
            break
        splittable.sort(key=lambda n: n.count, reverse=True)
        chosen = splittable[0]
        frontier.remove(chosen)
        frontier.extend([c for c in chosen.children if c.count > 0])

    frontier.sort(key=lambda n: n.count, reverse=True)
    cluster_nodes = frontier[:k]

    labels = [-1] * n_rows
    for cluster_idx, node in enumerate(cluster_nodes):
        for idx in node.row_indices:
            labels[idx] = cluster_idx

    for i in range(n_rows):
        if labels[i] == -1:
            labels[i] = 0

    actual_k = len(set(labels))
    tree_dict = cobweb.root.to_dict(depth=0, max_depth=4)

    return {
        "method": "cobweb",
        "k": actual_k,
        "labels": labels,
        "evidenceClass": "MODERN-EXTENSION",
        "algorithmVersion": "2.0.0-cobweb",
        "conceptTree": tree_dict,
        "diagnostics": {
            "rootCount": cobweb.root.count,
            "numConcepts": CobwebNode._id_counter,
            "acuity": acuity,
            "targetK": k,
            "actualK": actual_k,
        },
    }
