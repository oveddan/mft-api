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

## One writer at a time

**Nothing prevents two processes from writing to the same controller at once,
and this is deliberate.** A Twister is a single controller on one person's desk;
concurrent writers are an edge case, and defending against them would mean a
cross-process lock and its own failure modes — a stale lock is a device you
cannot write to.

If it does happen, the failure is quiet, and the precondition check does not
save you. Every write carries the **whole** record — all of a global block, all
fifteen tags of an encoder — rebuilt from the snapshot that writer read. So two
applies that never interleave a single frame still lose data:

1. A and B both export. Both hold snapshot `S`, and both preconditions pass,
   because neither has written yet.
2. A writes its record and reads back. Its own change is there. A reports
   success.
3. B writes its record, rebuilt from `S` — which still carries A's tags at
   their *old* values. A's change is silently reverted.
4. B reads back and compares against what `S` plus B's own change implies.
   It matches. B reports success too.

Both processes report success, verification passes for both, and one of the two
changes is gone with nothing recorded to say so. Interleaving frames mid-record
is a further way to corrupt a single record, but it is not the main risk — this
is, and it needs no unlucky timing, only two overlapping reads.

Read-back cannot catch it: each writer verifies against its own expectation, and
both expectations are individually satisfied.

So: don't run two applies against the same controller simultaneously, and don't
build tooling that does. The same applies to the vendor MIDI Fighter Utility —
close it before writing from here.
