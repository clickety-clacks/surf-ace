import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type SurfaceIdentity = {
  fingerprintPrefix: string;
  privateKeyPem: string;
  publicKeyPem: string;
};

const IDENTITY_FILE_NAME = "surface-identity.json";

export async function loadOrCreateIdentity(stateDir: string): Promise<SurfaceIdentity> {
  const filePath = path.join(stateDir, IDENTITY_FILE_NAME);
  let contents: string | undefined;
  try {
    contents = await readIdentityWithRetry(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let parsed: SurfaceIdentity | undefined;
  if (contents !== undefined) {
    try {
      const candidate = JSON.parse(contents) as SurfaceIdentity;
      if (typeof candidate?.privateKeyPem === "string" && typeof candidate?.publicKeyPem === "string") {
        parsed = candidate;
      }
    } catch {
      // Malformed identity bytes are unreadable and may be replaced.
    }
  }
  if (parsed) {
    let fingerprintPrefix: string | undefined;
    try {
      fingerprintPrefix = publicKeyFingerprintPrefix(parsed.publicKeyPem);
    } catch {
      // A decoded identity with an invalid key is unreadable and may be replaced.
    }
    if (fingerprintPrefix !== undefined) {
      if (parsed.fingerprintPrefix !== fingerprintPrefix) {
        const upgraded = { ...parsed, fingerprintPrefix };
        await fs.writeFile(filePath, JSON.stringify(upgraded, null, 2));
        return upgraded;
      }
      return parsed;
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString("utf8");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");
  const fingerprintPrefix = publicKeyFingerprintPrefix(publicKeyPem);

  const identity = {
    fingerprintPrefix,
    privateKeyPem,
    publicKeyPem,
  };
  await fs.writeFile(filePath, JSON.stringify(identity, null, 2));
  return identity;
}

async function readIdentityWithRetry(filePath: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || attempt >= 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

function publicKeyFingerprintPrefix(publicKeyPem: string): string {
  const publicKeyDer = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  return createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 8);
}
