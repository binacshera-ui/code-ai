#!/usr/bin/env python3
import argparse
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--x", type=float, required=True)
    parser.add_argument("--y", type=float, required=True)
    parser.add_argument("--width", type=float, required=True)
    parser.add_argument("--height", type=float, required=True)
    args = parser.parse_args()

    source = Path(args.input).resolve()
    target = Path(args.output).resolve()
    with Image.open(source) as image:
        image.load()
        left = max(0, min(image.width - 1, round(args.x * image.width)))
        top = max(0, min(image.height - 1, round(args.y * image.height)))
        right = max(left + 1, min(image.width, round((args.x + args.width) * image.width)))
        bottom = max(top + 1, min(image.height, round((args.y + args.height) * image.height)))
        cropped = image.crop((left, top, right, bottom)).convert("RGBA")
        target.parent.mkdir(parents=True, exist_ok=True)
        cropped.save(target, format="PNG", optimize=True)


if __name__ == "__main__":
    main()
