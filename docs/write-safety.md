# Write-path safety design

Live writes are narrowly enabled through the guarded `apply` command for strongly
identified firmware `2026-07-02` devices. The offline planner remains incapable
of opening MIDI or sending bytes.

The write implementation must preserve these invariants:

1. One full device snapshot is simultaneously the backup, planning basis, and
   expected-old source. Its stable state hash excludes timestamps and port names.
2. A plan is content-addressed and bound to unit ID, firmware, family, model,
   and snapshot hash. Plans expire after 15 minutes and will be single-use.
3. Unknown future firmware is rejected. Live writes begin allowlisted only for
   firmware `2026-07-02`; legacy exports and offline plans remain supported.
4. An affected record begins with all freshly pulled raw tags. Only requested
   tags change, and every other allowlisted tag is emitted verbatim in byte-level
   dry runs. Unknown tag layouts are refused because the firmware's global decoder
   does not safely ignore arbitrary future tags.
5. The future applier will re-pull immediately before writing and reject stale
   expected values. Writes are sequential and are not automatically retried.
6. Before each send, an append-only journal records `pending`. Outcomes are
   `verified`, `failed`, or `unknown`; timeout after send is always `unknown`.
7. Verification includes the changed record immediately and a final full-device
   snapshot comparison. No automatic restore occurs after an ambiguous failure;
   the CLI prints the backup and exact confirmed restore command.
8. Identity/topology-changing globals are isolated, ordered last, and require a
   new discovery and confirmation cycle.
9. Chat integrations can create plans and submit confirmed plan IDs. They never
   receive raw MIDI transport access.

Before support broadens beyond the current allowlist, tests must additionally
cover journal recovery, two attached devices, timeouts before and after send,
normalized fields, and confirmed restore.
