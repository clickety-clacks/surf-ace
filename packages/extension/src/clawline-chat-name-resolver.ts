import { execFile } from "node:child_process";
import { join } from "node:path";

const DEFAULT_SQLITE_TIMEOUT_MS = 1000;
const SQLITE_MAX_BUFFER_BYTES = 8192;

export type RunSqlite = (args: string[], timeoutMs: number) => Promise<string>;

export type ClawlineChatNameResolverOptions = {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  openClawStateDir?: string;
  runSqlite?: RunSqlite;
  timeoutMs?: number;
};

export function resolveDefaultClawlineChatDbPath(
  openClawStateDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const stateDir = cleanDisplayString(openClawStateDir);
  if (stateDir) {
    return join(stateDir, "clawline", "clawline.sqlite");
  }

  const home = cleanDisplayString(env.HOME);
  return home ? join(home, ".openclaw", "clawline", "clawline.sqlite") : undefined;
}

export async function resolveClawlineChatDisplayName(
  sessionKey: string | undefined,
  options: ClawlineChatNameResolverOptions = {},
): Promise<string | undefined> {
  const cleanSessionKey = cleanDisplayString(sessionKey);
  if (!cleanSessionKey) {
    return undefined;
  }

  const dbPath = cleanDisplayString(options.dbPath)
    ?? resolveDefaultClawlineChatDbPath(options.openClawStateDir, options.env);
  if (!dbPath) {
    return undefined;
  }

  const query = [
    "SELECT displayName",
    "FROM stream_sessions",
    `WHERE sessionKey = ${sqlString(cleanSessionKey)} AND trim(displayName) <> ''`,
    "ORDER BY updatedAt DESC",
    "LIMIT 1;",
  ].join(" ");

  try {
    const stdout = await (options.runSqlite ?? runSqlite)(
      [dbPath, query],
      options.timeoutMs ?? DEFAULT_SQLITE_TIMEOUT_MS,
    );
    return firstCleanLine(stdout);
  } catch {
    return undefined;
  }
}

function runSqlite(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "sqlite3",
      args,
      {
        maxBuffer: SQLITE_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function firstCleanLine(stdout: string): string | undefined {
  return stdout.split(/\r?\n/).map(cleanDisplayString).find((line) => line !== undefined);
}

function cleanDisplayString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
