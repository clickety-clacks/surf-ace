import { pathToFileURL } from "node:url";

export function validateDeployHost(host) {
  const normalized = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (normalized.length === 0) {
    return { ok: false, message: "SURF_ACE_EXTENSION_DEPLOY_HOST is required" };
  }
  if (
    normalized.length > 253 ||
    normalized.includes("..") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)
  ) {
    return {
      ok: false,
      message: "SURF_ACE_EXTENSION_DEPLOY_HOST must be a host name without a scheme, user, port, or path",
    };
  }
  return { ok: true, host: normalized };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateDeployHost(process.env.SURF_ACE_EXTENSION_DEPLOY_HOST);
  if (!result.ok) {
    console.error(`Refusing Surf Ace provider deploy: ${result.message}.`);
    process.exitCode = 1;
  } else {
    console.log(result.host);
  }
}
