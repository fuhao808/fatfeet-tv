const CACHE_VERSION = "fatfeet-tv-hls-proxy-20260607-1";
const HLS_PROXY_PLAYLIST_TIMEOUT_MS = 6500;
const HLS_PROXY_SEGMENT_TIMEOUT_MS = 11000;
const HTTPS_HLS_PROXY_PROVIDERS = [
  { id: "codetabs", prefix: "https://api.codetabs.com/v1/proxy?quest=" },
  { id: "allorigins", prefix: "https://api.allorigins.win/raw?url=" }
];

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (!requestUrl.pathname.endsWith("/__hls_proxy__")) return;

  event.respondWith(handleHlsProxyRequest(requestUrl));
});

async function handleHlsProxyRequest(requestUrl) {
  const targetUrl = requestUrl.searchParams.get("url") || "";
  const kind = requestUrl.searchParams.get("kind") || "playlist";

  if (!/^https?:\/\//i.test(targetUrl)) {
    return new Response("Unsupported HLS proxy target", {
      status: 400,
      headers: noStoreHeaders("text/plain; charset=utf-8")
    });
  }

  try {
    const timeoutMs = kind === "segment" ? HLS_PROXY_SEGMENT_TIMEOUT_MS : HLS_PROXY_PLAYLIST_TIMEOUT_MS;
    const response = await fetchHlsResource(targetUrl, timeoutMs);

    if (!response.ok) {
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: noStoreHeaders(response.headers.get("content-type") || "text/plain; charset=utf-8")
      });
    }

    if (kind === "playlist") {
      const playlist = await response.text();
      const rewritten = rewriteHlsPlaylist(playlist, targetUrl, requestUrl);
      return new Response(rewritten, {
        status: 200,
        headers: noStoreHeaders("application/vnd.apple.mpegurl")
      });
    }

    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-fatfeet-cache-version", CACHE_VERSION);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch (error) {
    return new Response(`HLS proxy failed: ${error?.message || "unknown error"}`, {
      status: 502,
      headers: noStoreHeaders("text/plain; charset=utf-8")
    });
  }
}

function rewriteHlsPlaylist(text, baseUrl, requestUrl) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;

      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewriteHlsUrl(uri, baseUrl, requestUrl)}"`);
      }

      return rewriteHlsUrl(line.trim(), baseUrl, requestUrl);
    })
    .join("\n");
}

function rewriteHlsUrl(value, baseUrl, requestUrl) {
  const resolved = resolveUrl(value, baseUrl);
  if (!resolved.startsWith("http://")) return resolved;

  const proxyUrl = new URL(requestUrl);
  proxyUrl.searchParams.set("url", resolved);
  proxyUrl.searchParams.set("kind", /\.m3u8(?:$|[?#])/i.test(resolved) ? "playlist" : "segment");
  proxyUrl.searchParams.set("v", String(Date.now()));
  return proxyUrl.toString();
}

function resolveUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

async function fetchFirstHlsProxy(url, timeoutMs) {
  let lastError = null;

  for (const candidate of proxyHlsUrlCandidates(url)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(candidate.url, {
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal
      });
      if (response.ok) return response;
      lastError = new Error(`${candidate.id} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("All HLS proxies failed");
}

async function fetchHlsResource(url, timeoutMs) {
  if (String(url || "").startsWith("http://")) {
    return fetchFirstHlsProxy(url, timeoutMs);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function proxyHlsUrl(url, provider = HTTPS_HLS_PROXY_PROVIDERS[0]) {
  return `${provider.prefix}${encodeURIComponent(url)}`;
}

function proxyHlsUrlCandidates(url) {
  return HTTPS_HLS_PROXY_PROVIDERS.map((provider) => ({
    id: provider.id,
    url: proxyHlsUrl(url, provider)
  }));
}

function noStoreHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-fatfeet-cache-version": CACHE_VERSION
  };
}
