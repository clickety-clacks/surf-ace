# Controller allocator connection

`PublicControllerWireClient.connectAllocatorSurface` connects to the existing
allocator WebSocket endpoint, binds the caller's authority, and returns a committed
window-label assignment. It uses `authority.bind` followed by `label.claim`.
Pass the previous assignment on reconnect to use `label.reconfirm` instead.
Allocator errors reject the call; the method does not generate a local label.

The caller supplies the existing fleet, allocator, authority, owner anchor, and
surface identities. This slice does not create credentials, persist assignments,
or attach the label to an Electron or iOS window. The caller owns transport closure.

After building the protocol and controller packages, run from the repository root
against an already configured disposable allocator:

```sh
pnpm --filter @surf-ace/protocol build
pnpm --filter @surf-ace/controller build
ALLOCATOR_URL=ws://127.0.0.1:PORT \
FLEET_ID=FLEET ALLOCATOR_ID=alloc_ID \
AUTHORITY_ID=auth_EXISTING_ID OWNER_ANCHOR_ID=owner_EXISTING_ID \
SURFACE_ID=sf_EXISTING_ID node --input-type=module <<'JS'
import { PublicControllerWireClient } from './packages/controller/dist/index.js';
const wire = new PublicControllerWireClient(process.env.ALLOCATOR_URL);
const identity = {
  fleetId: process.env.FLEET_ID,
  expectedAllocatorId: process.env.ALLOCATOR_ID,
  authorityId: process.env.AUTHORITY_ID,
  ownerAnchorId: process.env.OWNER_ANCHOR_ID,
  surfaceId: process.env.SURFACE_ID,
};
try {
  const first = await wire.connectAllocatorSurface(identity);
  console.log({ first });
  await wire.close();
  const resumed = await wire.connectAllocatorSurface(identity, first);
  console.log({ resumed });
} finally {
  await wire.close();
}
JS
```

The executable integration test creates its own loopback PostgreSQL 16 primary
and synchronous witness, allocator server, and two controller connections. It
checks distinct labels for colliding surface IDs, reconnect identity and label
continuity without advancing the allocation fence, and identity/assignment
conflict refusal. It prints the real assignments and removes its database fixture.
It uses Homebrew PostgreSQL 16 on macOS and `/usr/lib/postgresql/16/bin` on Linux.

```sh
pnpm --filter @surf-ace/allocator test
pnpm --filter @surf-ace/controller test
```
