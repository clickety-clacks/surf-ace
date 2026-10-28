import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type SurfaceIdentity = {
  fingerprintPrefix: string;
  privateKeyPem: string;
  publicKeyPem: string;
};

const IDENTITY_FILE_NAME = "surface-identity.json";

export async function loadOrCreateIdentity(
  stateDir: string,
  options: { allowCreate?: boolean } = {},
): Promise<SurfaceIdentity | null> {
  const filePath = path.join(stateDir, IDENTITY_FILE_NAME);
  let contents: string | undefined;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    if (options.allowCreate === false) return null;
    return await createAndPersistIdentity(filePath);
  }

  let parsed: SurfaceIdentity;
  try {
    const candidate = JSON.parse(contents) as Partial<SurfaceIdentity> | null;
    if (!candidate || typeof candidate.privateKeyPem !== "string" ||
        typeof candidate.publicKeyPem !== "string") return null;
    parsed = candidate as SurfaceIdentity;
  } catch {
    // Preserve malformed bytes. A replacement key would register as a different client.
    return null;
  }
  let fingerprintPrefix: string;
  try {
    fingerprintPrefix = publicKeyFingerprintPrefix(parsed.publicKeyPem);
  } catch {
    return null;
  }
  if (parsed.fingerprintPrefix === fingerprintPrefix) return parsed;
  const upgraded = { ...parsed, fingerprintPrefix };
  try {
    await fs.writeFile(filePath, JSON.stringify(upgraded, null, 2));
  } catch (error) {
    // The fingerprint is derived from this persisted key, so it is safe to use
    // for this run while the next launch can retry the metadata repair.
    console.warn(`[surf-ace] identity fingerprint refresh failed: ${String(error)}`);
  }
  return upgraded;
}

async function createAndPersistIdentity(filePath: string): Promise<SurfaceIdentity | null> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString("utf8");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");
  const fingerprintPrefix = publicKeyFingerprintPrefix(publicKeyPem);

  const identity = {
    fingerprintPrefix,
    privateKeyPem,
    publicKeyPem,
  };
  try {
    await fs.writeFile(filePath, JSON.stringify(identity, null, 2));
    return identity;
  } catch {
    // An unpersisted key cannot safely identify this client on a later request.
    return null;
  }
}

function publicKeyFingerprintPrefix(publicKeyPem: string): string {
  const publicKeyDer = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  return createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 8);
}
