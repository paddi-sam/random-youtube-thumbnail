(() => {
  "use strict";

  const LOG = "[RandomYT]";
  const THUMBNAIL_IMAGE_SELECTOR = "ytd-thumbnail img, yt-thumbnail-view-model img";
  const storyboardCache = new Map();
  const imageCache = new Map();
  const processed = new WeakMap();
  const appliedStyles = new WeakMap();
  const queued = new WeakSet();
  const queue = [];
  let activeWorkers = 0;
  const MAX_WORKERS = 3;

  function videoIdFor(img) {
    const anchor = img.closest('a[href*="watch"], a[href*="/shorts/"], a[href*="youtu.be/"]');
    const candidates = [anchor?.href, img.currentSrc, img.src, img.getAttribute("src"), img.getAttribute("data-thumb")];
    for (const value of candidates) {
      if (!value) continue;
      try {
        const url = new URL(value, location.href);
        const fromQuery = url.searchParams.get("v");
        if (fromQuery && /^[\w-]{11}$/.test(fromQuery)) return fromQuery;
        const match = url.pathname.match(/\/(?:vi|vi_webp|shorts|embed)\/([\w-]{11})(?:\/|$)/);
        if (match) return match[1];
        const short = url.hostname === "youtu.be" && url.pathname.slice(1);
        if (short && /^[\w-]{11}$/.test(short)) return short;
      } catch (_) {}
    }
    return null;
  }

  function extractBalancedObject(text, start) {
    const first = text.indexOf("{", start);
    if (first < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = first; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(first, i + 1)); } catch (_) { return null; }
      }
    }
    return null;
  }

  function findPlayerResponse(html) {
    const markers = ["var ytInitialPlayerResponse =", "ytInitialPlayerResponse =", "window[\"ytInitialPlayerResponse\"] ="];
    for (const marker of markers) {
      const at = html.indexOf(marker);
      if (at >= 0) {
        const parsed = extractBalancedObject(html, at + marker.length);
        if (parsed) return parsed;
      }
    }
    const jsonMatch = html.match(/"ytInitialPlayerResponse"\s*:\s*(\{)/);
    if (jsonMatch) return extractBalancedObject(html, jsonMatch.index + jsonMatch[0].lastIndexOf("{"));
    return null;
  }

  async function getStoryboard(videoId) {
    if (storyboardCache.has(videoId)) return storyboardCache.get(videoId);
    const promise = (async () => {
      const response = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
        credentials: "include",
        cache: "no-cache"
      });
      if (!response.ok) throw new Error(`watch page returned HTTP ${response.status}`);
      const html = await response.text();
      const player = findPlayerResponse(html);
      const spec = player?.storyboards?.playerStoryboardSpecRenderer?.spec;
      if (!spec) throw new Error("YouTube did not provide storyboard metadata for this video");
      const [baseUrl, ...rawLevels] = spec.split("|");
      const levels = rawLevels.map((raw, index) => {
        const fields = raw.split("#");
        if (fields.length < 8) return null;
        const [width, height, count, columns, rows, interval, naming, signature] = fields;
        const level = {
          number: index,
          width: Number(width), height: Number(height), count: Number(count),
          columns: Number(columns), rows: Number(rows), interval: Number(interval),
          naming, signature
        };
        return level.width > 0 && level.height > 0 && level.count > 0 &&
          level.columns > 0 && level.rows > 0 && level.naming && level.signature ? level : null;
      }).filter(Boolean);
      if (!baseUrl || !levels.length) throw new Error("Storyboard specification was malformed");
      return { baseUrl, levels };
    })();
    storyboardCache.set(videoId, promise);
    try { return await promise; }
    catch (error) { storyboardCache.delete(videoId); throw error; }
  }

  // Keep YouTube's original query parameters and substitute the level signature.
  function buildSheetUrl(storyboard, level, sheetIndex) {
    const sheetName = level.naming.replace(/\$M/g, String(sheetIndex));
    const hasSignaturePlaceholder = storyboard.baseUrl.includes("$S");
    const path = storyboard.baseUrl
      .replace("$L", String(level.number))
      .replace("$N", sheetName)
      .replace("$S", encodeURIComponent(level.signature));
    if (hasSignaturePlaceholder) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}sigh=${encodeURIComponent(level.signature)}`;
  }

  function loadImage(url) {
    if (imageCache.has(url)) return imageCache.get(url);
    const promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Browser could not load storyboard image (network, signature, or server rejection)"));
      image.referrerPolicy = "strict-origin-when-cross-origin";
      image.src = url;
    });
    imageCache.set(url, promise);
    promise.catch(() => imageCache.delete(url));
    return promise;
  }

  function findSurface(img) {
    // YouTube's thumbnail image is usually inside a rounded thumbnail container.
    return img.closest("yt-thumbnail-view-model, ytd-thumbnail, .ytThumbnailViewModelHost") || img.parentElement;
  }

  function snapshotStyles(element, properties) {
    return properties.map(property => [
      property,
      element.style.getPropertyValue(property),
      element.style.getPropertyPriority(property)
    ]);
  }

  function restoreStyles(element, styles) {
    for (const [property, value, priority] of styles) {
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
  }

  function restoreThumbnail(img) {
    const applied = appliedStyles.get(img);
    if (!applied) return;
    restoreStyles(applied.surface, applied.surfaceStyles);
    restoreStyles(img, applied.imageStyles);
    appliedStyles.delete(img);
    processed.delete(img);
  }

  async function replaceThumbnail(img, id) {
    const storyboard = await getStoryboard(id);
    // Prefer a higher-resolution level, but try each level if a sheet fails.
    const levels = [...storyboard.levels].sort((a, b) => b.width - a.width);
    let selected = null;
    for (const level of levels) {
      const perSheet = level.columns * level.rows;
      const frameIndex = Math.floor(Math.random() * level.count);
      const sheetIndex = level.naming.includes("$M") ? Math.floor(frameIndex / perSheet) : 0;
      const sheetUrl = buildSheetUrl(storyboard, level, sheetIndex);
      try {
        await loadImage(sheetUrl);
        selected = { level, frameIndex, sheetIndex, sheetUrl, cell: level.naming.includes("$M") ? frameIndex % perSheet : frameIndex };
        break;
      } catch (error) {
        console.warn(`${LOG} Storyboard level ${level.number} failed for ${id}: ${error.message}`);
      }
    }
    if (!selected) throw new Error("All storyboard levels failed to load");
    if (!img.isConnected || videoIdFor(img) !== id) return;

    const { level, frameIndex, sheetUrl, cell } = selected;
    const surface = findSurface(img);
    if (!surface) throw new Error("Could not find thumbnail container");
    const column = cell % level.columns;
    const row = Math.floor(cell / level.columns);
    const surfaceProperties = ["background-image", "background-repeat", "background-size", "background-position", "background-color"];
    const imageProperties = ["opacity", "visibility"];
    appliedStyles.set(img, {
      surface,
      surfaceStyles: snapshotStyles(surface, surfaceProperties),
      imageStyles: snapshotStyles(img, imageProperties)
    });
    surface.style.backgroundImage = `url("${sheetUrl}")`;
    surface.style.backgroundRepeat = "no-repeat";
    surface.style.backgroundSize = `${level.columns * 100}% ${level.rows * 100}%`;
    surface.style.backgroundPosition = `${level.columns > 1 ? column / (level.columns - 1) * 100 : 0}% ${level.rows > 1 ? row / (level.rows - 1) * 100 : 0}%`;
    surface.style.backgroundColor = "transparent";
    img.style.opacity = "0";
    img.style.visibility = "hidden";
    processed.set(img, id);
    console.info(`${LOG} Replaced ${id} with storyboard frame ${frameIndex} (level ${level.number})`);
  }

  function enqueue(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.isConnected || !img.matches(THUMBNAIL_IMAGE_SELECTOR)) {
      restoreThumbnail(img);
      return;
    }
    const id = videoIdFor(img);
    const previousId = processed.get(img);
    if (previousId && previousId !== id) restoreThumbnail(img);
    if (!id || processed.get(img) === id || queued.has(img)) return;
    // Avoid profile pictures, tiny UI images, and images that are not thumbnail-sized.
    if (img.closest("ytd-channel-avatar, #avatar, ytd-video-owner-renderer")) return;
    queued.add(img);
    queue.push({ img, id });
    runWorkers();
  }

  function runWorkers() {
    while (activeWorkers < MAX_WORKERS && queue.length) {
      const job = queue.shift();
      activeWorkers++;
      replaceThumbnail(job.img, job.id)
        .catch(error => console.warn(`${LOG} Could not replace ${job.id}: ${error.message}`))
        .finally(() => {
          activeWorkers--;
          queued.delete(job.img);
          const currentId = job.img.isConnected ? videoIdFor(job.img) : null;
          if (currentId && currentId !== job.id) enqueue(job.img);
          runWorkers();
        });
    }
  }

  function scanMutation(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLImageElement) enqueue(node);
          else if (node instanceof Element) node.querySelectorAll(THUMBNAIL_IMAGE_SELECTOR).forEach(enqueue);
        }
        continue;
      }

      const target = mutation.target;
      if (!(target instanceof Element)) continue;
      if (target instanceof HTMLImageElement) enqueue(target);
      else target.querySelectorAll(THUMBNAIL_IMAGE_SELECTOR).forEach(enqueue);
    }
  }

  function scan() {
    document.querySelectorAll(THUMBNAIL_IMAGE_SELECTOR).forEach(enqueue);
  }

  scan();
  const observer = new MutationObserver(scanMutation);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "data-thumb", "href"]
  });
  window.addEventListener("yt-navigate-finish", scan);
  window.addEventListener("pageshow", scan);
})();
