import net from "node:net";

export function isAddressInUse(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

export async function isPortBoundOnIpv6Any(port: number): Promise<boolean> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "::", ipv6Only: true, port }, resolve);
    });
    return false;
  } catch (error) {
    if (isAddressInUse(error)) {
      return true;
    }
    throw error;
  } finally {
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }
}
