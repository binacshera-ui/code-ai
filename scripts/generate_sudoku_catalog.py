#!/usr/bin/env python3
"""
Generate a curated Sudoku catalog for code-ai.

The generator creates full solutions, removes clues while preserving uniqueness,
rates the resulting puzzle, and writes a TypeScript module consumable by the UI.
The rating is not just clue-count based: it also reflects how much search/backtracking
the solver had to perform after exhausting singles.
"""

from __future__ import annotations

import argparse
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

ALL_DIGITS = set(range(1, 10))
ROWS = COLS = range(9)


@dataclass(frozen=True)
class DifficultyProfile:
    name: str
    min_givens: int
    max_givens: int
    target_givens: int
    min_search_nodes: int
    max_search_nodes: int


DIFFICULTY_PROFILES: Dict[str, DifficultyProfile] = {
    "hard": DifficultyProfile("hard", 30, 35, 33, 0, 16),
    "expert": DifficultyProfile("expert", 27, 31, 29, 8, 90),
    "fiendish": DifficultyProfile("fiendish", 24, 29, 26, 32, 320),
    "code-ai": DifficultyProfile("code-ai", 22, 27, 24, 80, 1200),
}


def box_index(row: int, col: int) -> int:
    return (row // 3) * 3 + (col // 3)


def related_indices(index: int) -> set[int]:
    row, col = divmod(index, 9)
    result = set()
    for c in COLS:
      result.add(row * 9 + c)
    for r in ROWS:
      result.add(r * 9 + col)
    start_row = (row // 3) * 3
    start_col = (col // 3) * 3
    for r in range(start_row, start_row + 3):
        for c in range(start_col, start_col + 3):
            result.add(r * 9 + c)
    result.discard(index)
    return result


PEERS = [related_indices(index) for index in range(81)]


def candidates(grid: Sequence[int], index: int) -> set[int]:
    if grid[index] != 0:
        return {grid[index]}
    used = {grid[peer] for peer in PEERS[index] if grid[peer] != 0}
    return ALL_DIGITS - used


def select_unfilled_cell(grid: Sequence[int]) -> Optional[Tuple[int, List[int]]]:
    best_index = None
    best_candidates: Optional[List[int]] = None
    for index, value in enumerate(grid):
        if value != 0:
            continue
        next_candidates = sorted(candidates(grid, index))
        if not next_candidates:
            return index, []
        if best_candidates is None or len(next_candidates) < len(best_candidates):
            best_index = index
            best_candidates = next_candidates
            if len(best_candidates) == 1:
                break
    if best_index is None or best_candidates is None:
        return None
    return best_index, best_candidates


def solve_grid(grid: Sequence[int], rng: Optional[random.Random] = None) -> Optional[List[int]]:
    working = list(grid)

    def dfs() -> bool:
        selected = select_unfilled_cell(working)
        if selected is None:
            return True

        index, options = selected
        if not options:
            return False

        if rng:
            rng.shuffle(options)

        for value in options:
            working[index] = value
            if dfs():
                return True
        working[index] = 0
        return False

    return working if dfs() else None


def count_solutions(grid: Sequence[int], limit: int = 2) -> int:
    working = list(grid)
    count = 0

    def dfs() -> None:
        nonlocal count
        if count >= limit:
            return
        selected = select_unfilled_cell(working)
        if selected is None:
            count += 1
            return
        index, options = selected
        if not options:
            return
        for value in options:
            working[index] = value
            dfs()
            if count >= limit:
                break
        working[index] = 0

    dfs()
    return count


def fill_singles(grid: List[int]) -> Tuple[int, int]:
    naked_single_count = 0
    hidden_single_count = 0
    progress = True

    while progress:
        progress = False
        for index, value in enumerate(grid):
            if value != 0:
                continue
            next_candidates = candidates(grid, index)
            if len(next_candidates) == 1:
                grid[index] = next(iter(next_candidates))
                naked_single_count += 1
                progress = True

        for unit in build_units():
            counts: Dict[int, List[int]] = {digit: [] for digit in range(1, 10)}
            for index in unit:
                if grid[index] != 0:
                    continue
                for digit in candidates(grid, index):
                    counts[digit].append(index)
            for digit, positions in counts.items():
                if len(positions) == 1:
                    target_index = positions[0]
                    if grid[target_index] == 0:
                        grid[target_index] = digit
                        hidden_single_count += 1
                        progress = True

    return naked_single_count, hidden_single_count


def build_units() -> List[List[int]]:
    units: List[List[int]] = []
    for row in ROWS:
        units.append([row * 9 + col for col in COLS])
    for col in COLS:
        units.append([row * 9 + col for row in ROWS])
    for box_row in range(0, 9, 3):
        for box_col in range(0, 9, 3):
            units.append([
                (box_row + delta_row) * 9 + (box_col + delta_col)
                for delta_row in range(3)
                for delta_col in range(3)
            ])
    return units


UNITS = build_units()


def rate_puzzle(grid: Sequence[int], solution: Sequence[int]) -> Dict[str, int]:
    working = list(grid)
    naked_singles, hidden_singles = fill_singles(working)
    search_nodes = 0
    branch_count = 0

    def dfs() -> bool:
        nonlocal search_nodes, branch_count
        selected = select_unfilled_cell(working)
        if selected is None:
            return True
        index, options = selected
        if not options:
            return False
        if len(options) > 1:
            branch_count += 1
        for value in options:
            search_nodes += 1
            working[index] = value
            if dfs():
                return True
        working[index] = 0
        return False

    dfs()
    givens = sum(1 for value in grid if value != 0)
    wrong_cells = sum(
        1
        for index, value in enumerate(working)
        if value != 0 and value != solution[index]
    )
    score = (
        (81 - givens) * 3
        + naked_singles * 2
        + hidden_singles * 4
        + branch_count * 16
        + search_nodes * 3
        + wrong_cells * 40
    )
    return {
        "givens": givens,
        "naked_singles": naked_singles,
        "hidden_singles": hidden_singles,
        "search_nodes": search_nodes,
        "branch_count": branch_count,
        "score": score,
    }


def remove_clues(solution: Sequence[int], profile: DifficultyProfile, rng: random.Random) -> List[int]:
    puzzle = list(solution)
    cells = list(range(81))
    rng.shuffle(cells)

    for index in cells:
        if sum(1 for value in puzzle if value != 0) <= profile.target_givens:
            break
        backup = puzzle[index]
        puzzle[index] = 0
        if count_solutions(puzzle, limit=2) != 1:
            puzzle[index] = backup

    return puzzle


def generate_full_solution(rng: random.Random) -> List[int]:
    empty = [0] * 81
    solved = solve_grid(empty, rng=rng)
    if solved is None:
        raise RuntimeError("Failed to generate a full Sudoku solution")
    return solved


def generate_puzzle(profile: DifficultyProfile, rng: random.Random) -> Tuple[List[int], List[int], Dict[str, int]]:
    attempts = 0
    best_candidate: Optional[Tuple[List[int], List[int], Dict[str, int]]] = None

    while attempts < 120:
        attempts += 1
        solution = generate_full_solution(rng)
        puzzle = remove_clues(solution, profile, rng)
        rating = rate_puzzle(puzzle, solution)

        if profile.min_givens <= rating["givens"] <= profile.max_givens:
            if profile.min_search_nodes <= rating["search_nodes"] <= profile.max_search_nodes:
                return puzzle, solution, rating

        if best_candidate is None:
            best_candidate = (puzzle, solution, rating)
            continue

        previous_gap = abs(best_candidate[2]["search_nodes"] - profile.target_givens)
        next_gap = abs(rating["search_nodes"] - profile.target_givens)
        if next_gap < previous_gap:
            best_candidate = (puzzle, solution, rating)

    if best_candidate is None:
        raise RuntimeError(f"Failed to generate puzzle for {profile.name}")
    return best_candidate


def encode_grid(grid: Sequence[int]) -> str:
    return "".join(str(value) for value in grid)


def generate_catalog(levels: Iterable[str], per_level: int, seed: int) -> Dict[str, List[dict]]:
    rng = random.Random(seed)
    catalog: Dict[str, List[dict]] = {}
    for level_name in levels:
        profile = DIFFICULTY_PROFILES[level_name]
        catalog[level_name] = []
        for puzzle_index in range(per_level):
            puzzle, solution, rating = generate_puzzle(profile, rng)
            catalog[level_name].append(
                {
                    "id": f"{level_name}-{puzzle_index + 1}",
                    "difficulty": profile.name,
                    "clueCount": rating["givens"],
                    "rating": rating["score"],
                    "searchNodes": rating["search_nodes"],
                    "puzzle": encode_grid(puzzle),
                    "solution": encode_grid(solution),
                }
            )
    return catalog


def render_typescript(catalog: Dict[str, List[dict]]) -> str:
    lines = [
        "export type SudokuPuzzleDifficulty = 'hard' | 'expert' | 'fiendish' | 'code-ai';",
        "",
        "export interface SudokuPuzzleRecord {",
        "  id: string;",
        "  difficulty: SudokuPuzzleDifficulty;",
        "  clueCount: number;",
        "  rating: number;",
        "  searchNodes: number;",
        "  puzzle: string;",
        "  solution: string;",
        "}",
        "",
        "export const SUDOKU_CATALOG: Record<SudokuPuzzleDifficulty, SudokuPuzzleRecord[]> = {",
    ]

    for level_name in ("hard", "expert", "fiendish", "code-ai"):
        lines.append(f"  '{level_name}': [")
        for record in catalog[level_name]:
            lines.append(
                "    { "
                f"id: '{record['id']}', "
                f"difficulty: '{record['difficulty']}', "
                f"clueCount: {record['clueCount']}, "
                f"rating: {record['rating']}, "
                f"searchNodes: {record['searchNodes']}, "
                f"puzzle: '{record['puzzle']}', "
                f"solution: '{record['solution']}'"
                " },"
            )
        lines.append("  ],")
    lines.append("};")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Sudoku catalog for code-ai")
    parser.add_argument("--levels", nargs="+", default=["hard", "expert", "fiendish", "code-ai"])
    parser.add_argument("--per-level", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20260510)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/root/projects/bina-cshera/web/app/client/src/components/codex/sudokuCatalog.ts"),
    )
    args = parser.parse_args()

    unknown = [level for level in args.levels if level not in DIFFICULTY_PROFILES]
    if unknown:
        raise SystemExit(f"Unknown levels: {', '.join(unknown)}")

    catalog = generate_catalog(args.levels, args.per_level, args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_typescript(catalog), encoding="utf-8")
    print(f"Wrote {sum(len(items) for items in catalog.values())} puzzles to {args.output}")


if __name__ == "__main__":
    main()
