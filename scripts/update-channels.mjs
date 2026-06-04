import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const configPath = path.join(root, "data", "sources.json");
const channelsPath = path.join(root, "data", "channels.json");
const playlistPath = path.join(root, "playlist.m3u");

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const now = new Date().toISOString();

const upstreams = [];
for (const source of config.sources) {
  if (source.enabled === false) {
    console.log(`Disabled ${source.name}`);
    continue;
  }

  try {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "FatFeetTV/0.1" }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    const parsed = parseM3U(text).map((item) => ({ ...item, upstream: source }));
    upstreams.push(...parsed);
    console.log(`Loaded ${parsed.length} entries from ${source.name}`);
  } catch (error) {
    console.warn(`Skipped ${source.name}: ${error.message}`);
  }
}

const generatedEntries = expandGeneratedSourceFamilies(config.generatedSourceFamilies || []);
if (generatedEntries.length) {
  upstreams.push(...generatedEntries);
  console.log(`Added ${generatedEntries.length} generated source-family entries`);
}

let channels = buildChannels(upstreams, config);
if (config.healthCheck?.enabled) {
  channels = await checkChannelSources(channels, config.healthCheck);
}

if (!channels.length) {
  try {
    const existing = JSON.parse(await fs.readFile(channelsPath, "utf8"));
    if (existing.channels?.length) {
      console.warn("No channels generated; keeping the existing catalog.");
      process.exit(0);
    }
  } catch {
    // No existing catalog; continue and write the empty result so the failure is visible.
  }
}

const payload = {
  generatedAt: now,
  sourceCount: config.sources.length,
  channelCount: channels.length,
  channels
};

await fs.writeFile(channelsPath, `${JSON.stringify(payload, null, 2)}\n`);
await fs.writeFile(playlistPath, buildPlaylist(channels));

console.log(`Wrote ${channels.length} channels`);

function parseM3U(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const entries = [];
  let meta = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "#EXTM3U") continue;

    if (line.startsWith("#EXTINF")) {
      const rawTitle = line.split(",").slice(1).join(",").trim();
      const inlineUrlMatch = rawTitle.match(/(?:^|\s)(https?:\/\/\S+)$/i);
      const title = inlineUrlMatch ? rawTitle.slice(0, inlineUrlMatch.index).trim() : rawTitle;
      const attrName = getAttr(line, "tvg-name");
      const rawGroup = getAttr(line, "group-title");
      const group = rawGroup && !/^undefined$/i.test(rawGroup) ? rawGroup : inferGroup(title);
      meta = {
        name: cleanName(attrName || title || "未命名频道"),
        group,
        logo: getAttr(line, "tvg-logo") || "",
        tvgId: getAttr(line, "tvg-id") || ""
      };
      if (inlineUrlMatch?.[1]) {
        entries.push({ ...meta, url: inlineUrlMatch[1] });
        meta = null;
      }
      continue;
    }

    if (!line.startsWith("#") && meta && /^https?:\/\//i.test(line)) {
      entries.push({ ...meta, url: line });
      meta = null;
    }
  }

  return entries;
}

function expandGeneratedSourceFamilies(families) {
  const entries = [];

  for (const family of families) {
    if (family.enabled === false || !family.urlTemplate) continue;

    for (const channelName of expandFamilyChannels(family)) {
      const number = getCctvNumber(channelName);
      if (!number) continue;

      entries.push({
        name: channelName,
        group: family.group || inferGroup(channelName),
        logo: family.logo || "",
        tvgId: family.tvgId || "",
        url: family.urlTemplate
          .replaceAll("{number}", String(number))
          .replaceAll("{number2}", String(number).padStart(2, "0")),
        upstream: {
          name: family.name,
          priority: family.priority || 0,
          region: family.region || "global"
        }
      });
    }
  }

  return entries;
}

function expandFamilyChannels(family) {
  if (Array.isArray(family.channels)) return family.channels;

  const start = Number(family.range?.start);
  const end = Number(family.range?.end);
  if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) {
    return Array.from({ length: end - start + 1 }, (_, index) => `CCTV-${start + index}`);
  }

  return [];
}

function getCctvNumber(channelName) {
  const match = String(channelName || "").match(/^CCTV-?(\d{1,2})$/i);
  return match ? Number(match[1]) : null;
}

function getAttr(line, name) {
  const quoted = line.match(new RegExp(`${name}="([^"]*)"`, "i"));
  if (quoted?.[1]) return quoted[1].trim();
  const unquoted = line.match(new RegExp(`${name}=([^,\\s]+)`, "i"));
  return unquoted?.[1]?.trim() || "";
}

function buildChannels(entries, cfg) {
  const preferred = cfg.preferredKeywords || [];
  const maxChannels = cfg.maxChannels || 160;
  const maxSources = cfg.healthCheck?.enabled
    ? cfg.healthCheck.maxCandidatesPerChannel || cfg.maxSourcePoolPerChannel || cfg.maxSourcesPerChannel || 4
    : cfg.maxSourcePoolPerChannel || cfg.maxSourcesPerChannel || 4;
  const map = new Map();

  for (const entry of entries) {
    if (!entry.url || isLikelyBad(entry, cfg) || isBlockedUrl(entry.url, cfg) || !matchesRequired(entry, cfg)) continue;
    const key = canonicalName(entry.name);
    if (!key) continue;

    const channel = map.get(key) || {
      id: slugify(key),
      name: displayName(entry.name),
      group: entry.group || inferGroup(entry.name),
      category: categorizeChannel(entry.name, entry.group || inferGroup(entry.name)),
      current: "直播",
      score: 0,
      programs: [
        { time: "现在", title: "直播节目" },
        { time: "稍后", title: "节目单同步中" },
        { time: "全天", title: "自动优选备用线路" }
      ],
      sources: []
    };

    const sourceScore = scoreEntry(entry, preferred);
    channel.score = Math.max(channel.score, sourceScore);
    channel.sources.push({
      url: entry.url,
      status: "unknown",
      origin: entry.upstream.name,
      priority: entry.upstream.priority || 0,
      region: entry.upstream.region || "global"
    });
    map.set(key, channel);
  }

  return [...map.values()]
    .map((channel) => ({
      ...channel,
      sources: uniqueSources(channel.sources)
        .sort(sourceSort)
        .slice(0, maxSources)
    }))
    .filter((channel) => channel.sources.length)
    .sort(channelOrder)
    .slice(0, maxChannels)
    .map(({ score, ...channel }) => channel);
}

async function checkChannelSources(channels, options) {
  const timeoutMs = options.timeoutMs || 7000;
  const concurrency = options.concurrency || 8;
  const maxSourcesToCheck = options.maxSourcesToCheck || 240;
  const minimumPlayableChannels = options.minimumPlayableChannels || 30;
  const jobs = [];

  for (const channel of channels) {
    for (const source of channel.sources) {
      if (jobs.length >= maxSourcesToCheck) break;
      jobs.push({ channel, source });
    }
    if (jobs.length >= maxSourcesToCheck) break;
  }

  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const result = await probeStream(job.source.url, timeoutMs);
      job.source.status = result.ok ? "ok" : "bad";
      job.source.kind = result.kind;
      job.source.reason = result.reason;
      job.source.latencyMs = result.latencyMs;
    }
  });

  await Promise.all(workers);

  const checked = channels.map((channel) => {
    const sources = channel.sources
      .sort((a, b) => statusRank(b.status) - statusRank(a.status) || preferenceSort(channel.name, a, b) || latencySort(a, b) || sourceSort(a, b))
      .map(({ reason, ...source }) => source);
    return {
      ...channel,
      sources,
      playableScore: sources.filter((source) => source.status === "ok").length
    };
  });

  const playable = checked
    .filter((channel) => channel.playableScore > 0)
    .sort(channelOrder);

  if (playable.length >= minimumPlayableChannels) {
    console.log(`Health check verified ${playable.length} playable channels`);
    return checked.map(({ playableScore, sources, ...channel }) => withSourcePool(channel, sources));
  }

  console.warn(`Health check found only ${playable.length} playable channels; keeping ranked catalog with status labels.`);
  return checked.map(({ playableScore, sources, ...channel }) => withSourcePool(channel, sources, { keepBad: true }));
}

function withSourcePool(channel, rankedSources, options = {}) {
  const displayMaxSources = config.maxSourcesPerChannel || 4;
  const poolMaxSources = config.maxSourcePoolPerChannel || Math.max(displayMaxSources, config.healthCheck?.maxCandidatesPerChannel || displayMaxSources);
  const nonBadSources = rankedSources.filter((source) => source.status !== "bad");
  const poolCandidates = (options.keepBad || !nonBadSources.length ? rankedSources : nonBadSources).slice(0, poolMaxSources);
  const displayCandidates = rankedSources.filter((source) => source.status === "ok").slice(0, displayMaxSources);
  const fallbackDisplay = poolCandidates.slice(0, displayMaxSources);

  return {
    ...channel,
    sources: displayCandidates.length ? displayCandidates : fallbackDisplay,
    sourcePool: poolCandidates
  };
}

async function probeStream(url, timeoutMs) {
  const started = Date.now();
  try {
    const result = await probeStreamUrl(url, timeoutMs, 0);
    return { ...result, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: error.name || "fetch-failed", latencyMs: Date.now() - started };
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
      "User-Agent": "Mozilla/5.0 FatFeetTV/0.2"
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
    return mediaResult.ok
      ? { ok: true, reason: "direct-media", kind: "direct" }
      : { ok: false, reason: `direct-${mediaResult.reason}` };
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
    const variant = chooseVariant(playlist.variants);
    return probeStreamUrl(variant.url, timeoutMs, depth + 1);
  }

  const segment = chooseSegment(playlist.segments);
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

function chooseSegment(segments) {
  if (!segments.length) return null;
  return segments[Math.max(0, segments.length - 1)];
}

async function probeSmallResource(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "Mozilla/5.0 FatFeetTV/0.2",
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

function resolveUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function statusRank(status) {
  if (status === "ok") return 2;
  if (status === "unknown") return 1;
  return 0;
}

function sourceSort(a, b) {
  return Number(b.url.startsWith("https://")) - Number(a.url.startsWith("https://")) || b.priority - a.priority;
}

function latencySort(a, b) {
  const left = Number.isFinite(a.latencyMs) ? a.latencyMs : Number.MAX_SAFE_INTEGER;
  const right = Number.isFinite(b.latencyMs) ? b.latencyMs : Number.MAX_SAFE_INTEGER;
  return left - right;
}

function preferenceSort(channelName, a, b) {
  const preferred = config.sourcePreferences?.[channelName];
  if (!Array.isArray(preferred) || !preferred.length) return 0;
  const aRank = preferred.indexOf(a.url);
  const bRank = preferred.indexOf(b.url);
  const left = aRank >= 0 ? aRank : Number.MAX_SAFE_INTEGER;
  const right = bRank >= 0 ? bRank : Number.MAX_SAFE_INTEGER;
  return left - right;
}

function buildPlaylist(channels) {
  const lines = ["#EXTM3U"];
  for (const channel of channels) {
    const best = channel.sources[0];
    if (!best) continue;
    lines.push(`#EXTINF:-1 group-title="${escapeM3U(channel.group)}",${escapeM3U(channel.name)}`);
    lines.push(best.url);
  }
  return `${lines.join("\n")}\n`;
}

function uniqueSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function scoreEntry(entry, preferred) {
  const haystack = `${entry.name} ${entry.group}`.toLowerCase();
  let score = entry.upstream.priority || 0;
  if (preferred.some((keyword) => haystack.includes(keyword.toLowerCase()))) score += 20;
  if (entry.upstream.region === "global") score += 8;
  if (["cn", "hk", "tw"].includes(entry.upstream.region)) score += 10;
  if (/cctv|央视/i.test(haystack)) score += 14;
  if (/卫视|phoenix|凤凰|tvb/i.test(haystack)) score += 10;
  if (/风云|剧场|怀旧|世界地理|兵器|女性时尚|台球|高尔夫|卡通|少儿|动漫|动画|金鹰|卡酷|优漫|嘉佳|哈哈|炫动|游戏风云|梨园|法治天地|劲爆体育/i.test(haystack)) score += 12;
  if (/4k|高清|hd/i.test(haystack)) score += 3;
  if (/购物|测试|radio|广播|backup|支持|作者|熊猫|斗鱼|虎牙|bilibili|app|apk|download|下载|广告|推广|引流|hbo|showtime|starz|cinemax|espn|nba|nfl|mlb|ufc|disney|cartoon network|nickelodeon|national geographic|nat geo/i.test(haystack)) score -= 40;
  return score;
}

function channelOrder(a, b) {
  const fixedDelta = fixedChannelRank(a.name) - fixedChannelRank(b.name);
  if (fixedDelta !== 0) return fixedDelta;

  const categoryDelta = categoryRank(a.category) - categoryRank(b.category);
  if (categoryDelta !== 0) return categoryDelta;

  const provinceDelta = provinceRank(a.name) - provinceRank(b.name);
  if (provinceDelta !== 0) return provinceDelta;

  return (b.score || 0) - (a.score || 0) || channelSortName(a.name).localeCompare(channelSortName(b.name), "zh-Hans-CN");
}

function categoryRank(category) {
  return {
    "中央台": 0,
    "地方卫视": 1,
    "专题少儿": 2,
    "港澳": 3,
    "台湾": 4,
    "其他中文": 5
  }[category] ?? 9;
}

function fixedChannelRank(name) {
  const text = normalizeForRank(name);

  if (text.startsWith("CCTV5PLUS")) return 5.5;
  if (text.startsWith("CCTV4K")) return 18;
  if (text.startsWith("CCTV8K")) return 19;
  if (/CCTV4(AMERICA|ASIA|EUROPE|中文国际)/i.test(text)) return 20;

  const cctv = text.match(/^CCTV(\d{1,2})(?!\d)/);
  if (cctv) {
    const number = Number(cctv[1]);
    const ranks = {
      1: 1,
      2: 2,
      3: 3,
      4: 4,
      5: 5,
      6: 6,
      7: 7,
      8: 8,
      9: 9,
      10: 10,
      11: 11,
      12: 12,
      13: 13,
      14: 14,
      15: 15,
      16: 16,
      17: 17
    };
    if (ranks[number]) return ranks[number];
  }

  const fixed = [
    ["CGTN", 30],
    ["北京卫视", 100],
    ["东方卫视", 101],
    ["天津卫视", 102],
    ["重庆卫视", 103],
    ["黑龙江卫视", 104],
    ["吉林卫视", 105],
    ["辽宁卫视", 106],
    ["内蒙古卫视", 107],
    ["河北卫视", 108],
    ["山西卫视", 109],
    ["山东卫视", 110],
    ["安徽卫视", 111],
    ["河南卫视", 112],
    ["湖北卫视", 113],
    ["湖南卫视", 114],
    ["江西卫视", 115],
    ["江苏卫视", 116],
    ["浙江卫视", 117],
    ["东南卫视", 118],
    ["福建卫视", 119],
    ["广东卫视", 120],
    ["深圳卫视", 121],
    ["广西卫视", 122],
    ["海南卫视", 123],
    ["四川卫视", 124],
    ["贵州卫视", 125],
    ["云南卫视", 126],
    ["陕西卫视", 127],
    ["甘肃卫视", 128],
    ["青海卫视", 129],
    ["宁夏卫视", 130],
    ["新疆卫视", 131],
    ["西藏卫视", 132],
    ["兵团卫视", 133],
    ["CCTV第一剧场", 150],
    ["第一剧场", 150],
    ["CCTV风云足球", 151],
    ["风云足球", 151],
    ["风云剧场", 152],
    ["风云音乐", 153],
    ["怀旧剧场", 154],
    ["世界地理", 155],
    ["兵器科技", 156],
    ["CCTV央视台球", 157],
    ["央视台球", 157],
    ["高尔夫网球", 158],
    ["女性时尚", 159],
    ["金鹰纪实", 160],
    ["都市剧场", 161],
    ["欢笑剧场", 162],
    ["法治天地", 163],
    ["游戏风云", 164],
    ["劲爆体育", 165],
    ["梨园", 166],
    ["金鹰卡通", 170],
    ["卡酷少儿", 171],
    ["优漫卡通", 172],
    ["嘉佳卡通", 173],
    ["哈哈炫动", 174],
    ["动漫秀场", 175],
    ["新动漫", 176],
    ["浙江少儿", 177],
    ["广东少儿", 178],
    ["南京少儿", 179],
    ["黑龙江少儿", 180],
    ["凤凰中文", 200],
    ["凤凰资讯", 201],
    ["凤凰香港", 202],
    ["TVB翡翠", 210],
    ["翡翠台", 210],
    ["TVB明珠", 211],
    ["明珠台", 211],
    ["港台电视31", 220],
    ["澳视", 230],
    ["TVBS", 300],
    ["民视", 301],
    ["三立", 302],
    ["中天", 303],
    ["东森", 304],
    ["华视", 305],
    ["中视", 306],
    ["台视", 307]
  ];

  const hit = fixed.find(([keyword]) => text.includes(keyword));
  return hit ? hit[1] : 9999;
}

function provinceRank(name) {
  const order = [
    "北京",
    "东方",
    "上海",
    "湖南",
    "浙江",
    "江苏",
    "广东",
    "深圳",
    "山东",
    "安徽",
    "河南",
    "河北",
    "湖北",
    "四川",
    "重庆",
    "辽宁",
    "黑龙江",
    "吉林",
    "福建",
    "厦门",
    "天津",
    "陕西",
    "山西",
    "广西",
    "云南",
    "贵州",
    "江西",
    "新疆",
    "西藏",
    "内蒙古",
    "青海",
    "甘肃",
    "宁夏",
    "海南"
  ];
  const hit = order.findIndex((keyword) => String(name || "").includes(keyword));
  return hit >= 0 ? hit : 999;
}

function normalizeForRank(name = "") {
  return String(name)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/CCTV-?5\+/g, "CCTV5PLUS")
    .replace(/CCTV-?(\d+)/g, "CCTV$1")
    .replace(/CCTV8K/g, "CCTV8K")
    .replace(/CCTV4K/g, "CCTV4K")
    .replace(/高清|超清|蓝光|HD|FHD|频道|直播/g, "");
}

function categorizeChannel(name = "", group = "") {
  const text = `${name} ${group}`.toLowerCase();
  if (/cctv|央视|中央|cgtn/.test(text)) return "中央台";
  if (/风云|剧场|怀旧|世界地理|兵器|女性时尚|台球|高尔夫|卡通|少儿|动漫|动画|金鹰|卡酷|优漫|嘉佳|哈哈|炫动|游戏风云|梨园|法治天地|劲爆体育/.test(text)) return "专题少儿";
  if (/湖南|浙江|东方|江苏|广东|北京|深圳|山东|安徽|河南|河北|湖北|四川|重庆|辽宁|黑龙江|吉林|福建|厦门|天津|陕西|山西|广西|云南|贵州|江西|新疆|西藏|内蒙古|青海|甘肃|宁夏|海南|卫视/.test(text)) return "地方卫视";
  if (/香港|凤凰|phoenix|tvb|翡翠|明珠|港台|澳门|澳视/.test(text)) return "港澳";
  if (/台湾|tvbs|民视|三立|中天|东森|华视|中视|台视/.test(text)) return "台湾";
  return "其他中文";
}

function isLikelyBad(entry, cfg = {}) {
  const text = `${entry.name} ${entry.group}`.toLowerCase();
  const blocked = cfg.blockedKeywords || [];
  if (blocked.some((keyword) => text.includes(String(keyword).toLowerCase()))) return true;
  return /测试|购物|轮播|广播|radio|demo|backup|支持|作者|公告|关注|斗鱼|虎牙|熊猫|bilibili|博彩|成人|xxx|casino|app|apk|download|下载|广告|推广|引流|hbo|showtime|starz|cinemax|espn|nba|nfl|mlb|ufc|disney|cartoon network|nickelodeon|national geographic|nat geo/.test(text);
}

function matchesRequired(entry, cfg = {}) {
  const required = cfg.requiredKeywords || [];
  if (!required.length) return true;
  const text = `${entry.name} ${entry.group}`.toLowerCase();
  return required.some((keyword) => text.includes(String(keyword).toLowerCase()));
}

function isBlockedUrl(url, cfg = {}) {
  const text = String(url || "").toLowerCase();
  const blocked = cfg.blockedUrlKeywords || [];
  return blocked.some((keyword) => text.includes(String(keyword).toLowerCase()));
}

function canonicalName(name) {
  const normalized = cleanName(name)
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/CCTV-?4K/gi, "CCTV4K")
    .replace(/CCTV-?8K/gi, "CCTV8K")
    .replace(/CCTV-?5\+/gi, "CCTV5PLUS")
    .replace(/高清|超清|蓝光|HD|FHD|频道|直播/gi, "")
    .replace(/中央电视台/g, "CCTV")
    .replace(/央视/g, "CCTV")
    .replace(/CCTV-(\d+)/gi, "CCTV$1")
    .replace(/^(CCTV5PLUS)(体育赛事|体育)$/i, "$1")
    .replace(/^(CCTV\d{1,2})(综合|财经|综艺|中文国际|体育赛事|体育|电影|新闻|国防军事|电视剧|纪录|科教|戏曲|社会与法|少儿|音乐|奥林匹克|农业农村)$/i, "$1")
    .toUpperCase();

  return normalized;
}

function displayName(name) {
  return cleanName(name)
    .replace(/中央电视台/g, "CCTV")
    .replace(/CCTV-?5\+/i, "CCTV-5+")
    .replace(/CCTV-?(\d+)/gi, "CCTV-$1")
    .replace(/\s+/g, " ")
    .trim();
}

function channelSortName(name) {
  return name.replace(/CCTV-?(\d+)/i, (_, number) => `CCTV-${String(number).padStart(2, "0")}`);
}

function cleanName(name) {
  const text = String(name || "");
  const tvgName = text.match(/tvg-name="([^"]+)"/i)?.[1];
  return String(tvgName || text)
    .replace(/\[[^\]]*]/g, "")
    .replace(/^.*group-title="[^"]*",/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferGroup(name = "") {
  if (/CCTV|央视|中央/i.test(name)) return "央视";
  if (/卫视|湖南|浙江|东方|江苏|广东|北京|深圳/.test(name)) return "卫视";
  if (/凤凰|TVB|CGTN/i.test(name)) return "精选";
  return "直播";
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/\+/g, "-plus")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function escapeM3U(value) {
  return String(value || "").replaceAll('"', "'");
}
