import { Bonjour, type Service } from "bonjour-service";

type PublishMessage = {
  name: string;
  port: number;
  txt: Record<string, string>;
  type: "publish";
};

type StopMessage = {
  type: "stop";
};

type PublisherMessage = PublishMessage | StopMessage;

const bonjour = new Bonjour();
let service: Service | null = null;

async function replaceService(message: PublishMessage): Promise<void> {
  await new Promise<void>((resolve) => {
    bonjour.unpublishAll(() => resolve());
  });
  service = bonjour.publish({
    name: message.name,
    port: message.port,
    protocol: "tcp",
    txt: message.txt,
    type: "surf-ace",
  });
}

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    bonjour.unpublishAll(() => resolve());
  });
  bonjour.destroy();
  process.exit(0);
}

process.on("message", (rawMessage: unknown) => {
  const message = rawMessage as PublisherMessage;
  if (!message || typeof message !== "object" || !("type" in message)) {
    return;
  }
  if (message.type === "publish") {
    void replaceService(message);
    return;
  }
  if (message.type === "stop") {
    void shutdown();
  }
});

process.on("SIGTERM", () => {
  void shutdown();
});

process.on("SIGINT", () => {
  void shutdown();
});
