const CACHE_VERSION = "fatfeet-tv-hls-proxy-20260604-9";
const HTTPS_HLS_PROXY_PREFIX = "https://api.codetabs.com/v1/proxy?quest=";

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

  if (!targetUrl.startsWith("http://")) {
    return new Response("Unsupported HLS proxy target", {
      status: 400,
      headers: noStoreHeaders("text/plain; charset=utf-8")
    });
  }

  try {
    const response = await fetch(proxyHlsUrl(targetUrl), {
      cache: "no-store",
      redirect: "follow"
    });

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

function proxyHlsUrl(url) {
  return `${HTTPS_HLS_PROXY_PREFIX}${encodeURIComponent(url)}`;
}

function noStoreHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-fatfeet-cache-version": CACHE_VERSION
  };
}
