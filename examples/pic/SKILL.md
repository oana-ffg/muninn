---
name: pic
description: Receive photos from the user's phone into the current T3 thread through a configured private Muninn instance.
---

Use the configured Muninn client and the actual current T3 environment/thread. Create a
session, give the user its URL, then wait for Done without asking for a typed follow-up.
After delivery, open every local image. The client verifies and acknowledges the bytes.

Claude: run `wait` as a background shell command and register its task ID with
`t3_background_wait`. The completion must resume this thread.

Codex: run `wait` with `exec_command` until it yields a session ID, then continue that
same process with `write_stdin` until complete. Keep the turn active. Do not spawn a
global watcher or inject attachments into other threads.

If the wait fails, report the concrete error and preserve the session ID for `fetch`.
Do not create a new session solely because a download needs retrying.
