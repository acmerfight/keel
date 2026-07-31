export const MCP_CIMD_CLIENT_ID =
  "https://acmerfight.github.io/keel/oauth/client-metadata.json";
export const MCP_CIMD_CALLBACK_PATH = "/oauth/callback";
export const MCP_CIMD_CALLBACKS = [
  {
    port: 55_970,
    redirectUri: "http://127.0.0.1:55970/oauth/callback",
  },
  {
    port: 55_971,
    redirectUri: "http://127.0.0.1:55971/oauth/callback",
  },
  {
    port: 55_972,
    redirectUri: "http://127.0.0.1:55972/oauth/callback",
  },
  {
    port: 55_973,
    redirectUri: "http://127.0.0.1:55973/oauth/callback",
  },
  {
    port: 55_974,
    redirectUri: "http://127.0.0.1:55974/oauth/callback",
  },
  {
    port: 55_975,
    redirectUri: "http://127.0.0.1:55975/oauth/callback",
  },
  {
    port: 55_976,
    redirectUri: "http://127.0.0.1:55976/oauth/callback",
  },
  {
    port: 55_977,
    redirectUri: "http://127.0.0.1:55977/oauth/callback",
  },
  {
    port: 55_978,
    redirectUri: "http://127.0.0.1:55978/oauth/callback",
  },
  {
    port: 55_979,
    redirectUri: "http://127.0.0.1:55979/oauth/callback",
  },
  {
    port: 55_980,
    redirectUri: "http://127.0.0.1:55980/oauth/callback",
  },
  {
    port: 55_981,
    redirectUri: "http://127.0.0.1:55981/oauth/callback",
  },
  {
    port: 55_982,
    redirectUri: "http://127.0.0.1:55982/oauth/callback",
  },
  {
    port: 55_983,
    redirectUri: "http://127.0.0.1:55983/oauth/callback",
  },
  {
    port: 55_984,
    redirectUri: "http://127.0.0.1:55984/oauth/callback",
  },
  {
    port: 55_985,
    redirectUri: "http://127.0.0.1:55985/oauth/callback",
  },
] as const;
export type McpCimdRedirectUri =
  (typeof MCP_CIMD_CALLBACKS)[number]["redirectUri"];
export const MCP_CIMD_REDIRECT_URIS: readonly McpCimdRedirectUri[] =
  MCP_CIMD_CALLBACKS.map((callback) => callback.redirectUri);
