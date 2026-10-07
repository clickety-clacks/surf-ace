declare module "node:fs" {
  export function existsSync(path: string | URL): boolean;
  export function readFileSync(
    path: string | URL,
    options?: { encoding?: string } | string,
  ): string;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}
