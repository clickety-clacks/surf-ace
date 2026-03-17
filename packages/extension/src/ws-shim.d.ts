declare module "ws" {
  export type RawData = string | Buffer | Buffer[] | ArrayBuffer | Uint8Array;

  export default class WebSocket {
    static readonly OPEN: number;

    constructor(url: string, options?: Record<string, unknown>);

    readyState: number;

    close(code?: number, reason?: string): void;
    off(event: string, listener: (...args: any[]) => void): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    send(data: string): void;
  }
}
