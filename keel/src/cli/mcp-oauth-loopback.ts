import { createServer, type Server } from "node:http";

const MCP_OAUTH_CALLBACK_PATH = "/oauth/callback";
const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 2 * 60 * 1000;

export interface McpOAuthLoopbackCallback {
  readonly redirectUrl: string;
  readonly waitForCallback: () => Promise<URLSearchParams>;
  readonly close: () => Promise<void>;
}

export class McpOAuthCallbackError extends Error {}

function callbackError(message: string): McpOAuthCallbackError {
  return new McpOAuthCallbackError(`Error: MCP authorization ${message}.`);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      /* v8 ignore start -- an already-listening server can fail close only through an OS/runtime race. */
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
      /* v8 ignore stop */
    });
  });
}

export async function startMcpOAuthLoopbackCallback(
  expectedState: string,
): Promise<McpOAuthLoopbackCallback> {
  let terminal = false;
  const callback = Promise.withResolvers<URLSearchParams>();
  void callback.promise.catch(() => {});
  const server = createServer((request, response) => {
    let url: URL;
    try {
      /* v8 ignore next -- Node supplies request.url before invoking an HTTP request handler. */
      url = new URL(request.url ?? "", "http://127.0.0.1");
      /* v8 ignore start -- Node rejects malformed HTTP request targets before invoking this handler. */
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth callback.\n");
      return;
    }
    /* v8 ignore stop */
    if (url.pathname !== MCP_OAUTH_CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.\n");
      return;
    }
    /* v8 ignore start -- terminal paths immediately stop accepting new connections; keep a defensive same-connection response. */
    if (terminal) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth callback already received.\n");
      return;
    }
    /* v8 ignore stop */
    terminal = true;
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth callback requires GET.\n");
      callback.reject(callbackError("callback used an invalid HTTP method"));
      void closeServer(server).catch(() => {});
      return;
    }
    if (url.searchParams.get("state") !== expectedState) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth callback validation failed.\n");
      callback.reject(callbackError("rejected a callback with invalid state"));
      void closeServer(server).catch(() => {});
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("MCP authorization completed. You can close this window.\n");
    callback.resolve(new URLSearchParams(url.searchParams));
    void closeServer(server).catch(() => {});
  });

  await new Promise<void>((resolve, reject) => {
    /* v8 ignore next 3 -- ephemeral literal-loopback bind failures require OS/socket fault injection. */
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  /* v8 ignore start -- post-listen server faults require OS/socket fault injection; cleanup remains fail closed. */
  server.on("error", () => {
    if (terminal) return;
    terminal = true;
    callback.reject(callbackError("callback listener failed"));
    void closeServer(server).catch(() => {});
  });
  /* v8 ignore stop */
  const address = server.address();
  /* v8 ignore next 3 -- successful TCP listen on a literal host always yields an AddressInfo. */
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw callbackError("could not bind the loopback callback");
  }
  const redirectUrl = `http://127.0.0.1:${address.port}${MCP_OAUTH_CALLBACK_PATH}`;
  const timer = setTimeout(() => {
    /* v8 ignore next -- terminal command cleanup clears this timer; guard against future lifecycle changes. */
    if (terminal) return;
    terminal = true;
    callback.reject(callbackError("callback timed out"));
    void closeServer(server).catch(() => {});
  }, MCP_OAUTH_CALLBACK_TIMEOUT_MS);
  timer.unref();

  let closed = false;
  return {
    redirectUrl,
    waitForCallback: async () => await callback.promise,
    close: async () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (!terminal) {
        terminal = true;
        callback.reject(callbackError("callback was cancelled"));
      }
      await closeServer(server);
    },
  };
}
