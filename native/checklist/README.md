# Existing checklist toggles

This fork preserves the upstream tool surface and adds `set-checklist-item`.

Build on the Mac running Notes:

```sh
swiftc -emit-library native/checklist/toggle.swift -o native/checklist/libnotes-checklist.dylib
```

Set `APPLE_NOTES_MCP_AX_PYTHON` to Hermes' existing Python executable. `worker.py` loads the Swift library into that process on its main thread. The binary needing Accessibility is Python, not a separate helper. No permission grants, TCC changes or Python signing occur during build.

Read `get-note-content` for a fresh `contentHash`. Send `id`, `expectedContentHash`, zero-based checklist `index`, exact unique `text`, and desired `checked`; optional `dryRun` selects without toggling. IDs use the same exact-ID resolver as upstream, including Notes UUIDs and numeric keys. Existing state is a verified no-op. Duplicate text and non-single-line items refuse.

The operation lock covers read, mutation and verification across server processes. The Swift worker additionally holds a nonblocking flock during AX work. A forcibly killed server can leave the operation lock directory; remove `~/.hermes/apple-notes-checklist-operation.lock` only after confirming no operation is running.

The library shows the exact Core Data ID through AppleScript, finds the unique editor with the complete matching native text, raises its window, validates editor and application focus, and verifies a zero-length UTF-16 selection. It sends only Shift-Command-U, addressed to Notes' process. It never types note text, selects all, pastes, writes the database or opens a menu with AXPress. It restores selection and the previously frontmost application. It declines only the exact automatic checklist sorting prompt with **Not Now**; every other modal refuses.

Native readback verifies target identity and desired state, sibling identities/states, complete text, links, tags, objects and formatting. Only the checklist done bit is omitted when comparing formatting signatures. Existing automatic sorting that reorders items fails preservation verification. Errors after submitting an event remain indeterminate; never blindly retry.

Live validation on macOS 26.6.2, 2026-10-10, through the existing managed Hermes Python: both alpha and beta on the dedicated scratch checklist passed dry-run, check, stale-hash refusal and uncheck. Sibling states, native identities, text and formatting were preserved; both items ended unchecked. No new Accessibility grant was required. `get-capabilities` exposes the shipped tool and checks installed runtime artifacts, leaving the actual Accessibility grant unverified until invocation.
