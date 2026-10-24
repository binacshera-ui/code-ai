#!/usr/bin/python3
"""Resolve directory aliases to the canonical paths mounted by Gemini sandbox."""
import os
import pathlib
import sys


def canonical_directories(value):
    resolved = []
    for name in value.split(','):
        try:
            resolved.append(str(pathlib.Path(name).resolve(strict=True)))
        except (OSError, RuntimeError):
            resolved.append(name)  # Leave invalid paths for the CLI's own error.
    return ','.join(resolved)


def main():
    args = sys.argv[1:]
    for index, value in enumerate(args):
        if value == '--include-directories' and index + 1 < len(args):
            args[index + 1] = canonical_directories(args[index + 1])
        elif value.startswith('--include-directories='):
            args[index] = '--include-directories=' + canonical_directories(value.split('=', 1)[1])

    node = '/home/admin/.local/bin/node'
    cli = '/home/admin/.local/lib/code-ai-gemini-0.41.2/gemini-cli/bundle/gemini.js'
    os.execve(node, [node, cli, *args], os.environ)


if __name__ == '__main__':
    main()
