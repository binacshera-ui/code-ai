# Preserve MCP permission custody on PCI

The PCI native adapter still uses broker SHA256 `e0167f45060bf1e4a8e950632882cadaefd040d0b79d2004e7165032ecebf57a`. Its early settings restore causes actual Design and UX MCP calls to fail with `user rejected MCP tool call`, even when the product requested never/full-access. The websites bootstrap reproduced this in ordinary Code AI session `01a16f4e-d35c-7cf2-9c73-f4c2c37860da`.

This source captures the existing accepted main-server correction, broker SHA256 `549521208ff51e98a1df22b174b0d6217656707563c32715247ea890cd755cbd`, and its three unchanged runtime imports. The broker retains requested settings until the exact own turn finishes, including recovery, and restores the prior settings afterwards. It does not broaden policy, bypass an approval handler or relabel mutation tools.

The four runtime files were absent from canonical origin/main but exist in the live fleet source. This PR preserves them as a scoped dependency closure. The PCI candidate is created from the complete existing four-file closure, changes only the broker and preserves hashes of all other dependencies. There is no frontend/API/native-binary rebuild.

Activation uses the previously installed one-use adapter handoff. The recorded native PID/generation, history, lock and socket remain intact. The predecessor plan, custody record and journal are saved before the adapter replacement. No native writer or active business job may be killed. Independent verification must prove both real Gemini mode responses through the ordinary Code AI queue, not a direct provider workaround.

The existing correction was qualified against Codex0.163.0 with26 broker unit tests,20 native-runner tests,7 exact-native MCP contract checks and30 native submission/recovery checks. Rerun the focused broker test here. The websites bootstrap separately installs GeminiCLI0.41.2 and a private credential profile; no credentials belong in this repository.

The next integration failure was a sandbox path alias: Code AI passed `/var/lib/code-ai-pci/...` as `--include-directories`, whereas Gemini mounted its canonical working directory under `/srv/beam254/code-ai-native/state/...`. `ops/gemini-cli-launcher.py` resolves only existing include-directory arguments before replacing itself with the pinned Node/CLI process. All other arguments, environment, approvals and isolation stay intact; it adds no mounts and reads no credentials. The configured Gemini binary symlink points to this launcher. Run `python3 ops/test_gemini_cli_launcher.py` for its focused regression checks.
