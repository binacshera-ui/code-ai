# Terminal UX release — 2026-10-11

Scope: terminal scrolling, interactive Codex launch, Hebrew reading/input, and retention of the shared-owner/default-model fixes. Authentication configuration is preserved; no credential rotation.

The previous global CLI and the native shared owner used different executable paths. A working newer owner therefore did not prove that a terminal's `codex` command used the same version. This release resolves and pins the qualified native executable before the login shell changes PATH, displays its version, and launches with `--remote unix://… --no-alt-screen`. The updater regression test rejects a downgrade from 0.162.1 to 0.154.0. There is no evidence here of an intentional downgrade.

Normal-buffer wheel scrolling is intercepted before xterm's own handler; alternate-screen mouse input remains available to native TUIs. Modified history keys and explicit history controls are provided. The Hebrew reader joins soft-wrapped lines and uses browser bidirectional layout. The input editor preserves Hebrew UTF-8 and separates paste from Enter; multiline paste is refused when bracketed-paste mode is unavailable. The raw terminal grid remains left-to-right to preserve cursor positioning.

Qualification: 352 application tests plus three installer-ordering tests; 14 isolated Chromium checks; focused real PTY UTF-8 and launcher tests. These are local qualifications, not a BEAM-attested build. The older queued BEAM request is not used for deployment.

Release: `5cdfa175-024d-4267-983b-59b3b8dedb5a`. Compiled application SHA256: `33db1f3f25dbaa8c2df21bde65075a75b2c66b6cb2b305090bdbe770eee19dff`. All four targets (main, BEAM, PCI and Ubuntu) were activated and verified. Final installed state and real native-TUI acceptance are recorded in `ops/terminal-ux/final-receipt.json`. Acceptance completed at 05:32:39 UTC: real PTY UTF-8, actual Codex TUI launch through the shared-owner socket, and Hebrew input passed without submitting a model request. Main, BEAM and PCI use 0.162.1; Ubuntu retains the installed application binary 0.162.0-alpha.2.

An earlier BEAM attempt was rolled back because a legacy systemd drop-in took precedence. The new installer uses monotonically ordered overrides and verifies effective configuration before stopping a service. PCI staging uses its existing data volume rather than the smaller root volume. No existing releases, histories or credentials were deleted.

Windows and the personal Chrome connection were unavailable during this task. Windows was not deployed, and personal Chrome QA was not completed.
