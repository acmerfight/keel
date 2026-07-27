import type { McpSecretBackend } from "../mcp/oauth.ts";

/* v8 ignore start -- native keyring behavior is exercised through the injected backend contract; invoking it here would mutate the developer's OS credential store. */
export function createNativeMcpSecretBackend(): McpSecretBackend {
  const entry = async (service: string, account: string) => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(service, account);
  };
  return {
    getPassword: async (service, account) =>
      (await (await entry(service, account)).getPassword()) ?? null,
    setPassword: async (service, account, password) => {
      await (await entry(service, account)).setPassword(password);
    },
    deletePassword: async (service, account) =>
      await (await entry(service, account)).deleteCredential(),
  };
}
/* v8 ignore stop */
