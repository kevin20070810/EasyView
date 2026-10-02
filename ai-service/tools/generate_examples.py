# -*- coding: utf-8 -*-
"""用三份真实 elements 样例生成 B 组 ui_schema 联调样例。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AI_DIR = HERE.parent
REPO_DIR = AI_DIR.parent
sys.path.insert(0, str(AI_DIR))

from pipeline import analyze, load_elements_file, write_json  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 EasyView B 组 ui_schema 样例")
    parser.add_argument(
        "--output-dir",
        default=str(AI_DIR / "examples"),
        help="输出目录，默认 ai-service/examples",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    examples = sorted((REPO_DIR / "docs" / "examples").glob("elements.*.json"))
    if not examples:
        print("没有找到 elements.*.json", file=sys.stderr)
        return 1

    for source in examples:
        name = source.name.removeprefix("elements.").removesuffix(".json")
        result = analyze(load_elements_file(source))
        target = output_dir / f"ui_schema.{name}.json"
        write_json(target, result)
        print(f"{name}: {len(result['cards'])} cards -> {target}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())