import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { requestUrl } from "obsidian";

async function collect(body: GitHttpRequest["body"]): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function* toAsyncIterator(chunk: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield chunk;
}

/**
 * isomorphic-git HTTP client backed by Obsidian's `requestUrl`, which is not subject to CORS.
 * This avoids routing credentials and repository data through a third-party CORS proxy.
 */
export const obsidianHttp: HttpClient = {
  async request({
    url,
    method = "GET",
    headers = {},
    body,
  }: GitHttpRequest): Promise<GitHttpResponse> {
    const response = await requestUrl({
      url,
      method,
      headers,
      body: await collect(body),
      throw: false,
    });

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      responseHeaders[key.toLowerCase()] = value;
    }

    return {
      url,
      method,
      statusCode: response.status,
      statusMessage: String(response.status),
      headers: responseHeaders,
      body: toAsyncIterator(new Uint8Array(response.arrayBuffer)),
    };
  },
};
