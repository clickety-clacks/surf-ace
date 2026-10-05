export function centralServerAdvertisement(name: string, serverId: string): Record<string, string> {
  return { role: "server", v: "1", ws: "/ws", name, serverId };
}
