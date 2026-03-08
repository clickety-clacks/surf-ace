const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const IDENTITY_FILE = 'surf-ace-identity.json';

function computeFingerprint(publicKeyPem) {
  const publicKeyDer = crypto
    .createPublicKey(publicKeyPem)
    .export({ format: 'der', type: 'spki' });
  return crypto
    .createHash('sha256')
    .update(publicKeyDer)
    .digest('hex')
    .slice(0, 8);
}

function createIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
  });

  const fingerprint = computeFingerprint(publicKey);
  return {
    createdAt: Date.now(),
    fingerprint,
    privateKey,
    publicKey
  };
}

function loadOrCreateIdentity(userDataDir) {
  const identityPath = path.join(userDataDir, IDENTITY_FILE);

  if (fs.existsSync(identityPath)) {
    const parsed = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    return {
      ...parsed,
      fingerprint: computeFingerprint(parsed.publicKey)
    };
  }

  const identity = createIdentity();
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  return identity;
}

module.exports = {
  loadOrCreateIdentity
};
