declare module "node:fs" {
  export function readFileSync(
    path: string | URL,
    options?: { encoding?: string } | string,
  ): string;
}
