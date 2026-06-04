import fs from "node:fs/promises";

const inputPath = process.argv[2];
const rounds = Number(process.argv[3] || 2);
const timeoutMs = Number(process.argv[4] || 6500);

if (!inputPath) {
  console.error("Usage: node scripts/probe-urls.mjs <json-file> [rounds] [timeoutMs]");
  process.exit(1);
}

const candidates = JSON.parse(await fs.readFile(inputPath, "utf8"));
const urls = candidates.map((item) => (typeof item === "string" ? { url: item } : item)).filter((item) => item.url);

const results = [];
for (const candidate of urls) {
  const checks = [];
  for (let round = 1; round <= rounds; round += 1) {
    const started = Date.now();
    const check = await probeStream(candidate.url, timeoutMs);
    checks.push({
      round,
      ok: check.ok,
      reason: check.reason,
      latencyMs: Date.now() - started
    });
  }

  const passed = checks.filter((check) => check.ok);
  const latencies = passed.map((check) => check.latencyMs).sort((a, b) => a - b);
  results.push({
    name: candidate.name || "",
    origin: candidate.origin || "",
    passRate: `${passed.length}/${checks.length}`,
    medianLatencyMs: median(latencies),
    worstLatencyMs: latencies.at(-1) || null,
    failures: checks.filter((check) => !check.ok).map((check) => check.reason),
    url: candidate.url
  });
}

results.sort((a, b) => {
  const aPass = Number(a.passRate.split("/")[0]);
  const bPass = Number(b.passRate.split("/")[0]);
  return bPass - aPass || (a.medianLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.medianLatencyMs ?? Number.MAX_SAFE_INTEGER);
});

console.log(JSON.stringify({ rounds, timeoutMs, results }, null, 2));

async function probeStream(url, timeoutMs) {
  try {
    const result = await probeStreamUrl(url, timeoutMs, 0);
    return result;
  } catch (error) {
    return { ok: false, reason: error.name || "fetch-failed" };
  }
}

async function probeStreamUrl(url, timeoutMs, depth) {
  if (depth > 3) return { ok: false, reason: "playlist-depth" };
  if (/nosignal/i.test(url)) return { ok: false, reason: "no-signal-placeholder" };

  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": "Mozilla/5.0 FatFeetTV/0.3"
    }
  });

  if (!response.ok && response.status !== 206) {
    return { ok: false, reason: `http-${response.status}` };
  }

  const contentType = response.headers.get("content-type") || "";
  const looksLikePlaylist = /mpegurl|application\/vnd\.apple/i.test(contentType) || /\.m3u8?($|[?#])/i.test(url);
  const isDirectMedia = /video|audio/i.test(contentType) || (!looksLikePlaylist && /octet-stream/i.test(contentType));

  if (isDirectMedia) {
    const mediaResult = await probeMediaResponse(response);
    return mediaResult.ok ? { ok: true, reason: "direct-media" } : { ok: false, reason: `direct-${mediaResult.reason}` };
  }

  const text = await response.text().catch(() => "");
  if (!text.includes("#EXTM3U")) {
    const directUrl = text.trim();
    if (/^https?:\/\/\S+$/i.test(directUrl)) return probeStreamUrl(directUrl, timeoutMs, depth + 1);
    return { ok: false, reason: contentType ? `not-playlist:${contentType}` : "not-playlist" };
  }

  const playlist = parseHlsPlaylist(text, url);
  if (playlist.keyUrls.length) {
    const keyResult = await probeSmallResource(playlist.keyUrls[0], timeoutMs);
    if (!keyResult.ok) return { ok: false, reason: `key-${keyResult.reason}` };
  }

  if (playlist.variants.length) {
    return probeStreamUrl(chooseVariant(playlist.variants).url, timeoutMs, depth + 1);
  }

  const segment = playlist.segments.at(-1);
  if (!segment) return { ok: false, reason: "no-segment" };

  const segmentResult = await probeSmallResource(segment.url, timeoutMs);
  if (!segmentResult.ok) return { ok: false, reason: `segment-${segmentResult.reason}` };
  return { ok: true, reason: "segment" };
}

function parseHlsPlaylist(text, baseUrl) {
  const lines = text.replace(/\r/g, "").split("\n").map((line) => line.trim());
  const variants = [];
  const segments = [];
  const keyUrls = [];
  let pendingVariant = null;
  let pendingSegment = false;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("#EXT-X-KEY")) {
      const uri = getAttr(line, "URI");
      if (uri) keyUrls.push(resolveUrl(uri, baseUrl));
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      pendingVariant = {
        bandwidth: Number(getAttr(line, "BANDWIDTH") || 0)
      };
      continue;
    }

    if (line.startsWith("#EXTINF")) {
      pendingSegment = true;
      continue;
    }

    if (line.startsWith("#")) continue;

    const resolved = resolveUrl(line, baseUrl);
    if (pendingVariant) {
      variants.push({ ...pendingVariant, url: resolved });
      pendingVariant = null;
      continue;
    }

    if (pendingSegment || /\.(ts|m4s|mp4|aac|mp3)($|[?#])/i.test(line)) {
      segments.push({ url: resolved });
      pendingSegment = false;
    }
  }

  return { variants, segments, keyUrls };
}

function chooseVariant(variants) {
  return [...variants].sort((a, b) => (a.bandwidth || Number.MAX_SAFE_INTEGER) - (b.bandwidth || Number.MAX_SAFE_INTEGER))[0];
}

async function probeSmallResource(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "Mozilla/5.0 FatFeetTV/0.3",
        "Range": "bytes=0-2047"
      }
    });

    if (!response.ok && response.status !== 206) {
      return { ok: false, reason: `http-${response.status}` };
    }

    const contentType = response.headers.get("content-type") || "";

    const reader = response.body?.getReader?.();
    if (!reader) return { ok: true, reason: "headers" };
    const chunk = await reader.read();
    await reader.cancel().catch(() => {});
    if (!chunk.value?.byteLength) return { ok: false, reason: "empty" };

    const sample = new TextDecoder().decode(chunk.value.slice(0, Math.min(chunk.value.byteLength, 64)));
    if (/mpegurl|application\/vnd\.apple/i.test(contentType) || sample.includes("#EXTM3U")) {
      return { ok: false, reason: "playlist-as-segment" };
    }

    return { ok: true, reason: "bytes" };
  } catch (error) {
    return { ok: false, reason: error.name || "fetch-failed" };
  }
}

async function probeMediaResponse(response) {
  try {
    const reader = response.body?.getReader?.();
    if (!reader) return { ok: true, reason: "headers" };
    const chunk = await reader.read();
    await reader.cancel().catch(() => {});
    return chunk.value?.byteLength ? { ok: true, reason: "bytes" } : { ok: false, reason: "empty" };
  } catch (error) {
    return { ok: false, reason: error.name || "fetch-failed" };
  }
}

async function cancelBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // Ignore cancellation errors from already consumed bodies.
  }
}

function getAttr(line, name) {
  const quoted = line.match(new RegExp(`${name}="([^"]*)"`, "i"));
  if (quoted?.[1]) return quoted[1].trim();
  const unquoted = line.match(new RegExp(`${name}=([^,\\s]+)`, "i"));
  return unquoted?.[1]?.trim() || "";
}

function resolveUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function median(values) {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2) return values[middle];
  return Math.round((values[middle - 1] + values[middle]) / 2);
}
