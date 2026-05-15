import type { McpClient } from "./client.ts";

const clients = new Map<string, McpClient>();

export function register(client: McpClient): void {
  clients.set(client.serverName, client);
}

export function get(name: string): McpClient | undefined {
  return clients.get(name);
}
