# Shrdlu resident-controller replacement and rollback

This plan is review input only. Do not run it before the producer commit receives
the linked `reviewed-clean` verdict. The plan does not authorize changes to
Shrdlu, Racter, EEZO, Aleph, or a Simulator.

## Invariants

- Keep one Surf Ace controller service and one controller state tree.
- Keep the existing Surf Ace client state at
  `/home/clu/.config/@surf-ace/electron`.
- Put controller state below that tree at
  `/home/clu/.config/@surf-ace/electron/controller`.
- Do not copy the Electron state tree or create an alternate state root.
- Do not run the OpenClaw provider beside the resident controller.
- Do not install a second controller package, socket, or service.
- Do not touch Racter. The controller discovers Racter through the same public
  Bonjour and WebSocket protocol that it uses for Shrdlu, macOS, and iPadOS.

## Reviewed replacement

1. Verify the archive SHA-256 against its adjacent `.sha256` file.
2. Verify every unpacked regular file against `manifest.json`.
3. Record the current tmux process, Electron executable hash, listener, and
   primary and backup state-file hashes from the read-only preflight. Record
   the exact current tmux pane launch command without changing it.
4. Stop the existing `surf-ace-compositor` tmux runtime. Do not remove its
   state files.
5. Replace `/opt/surf-ace/controller` and `/usr/local/bin/surf-ace` from the
   reviewed archive. Do not retain a second version elsewhere on Shrdlu.
6. Write the exact recorded tmux pane launch command as
   `SURF_ACE_CLIENT_COMMAND` in `~/.config/surf-ace/runtime.env`. Do not invent
   or normalize the command.
7. Install the reviewed user unit as
   `~/.config/systemd/user/surf-ace-controller.service`.
8. Start exactly that one user unit. Its reviewed supervisor starts the exact
   prior client command and the resident controller as one service. Verify one
   unit, one client process, one controller process, one local socket at
   `%t/surf-ace/controller.sock`, and the existing client listener.
9. Run the installed CLI locally. Verify that `list` reports topology that the
   controller obtained through `surfaces.list` followed by `panes.list`.
10. Continue the coordinator's serialized Shrdlu, Racter, macOS, and iPad gates
   only after the installed commit, package hash, service, state root, process,
   socket, and topology evidence all match.

The unit uses `/home/clu/.config/@surf-ace/electron/controller` only for
controller identity and projections. The Electron client continues to own its
existing files directly under `/home/clu/.config/@surf-ace/electron`.

## Rollback

1. Stop and disable the reviewed controller unit.
2. Restore the previously recorded runtime bytes at their original path.
3. Restart the prior `surf-ace-compositor` command with its original working
   directory and environment.
4. Verify the recorded executable, listener, and primary and backup state-file
   hashes.
5. Keep the failed controller package out of service. Do not start it in
   parallel with the restored runtime.
6. Preserve the controller subdirectory for investigation unless the owner
   explicitly authorizes its removal. The client state files remain unchanged.

Rollback is complete only when process, listener, executable hash, state-file
hashes, and the absence of a second service all match the preflight record.
