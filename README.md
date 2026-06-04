# FatFeet TV

FatFeet TV (肥脚电视) is a lightweight personal IPTV web app for GitHub Pages.

The frontend behaves like a simple web video player:

- Click a channel to switch.
- Search and category filters help find channels quickly.
- The channel library opens a larger channel picker without changing the main layout.
- The channel guide shows the current channel and a simple program list.
- Playback failures and long buffering automatically try the next source for the same channel.
- Display modes include theater mode, page-maximized mode, and browser/system fullscreen when supported.
- AirPlay is available through Safari's native HTML5 video controls when the browser and source support it.
- A generated `playlist.m3u` can be loaded by Apple TV IPTV apps such as APTV.

## Local Preview

From this folder:

```bash
python3 -m http.server 8088 --bind 0.0.0.0
```

Open on the Mac:

```text
http://localhost:8088
```

Open on a phone on the same Wi-Fi using the Mac LAN IP:

```text
http://<mac-lan-ip>:8088
```

Example from the current Mac network:

```text
http://192.168.50.136:8088
```

If the phone cannot open it, check that the phone is on the same Wi-Fi, not guest Wi-Fi, and allow incoming connections for Python in macOS Firewall if prompted.

## Phone And Casting

For iPhone/iPad to Apple TV:

1. Open the LAN URL or published URL in Safari.
2. Start playback.
3. Use the AirPlay icon in the native video controls, or use Control Center -> Screen Mirroring.

For Samsung/LG/Google TV:

- Try the TV's browser with the published HTTPS URL.
- For Chromecast/Google TV, Chrome tab cast or Google Home screen cast is the simplest current option.
- A dedicated Google Cast sender/receiver integration would need extra app code and is not included in this lightweight static version.

## GitHub Pages Deployment

1. Put this folder in its own GitHub repo.
2. Enable GitHub Pages for the repo.
3. Set the Pages source to `Deploy from a branch`.
4. Select the `main` branch and the repository root `/`.

The public player URL will look like:

```text
https://<user>.github.io/<repo>/
```

The generated playlist URL will look like:

```text
https://<user>.github.io/<repo>/playlist.m3u
```

For GitHub Free, GitHub Pages works with public repositories. Private-repository Pages requires a paid plan such as GitHub Pro/Team.

Important playback note: GitHub Pages is served over HTTPS. Many public IPTV sources are plain HTTP, including the current best CCTV-5 line. Browsers may block those streams as mixed content on the hosted website. IPTV apps that load `playlist.m3u` directly may still play them, and a future HTTPS relay/proxy layer can improve browser playback.

## Apple TV

Best first option:

1. Install APTV on Apple TV.
2. Add the generated `playlist.m3u` URL.
3. Use FatFeet TV in the browser for Mac/iPhone/iPad, and APTV for direct Apple TV playback.

## Source Strategy

Edit `data/sources.json` to add or remove upstream playlists.

`generatedSourceFamilies` is for host patterns that are not fully listed by public M3U files but can be verified by URL convention. These generated candidates still go through the same deep HLS health check, so a playlist-only URL with missing media segments is removed before it reaches the UI.

Current default profile:

- `data/sources.json` is China/Chinese TV first, tuned for watching from the US.

Saved future profile:

- `data/sources.world.json` records the earlier US/world TV strategy.
- It is not active yet.
- The intended future UI is a large top-level switch: `中国电视` / `世界电视`.

The channel generator:

- downloads upstream M3U playlists,
- expands configured source families such as known CCTV host patterns,
- parses channels,
- merges channels with similar names,
- deeply checks HLS playback by following playlists down to actual media segments,
- writes `sources` as the small front-stage line list shown in the UI,
- writes `sourcePool` as the larger hidden backup pool for each channel,
- writes `data/channels.json`,
- writes `playlist.m3u`.

An optional GitHub Actions workflow can run the generator on a schedule, but pushing workflow files requires a GitHub token with the `workflow` scope. Without that scope, publish the static app first and update the catalog manually when needed.

For priority channels, run a multi-round audit before pinning line order:

```bash
node scripts/audit-channel.mjs CCTV-5 5 6500
```

If a channel has a clear winner across several rounds, add the URLs to `sourcePreferences` in `data/sources.json`. The generator still requires those URLs to pass the deep health check before they appear in the app.

The web app:

- plays the first preferred source,
- detects player errors and long buffering,
- waits for live-buffer recovery before switching lines,
- reloads the current source once when a live stream stalls or disconnects,
- switches through the full per-channel source pool only after the current line fails to recover,
- keeps the UI simple for normal viewing.

## Limits

This is intentionally serverless. It does not proxy video streams.

That keeps cost and risk low, but it means:

- Some browser playback can fail because of CORS or source restrictions.
- GitHub Pages is HTTPS; plain HTTP stream URLs may be blocked by browsers as mixed content.
- Apple TV direct browser playback is not practical because Apple TV has no normal Safari browser.
- APTV/VLC-style clients may play sources that Chrome cannot.
- True video proxying would need Cloudflare Workers, a VPS, or another backend and can create bandwidth cost.
