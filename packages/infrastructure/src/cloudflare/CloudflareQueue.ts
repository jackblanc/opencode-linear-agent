import type { Queue } from "../types";

/**
 * Cloudflare Queue implementation
 */
export class CloudflareQueue<T> implements Queue<T> {
  constructor(private readonly queue: CloudflareQueue<T>) {}

  async send(message: T): Promise<void> {
    await this.queue.send(message);
  }
}
