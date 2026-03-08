const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const { loadOrCreateIdentity } = require('../src/identity');
const { MdnsAdvertiser } = require('../src/mdnsAdvertiser');
const { SurfAceState } = require('../src/surfAceState');

function computePk(publicKeyPem) {
  const publicKeyDer = crypto
    .createPublicKey(publicKeyPem)
    .export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 8);
}

function makeState(identity, name = 'Kitchen Display') {
  return new SurfAceState({
    identity,
    screenName: name,
    viewport: { height: 1080, scale: 2, width: 1920 }
  });
}

test('DISC-E-01 advertises _surf-ace._tcp service type', () => {
  const spawnCalls = [];
  const fakeChild = new EventEmitter();
  fakeChild.kill = () => {};

  const advertiser = new MdnsAdvertiser({
    logger: console,
    port: 18791,
    serviceName: 'Kitchen Display (deadbeef)',
    systemDeps: {
      spawn: (...args) => {
        spawnCalls.push(args);
        return fakeChild;
      },
      spawnSync: (_cmd, argv) => ({ status: argv[0] === 'avahi-publish-service' ? 0 : 1 })
    },
    txtRecordsProvider: () => ({ busy: '0', name: 'Kitchen Display', pk: 'deadbeef', v: '1' })
  });

  advertiser.start();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], 'avahi-publish-service');
  assert.equal(spawnCalls[0][1][1], '_surf-ace._tcp');
  assert.equal(spawnCalls[0][1][2], '18791');
});

test('DISC-E-02 DISC-E-03 DISC-E-04 DISC-E-05 DISC-E-06 DISC-E-07 TXT records expose required keys and expected values', () => {
  const identity = {
    fingerprint: 'deadbeef',
    privateKey: 'pk',
    publicKey: 'pub'
  };
  const state = makeState(identity);
  const txt = state.getTxtRecords();

  for (const key of ['name', 'v', 'w', 'h', 's', 'cap', 'busy', 'pk', 'ws', 'tls']) {
    assert.ok(txt[key], `missing ${key}`);
  }

  assert.equal(txt.v, '1');
  assert.equal(txt.w, '1920');
  assert.equal(txt.h, '1080');
  assert.equal(txt.s, '2');
  assert.equal(txt.cap, '31');
  assert.equal(txt.busy, '0');
  assert.equal(txt.ws, '/ws');
  assert.equal(txt.tls, '0');
});

test('DISC-E-08 DISC-E-09 DISC-E-13 busy transitions reflect session state quickly', async () => {
  const identity = {
    fingerprint: 'deadbeef',
    privateKey: 'pk',
    publicKey: 'pub'
  };
  const state = makeState(identity);
  const session = {
    busy: true,
    providerId: 'pv_test',
    sessionId: 'sa_test_session'
  };

  const start = Date.now();
  state.setSession(session);
  assert.equal(state.getTxtRecords().busy, '1');
  assert.ok(Date.now() - start < 1000);

  const endStart = Date.now();
  state.clearSession();
  assert.equal(state.getTxtRecords().busy, '0');
  assert.ok(Date.now() - endStart < 1000);
});

test('DISC-E-10 pk is first 8 hex chars of SHA-256(public key)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-ace-identity-'));
  const identity = loadOrCreateIdentity(dir);
  assert.equal(identity.fingerprint, computePk(identity.publicKey));
});

test('DISC-E-11 identity persists across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-ace-identity-'));
  const first = loadOrCreateIdentity(dir);
  const second = loadOrCreateIdentity(dir);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('DISC-E-12 new keypair generated only after identity reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-ace-identity-'));
  const identityFile = path.join(dir, 'surf-ace-identity.json');

  const first = loadOrCreateIdentity(dir);
  const second = loadOrCreateIdentity(dir);
  assert.equal(first.fingerprint, second.fingerprint);

  fs.rmSync(identityFile, { force: true });
  const third = loadOrCreateIdentity(dir);
  assert.notEqual(first.fingerprint, third.fingerprint);
});

test('EDGE-E-13 two screens with same name publish distinct pk fingerprints', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-ace-identity-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-ace-identity-b-'));

  const identityA = loadOrCreateIdentity(dirA);
  const identityB = loadOrCreateIdentity(dirB);
  const stateA = makeState(identityA, 'Shared Name');
  const stateB = makeState(identityB, 'Shared Name');

  assert.notEqual(stateA.getTxtRecords().pk, stateB.getTxtRecords().pk);
});

test('EDGE-E-14 factory reset rotates pk fingerprint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-ace-identity-'));
  const identityFile = path.join(dir, 'surf-ace-identity.json');

  const first = loadOrCreateIdentity(dir);
  fs.rmSync(identityFile, { force: true });
  const second = loadOrCreateIdentity(dir);

  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.match(second.fingerprint, /^[0-9a-f]{8}$/);
});
