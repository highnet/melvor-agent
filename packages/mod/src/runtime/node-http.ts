/**
 * HTTP through NW.js's Node integration, bypassing Chromium's network stack.
 *
 * The Steam client is NW.js. `package.nw/index.html` is a local page whose only
 * content is an iframe pointing at `https://steam.melvoridle.com`, and the mod
 * runs inside that iframe. So from the browser's point of view the agent is a
 * *public, secure* page trying to reach `http://localhost` — the private,
 * insecure address space.
 *
 * Chrome gates that behind Private Network Access, and the page sees only a
 * bare "Failed to fetch" with no CORS error to read, because CORS was never the
 * problem. Answering the PNA preflight helps on some Chromium versions and not
 * others, and the long-term direction of that feature is to block the
 * combination outright.
 *
 * The manifest also declares:
 *
 * ```json
 * "nodejs": true,
 * "node-remote": ["https://*.melvoridle.com/*"]
 * ```
 *
 * `steam.melvoridle.com` matches that pattern, so the game frame has full Node
 * integration. Node's `http` module does not go through Chromium's network
 * stack at all, which means no CORS, no mixed content, and no Private Network
 * Access — the whole class of problem disappears rather than being negotiated
 * with.
 *
 * This is used only when Node is actually present. In a plain browser (or if
 * Melvor ever drops node integration) it reports unavailable and the caller
 * falls back to `fetch`.
 */

/** Minimal shape of the bits of Node's `http` module used here. */
interface NodeHttpResponse {
  statusCode?: number;
  setEncoding(encoding: string): void;
  on(event: 'data', handler: (chunk: string) => void): void;
  on(event: 'end', handler: () => void): void;
}

interface NodeHttpRequest {
  on(event: 'error', handler: (error: Error) => void): void;
  setTimeout(ms: number, handler: () => void): void;
  destroy(): void;
  write(body: string): void;
  end(): void;
}

interface NodeHttpModule {
  request(
    options: {
      hostname: string;
      port: number;
      path: string;
      method: string;
      headers: Record<string, string>;
    },
    callback: (response: NodeHttpResponse) => void,
  ): NodeHttpRequest;
}

type NodeRequire = (id: string) => unknown;

/**
 * Finds NW.js's `require`, if this page has Node integration.
 *
 * NW.js exposes it as a global in node-enabled frames, and also as `nw.require`.
 * Both are checked because which one is present varies with NW.js version and
 * how the frame was created.
 *
 * @returns The require function, or null in a plain browser context.
 */
function nodeRequire(): NodeRequire | null {
  const scope = globalThis as Record<string, unknown>;

  const direct = scope.require;
  if (typeof direct === 'function') return direct as NodeRequire;

  const nw = scope.nw as { require?: unknown } | undefined;
  if (nw !== undefined && typeof nw.require === 'function') {
    return nw.require as NodeRequire;
  }

  return null;
}

let cachedHttp: NodeHttpModule | null | undefined;

/** The Node `http` module, or null when unavailable. Resolved once. */
function httpModule(): NodeHttpModule | null {
  if (cachedHttp !== undefined) return cachedHttp;

  const required = nodeRequire();
  if (required === null) {
    cachedHttp = null;
    return null;
  }

  try {
    cachedHttp = required('http') as NodeHttpModule;
  } catch {
    // Node integration present but `http` unavailable, e.g. a restricted
    // context. Treat exactly like no Node at all.
    cachedHttp = null;
  }

  return cachedHttp;
}

/** Whether requests can be made through Node rather than `fetch`. */
export function isNodeHttpAvailable(): boolean {
  return httpModule() !== null;
}

export interface NodeHttpResult {
  status: number;
  body: string;
}

/**
 * Performs an HTTP request through Node.
 *
 * @param url - Absolute URL. Only `http:` is supported, which is all the local
 *              service ever speaks.
 * @param method - HTTP method.
 * @param body - Optional request body, already serialised.
 * @param timeoutMs - Abort after this long, so a wedged service cannot stall a tick.
 * @returns Status and body text.
 * @throws When Node is unavailable, the URL is not http, or the request fails.
 */
export function nodeHttpRequest(
  url: string,
  method: string,
  body: string | undefined,
  timeoutMs: number,
): Promise<NodeHttpResult> {
  const http = httpModule();
  if (http === null) {
    return Promise.reject(new Error('node http unavailable'));
  }

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:') {
    return Promise.reject(new Error(`node http supports http: only, got ${parsed.protocol}`));
  }

  return new Promise<NodeHttpResult>((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      // Node does not set this from the body, and some servers require it.
      headers['content-length'] = String(new TextEncoder().encode(body).length);
    }

    const request = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port === '' ? '80' : parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: text });
        });
      },
    );

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    });

    if (body !== undefined) request.write(body);
    request.end();
  });
}
