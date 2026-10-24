"""Regression for host aliases absent from the Gemini sandbox filesystem."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('launcher', Path(__file__).with_name('gemini-cli-launcher.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTest(unittest.TestCase):
    def test_resolves_existing_alias_and_preserves_missing_path(self):
        with tempfile.TemporaryDirectory() as root:
            real = Path(root) / 'canonical directory'
            real.mkdir()
            alias = Path(root) / 'alias'
            alias.symlink_to(real, target_is_directory=True)
            missing = str(Path(root) / 'missing')
            self.assertEqual(launcher.canonical_directories(f'{alias},{missing}'), f'{real},{missing}')

    def test_preserves_other_arguments_environment_and_execs_node(self):
        for option in [['--include-directories', 'alias'], ['--include-directories=alias']]:
            with self.subTest(option=option), \
                 patch.object(launcher.sys, 'argv', ['gemini', *option, '--prompt', '', '--model', 'gemini-4-argon']), \
                 patch.object(launcher, 'canonical_directories', return_value='/canonical') as canonical, \
                 patch.object(launcher.os, 'execve') as execute:
                launcher.main()
                canonical.assert_called_once_with('alias')
                node, argv, env = execute.call_args.args
                self.assertEqual(node, '/home/admin/.local/bin/node')
                self.assertIs(env, os.environ)
                self.assertEqual(argv[0], node)
                self.assertTrue(argv[1].endswith('/gemini-cli/bundle/gemini.js'))
                self.assertEqual(argv[-4:], ['--prompt', '', '--model', 'gemini-4-argon'])
                self.assertIn('/canonical', ' '.join(argv[2:-4]))

    def test_leaves_incomplete_option_for_cli_validation(self):
        with patch.object(launcher.sys, 'argv', ['gemini', '--include-directories']), \
             patch.object(launcher.os, 'execve') as execute:
            launcher.main()
            self.assertEqual(execute.call_args.args[1][-1], '--include-directories')


if __name__ == '__main__':
    unittest.main()
