# Surf Ace requirements

`DESIGN.md` is normative. Code changes must satisfy its requirements; agents must not edit a requirement to make existing code conform.

Any future change to normative `DESIGN.md` text requires Mike's explicit ruling, named in a separate specification PR. Reviewers reject normative specification edits bundled with code changes. The v0.2.4 restoration of the fleet-unique pane number invariant is authorized by Mike's October 1 ruling and receives the release's one final integrated review.

When Mike approves an exact client change for merge and install but reserves in-use verification for himself, complete the authorized build and installs with normal artifact, version, health, state-preservation, and rollback checks. Then report the exact installed targets as **READY FOR MIKE TO TRY**. Keep actual terminal fit, clipping, flashes, latency, and other live-use behavior unaccepted until Mike reports it. Do not make an agent-run live session or a ttyd/xterm test a pre-install or post-install gate under that handoff. Isolated tests and reviews already authorized may proceed when useful without delaying approved delivery. Keep every unrelated merge, server deployment, security change, and host action within its own approval scope.
