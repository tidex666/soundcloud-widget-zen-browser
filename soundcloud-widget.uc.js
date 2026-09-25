// ==UserScript==
// @name           soundcloud-widget
// @include        main
// ==/UserScript==
//
// SoundCloud widget for the Zen sidebar.
// NOTE: keep this file pure ASCII. The loader reads it as Latin-1, so any
// raw UTF-8 symbol shows up as garbage. Use \uXXXX escapes in strings.
//
// v2.1.0
//  - Favourites now come before Recent in the library panel (was the
//    other way round).
//  - Fixed: clicking a favourite/history row did nothing if you didn't
//    already have a SoundCloud tab open; it now opens one.
//  - Playback controls wrap instead of overflowing the widget when the
//    sidebar is narrow.
//  - Palette swapped from the purple/lavender scheme to a neutral
//    glass/mica-friendly one, with a stronger frosted blur.
//  - Switching between player/library/settings now animates the height
//    change instead of snapping.
//  - Fixed: "Like on SoundCloud when starring" only ever added the like,
//    never removed it when you un-starred a track.
// v2.0.0
//  - Recently played history + favourites (star button / list button).
//    Click to play, middle-click opens in a new tab. Saved to
//    sc-widget-data.json in your profile folder, synced across windows.
//  - Optional: starring also likes the track on SoundCloud.
//  - Settings panel redesigned to match the player, custom slider, no tip.
//  - Artist line under the title, sharper cover art.
//  - Fixed "A-with-hat" garbage characters (file is ASCII-only now).
// v1.x: sidebar layout, minimize, real audio-reactive EQ, marquee title.

console.log("[SC-WIDGET] script file loaded");

// =====================================================================
// FRAME SCRIPT (runs inside every tab's content process).
// Serialized with toString(); must not reference the chrome scope.
// =====================================================================
function scFrameScript(EQ_BAR_COUNT) {
  "use strict";

  // exportFunction is NOT a global in frame scripts on every build ->
  // the old hook threw "exportFunction is not defined" and silently died.
  const XF = (typeof exportFunction === "function")
    ? exportFunction
    : Components.utils.exportFunction;

  let lastStatus = "";
  function log(m) {
    lastStatus = m;
    try { console.log("[SC-WIDGET][audio] " + m); } catch (e) {}
    try { sendAsyncMessage("SCWidget:Status", { status: m }); } catch (e) {}
  }

  function isSoundCloud(win) {
    try {
      return !!(win && win.location && win.location.host &&
        win.location.host.indexOf("soundcloud.com") !== -1);
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Player controls (unchanged behaviour)
  // ------------------------------------------------------------------
  function dispatchClick(selector) {
    const btn = content.document.querySelector(selector);
    if (btn) {
      btn.dispatchEvent(new content.MouseEvent("click", { bubbles: true, cancelable: true, view: content }));
    }
    return !!btn;
  }

  function extractArtworkUrl(el) {
    if (!el) return null;
    const bg = el.style.backgroundImage || "";
    const start = bg.indexOf("url(");
    if (start === -1) return null;
    let url = bg.slice(start + 4, bg.lastIndexOf(")")).trim();
    if (url[0] === '"' || url[0] === "'") url = url.slice(1, -1);
    return url || null;
  }

  function getInfo() {
    const d = content.document;
    const playBtn = d.querySelector(".playControls__play");
    const titleBadge = d.querySelector(".playbackSoundBadge__title");
    const progressWrapper = d.querySelector(".playbackTimeline__progressWrapper");
    const artworkEl = d.querySelector('.playbackSoundBadge .sc-artwork[style*="background-image"]');
    const volumeBtn = d.querySelector(".volume__button");

    const titleLink = d.querySelector(".playbackSoundBadge__titleLink");
    const artistLink = d.querySelector(".playbackSoundBadge__lightLink");
    const likeBtn = d.querySelector(".playbackSoundBadge__like");

    let rawTitle = null;
    if (titleLink && titleLink.getAttribute("title")) {
      rawTitle = titleLink.getAttribute("title").trim();
    } else if (titleBadge) {
      const inner = titleBadge.querySelector("a, span");
      rawTitle = inner ? inner.textContent.trim() : titleBadge.textContent.trim();
    }

    let artist = null;
    if (artistLink) artist = (artistLink.getAttribute("title") || artistLink.textContent || "").trim() || null;

    return {
      found: !!playBtn,
      playTitle: playBtn ? playBtn.title : null,
      playing: playBtn ? (playBtn.classList.contains("playing") || /pause/i.test(playBtn.title || "")) : false,
      trackTitle: rawTitle,
      artist: artist,
      trackUrl: titleLink ? titleLink.href : null,
      liked: likeBtn ? likeBtn.classList.contains("sc-button-selected") : false,
      artworkUrl: extractArtworkUrl(artworkEl),
      currentTime: progressWrapper ? parseFloat(progressWrapper.getAttribute("aria-valuenow")) : 0,
      duration: progressWrapper ? parseFloat(progressWrapper.getAttribute("aria-valuemax")) : 0,
      muted: volumeBtn ? volumeBtn.innerHTML.includes("13.4697 10.5303") : false
    };
  }

  addMessageListener("SCWidget:GetInfo", function () {
    sendAsyncMessage("SCWidget:GetInfoReply", getInfo());
  });

  addMessageListener("SCWidget:TogglePlay", function () {
    dispatchClick(".playControls__play");
    resumeTapContext();
    sendAsyncMessage("SCWidget:TogglePlayReply", getInfo());
  });

  addMessageListener("SCWidget:Next", function () {
    const clicked = dispatchClick(".playControls__next");
    sendAsyncMessage("SCWidget:NextReply", { clicked: clicked });
  });

  addMessageListener("SCWidget:Prev", function () {
    const clicked = dispatchClick(".playControls__prev");
    sendAsyncMessage("SCWidget:PrevReply", { clicked: clicked });
  });

  addMessageListener("SCWidget:ToggleMute", function () {
    dispatchClick(".volume__button");
    sendAsyncMessage("SCWidget:ToggleMuteReply", getInfo());
  });

  addMessageListener("SCWidget:ToggleLike", function () {
    dispatchClick(".playbackSoundBadge__like");
    sendAsyncMessage("SCWidget:ToggleLikeReply", getInfo());
  });

  // ------------------------------------------------------------------
  // Play a track by URL (history / favourites).
  // 1. Client-side navigation (SoundCloud's router picks up link clicks,
  //    so the music/page doesn't reload).
  // 2. Wait for the track page, press its big play button.
  // 3. If the router didn't react, fall back to a normal page load.
  // Uses chrome timers so it survives a full page load.
  // ------------------------------------------------------------------
  let pendingPlay = null;

  function pathOf(href) {
    try { return new content.URL(href, content.location.href).pathname.replace(/\/+$/, ""); } catch (e) { return null; }
  }

  function badgePath() {
    const link = content.document.querySelector(".playbackSoundBadge__titleLink");
    return link ? pathOf(link.href) : null;
  }

  function isPlayingNow() {
    const b = content.document.querySelector(".playControls__play");
    return !!b && (b.classList.contains("playing") || /pause/i.test(b.title || ""));
  }

  function findHeroPlay() {
    const sels = [
      ".fullHero__foreground .sc-button-play",
      ".fullListenHero .sc-button-play",
      ".l-listen-hero .sc-button-play",
      ".listenHero .sc-button-play",
      ".fullHero .playButton",
      ".soundTitle__playButton .sc-button-play"
    ];
    for (const sel of sels) {
      const b = content.document.querySelector(sel);
      if (b) return b;
    }
    return null;
  }

  function clickEl(b) {
    b.dispatchEvent(new content.MouseEvent("click", { bubbles: true, cancelable: true, view: content, button: 0 }));
  }

  function pumpPendingPlay() {
    const job = pendingPlay;
    if (!job) return;
    job.tries++;
    try {
      const here = pathOf(content.location.href);
      if (badgePath() === job.path) {
        // Track is loaded in the player bar.
        if (!job.clicked && !isPlayingNow()) dispatchClick(".playControls__play");
        if (job.clicked || isPlayingNow() || job.tries > 8) { pendingPlay = null; return; }
      } else if (here === job.path) {
        if (!job.clicked) {
          const b = findHeroPlay();
          if (b) { clickEl(b); job.clicked = true; job.clickedAt = job.tries; }
        } else if (job.tries - job.clickedAt > 20) {
          pendingPlay = null; return;
        }
      } else if (job.tries === 12 && !job.hardNav) {
        job.hardNav = true;
        content.location.href = job.url;
      }
    } catch (e) {}
    if (job.tries > 80) { pendingPlay = null; return; }
    if (pendingPlay === job) schedule(pumpPendingPlay, 200);
  }

  addMessageListener("SCWidget:PlayUrl", function (msg) {
    try {
      const u = new content.URL(String(msg.data && msg.data.url || ""));
      if (u.host.indexOf("soundcloud.com") === -1) return;
      const path = u.pathname.replace(/\/+$/, "");
      const job = { path: path, url: "https://soundcloud.com" + path, tries: 0, clicked: false, clickedAt: 0, hardNav: false };
      pendingPlay = job;

      if (badgePath() !== path && pathOf(content.location.href) !== path) {
        const doc = content.document;
        const a = doc.createElement("a");
        a.href = path;
        a.style.display = "none";
        (doc.body || doc.documentElement).appendChild(a);
        clickEl(a);
        a.remove();
      }
      schedule(pumpPendingPlay, 250);
    } catch (e) {
      log("playUrl failed: " + (e && e.message));
    }
  });

  addMessageListener("SCWidget:Seek", function (msg) {
    const wrapper = content.document.querySelector(".playbackTimeline__progressWrapper");
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const base = {
        bubbles: true, cancelable: true, view: content,
        clientX: rect.left + rect.width * msg.data.percent,
        clientY: rect.top + rect.height / 2
      };
      const down = Object.assign({}, base, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 });
      const up = Object.assign({}, base, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0 });
      wrapper.dispatchEvent(new content.PointerEvent("pointerdown", down));
      wrapper.dispatchEvent(new content.MouseEvent("mousedown", base));
      wrapper.dispatchEvent(new content.PointerEvent("pointermove", up));
      wrapper.dispatchEvent(new content.MouseEvent("mousemove", base));
      wrapper.dispatchEvent(new content.PointerEvent("pointerup", up));
      wrapper.dispatchEvent(new content.MouseEvent("mouseup", base));
      wrapper.dispatchEvent(new content.MouseEvent("click", base));
    }
    sendAsyncMessage("SCWidget:SeekReply", getInfo());
  });

  // ------------------------------------------------------------------
  // AUDIO TAP
  //
  // Why the old version only ever showed the fallback animation:
  // SoundCloud does NOT play through Web Audio. It plays through a
  // (detached) <audio> element fed by MediaSource (HLS). So the patched
  // AudioNode.connect() was never called -> no analyser -> no data.
  // (On top of that, the `instanceof AudioDestinationNode` check fails
  // across the Xray boundary, so even Web Audio pages wouldn't match.)
  //
  // New approach:
  //  1. Hook HTMLMediaElement.prototype.play in the page, so we catch the
  //     audio element even though it's never inserted in the DOM.
  //  2. Route it: element -> MediaElementSource -> Analyser -> speakers.
  //     Sound is unchanged, we just get to look at it.
  //  3. Keep a (fixed) AudioNode.connect hook as backup.
  //
  // Safety guards so we never make the music go silent:
  //  - only tap blob:/same-origin/CORS sources (cross-origin without CORS
  //    would output silence through Web Audio),
  //  - only create the AudioContext once the page has had a real user
  //    click (otherwise autoplay policy could leave it suspended).
  // ------------------------------------------------------------------
  let Timer = null;
  try {
    Timer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  } catch (e) {}

  let tap = null;        // { doc, ctx, analyser, freq }
  let seenEls = [];      // media elements caught by the play() hook (may be detached)
  let graphTaps = [];    // analysers on the page's own AudioContexts

  function makeAnalyser(ctx) {
    const a = ctx.createAnalyser();
    a.fftSize = 256;
    a.smoothingTimeConstant = 0.5;   // less smoothing = snappier
    a.minDecibels = -90;
    a.maxDecibels = -35;             // default is -30, lower = hotter bars
    return { analyser: a, freq: new Uint8Array(a.frequencyBinCount) };
  }

  // Returns a tap only if its AudioContext is RUNNING. Routing the
  // element into a suspended context would silence the music, so we
  // never do that; we just retry later.
  function ensureTap(win) {
    const doc = win.document;
    if (tap && tap.doc === doc) {
      if (tap.ctx.state !== "running") { try { tap.ctx.resume(); } catch (e) {} }
      return tap.ctx.state === "running" ? tap : null;
    }
    const ctx = new win.AudioContext();
    if (ctx.state !== "running") {
      try { ctx.resume(); } catch (e) {}
    }
    const a = makeAnalyser(ctx);
    a.analyser.connect(ctx.destination);
    tap = { doc: doc, ctx: ctx, analyser: a.analyser, freq: a.freq };
    log("AudioContext created (state=" + ctx.state + ")");
    return ctx.state === "running" ? tap : null;
  }

  function resumeTapContext() {
    try {
      if (tap && tap.ctx.state === "suspended") tap.ctx.resume();
    } catch (e) {}
  }

  function tapElement(el, win) {
    try {
      if (!el || el.__scWidgetTapped) return;

      const src = String(el.currentSrc || el.src || "");
      if (!src) return; // no source yet, we'll get it on "playing"

      let origin = "";
      try { origin = win.location.origin; } catch (e) {}
      const safe = src.indexOf("blob:") === 0 ||
        (origin && src.indexOf(origin) === 0) ||
        !!el.crossOrigin;
      if (!safe) {
        el.__scWidgetTapped = true; // don't retry forever
        log("skipping cross-origin media without CORS (would go silent): " + src.slice(0, 80));
        return;
      }

      const t = ensureTap(win);
      if (!t) {
        log("AudioContext not running yet (autoplay policy), retrying. Click anywhere in the SoundCloud tab once.");
        return;
      }
      const node = t.ctx.createMediaElementSource(el);
      node.connect(t.analyser);
      el.__scWidgetTapped = true;
      resumeTapContext();
      log("media element tapped, EQ is live");
    } catch (e) {
      // e.g. page already made its own MediaElementSource -> connect hook covers that
      if (el) el.__scWidgetTapped = true;
      log("tapElement failed: " + (e && e.message));
    }
  }

  function watchElement(el, win) {
    try {
      if (!el || el.__scWidgetWatched) return;
      el.__scWidgetWatched = true;
      seenEls.push(el);
      log("caught media element, src=" + String(el.currentSrc || el.src || "(none yet)").slice(0, 60));
      el.addEventListener("playing", function () { tapElement(el, win); });
    } catch (e) {}
  }

  function installHooks(win) {
    if (!isSoundCloud(win)) return;
    let uw;
    try { uw = win.wrappedJSObject; } catch (e) { return; }
    if (!uw) return;

    // 1) HTMLMediaElement.play (catches detached <audio> too)
    try {
      const proto = uw.HTMLMediaElement && uw.HTMLMediaElement.prototype;
      if (proto && !proto.__scWidgetPlayHooked) {
        const origPlay = proto.play;
        const hookedPlay = function () {
          try {
            watchElement(this, win);
            tapElement(this, win);
            resumeTapContext();
          } catch (e) {}
          return origPlay.apply(this, arguments);
        };
        Object.defineProperty(proto, "play", {
          value: XF(hookedPlay, uw),
          writable: true,
          configurable: true
        });
        proto.__scWidgetPlayHooked = true;
        log("HTMLMediaElement.play hooked");
      }
    } catch (e) {
      log("play hook failed: " + (e && e.message));
    }

    // 2) Backup: AudioNode.connect (for anything going through Web Audio)
    try {
      const nproto = uw.AudioNode && uw.AudioNode.prototype;
      if (nproto && !nproto.__scWidgetConnectHooked) {
        const origConnect = nproto.connect;
        const hookedConnect = function (dest) {
          try {
            const ctx = this.context;
            if (dest && ctx && dest === ctx.destination && !(tap && tap.ctx === ctx)) {
              let g = ctx.__scWidgetGraphTap;
              if (!g) {
                g = makeAnalyser(ctx);
                ctx.__scWidgetGraphTap = g;
                graphTaps.push(g);
                log("page AudioContext tapped (backup path)");
              }
              this.connect(g.analyser); // Xray call -> native, no recursion
            }
          } catch (e) {}
          return origConnect.apply(this, arguments);
        };
        Object.defineProperty(nproto, "connect", {
          value: XF(hookedConnect, uw),
          writable: true,
          configurable: true
        });
        nproto.__scWidgetConnectHooked = true;
      }
    } catch (e) {
      log("connect hook failed: " + (e && e.message));
    }

    // 3) In-DOM media elements
    try {
      const doc = win.document;
      if (doc && !doc.__scWidgetListening) {
        doc.__scWidgetListening = true;
        win.addEventListener("playing", function (e) { tapElement(e.target, win); }, true);
      }
    } catch (e) {}
  }

  function scanForMedia() {
    try {
      const els = content.document.querySelectorAll("audio, video");
      for (const el of els) {
        watchElement(el, content);
        if (!el.paused) tapElement(el, content);
      }
    } catch (e) {}
  }

  addEventListener("DOMWindowCreated", function (event) {
    try {
      const doc = event.target;
      const win = doc && doc.defaultView;
      if (!win || !isSoundCloud(win)) return;
      if (win === content) {
        tap = null;
        graphTaps = [];
        seenEls = [];
      }
      installHooks(win);
    } catch (e) {}
  }, true);

  // Tab was already on soundcloud.com when this script got loaded
  // (e.g. session restore). Hooks catch the next play()/track change.
  try {
    if (isSoundCloud(content)) {
      installHooks(content);
      scanForMedia();
    }
  } catch (e) {}

  // ------------------------------------------------------------------
  // Frequency -> bars (log-spaced so the right side isn't dead)
  // ------------------------------------------------------------------
  function computeBars(freq) {
    const bins = freq.length;
    const minB = 2;
    const maxB = Math.max(minB + EQ_BAR_COUNT, Math.floor(bins * 0.75));
    const ratio = maxB / minB;
    const bars = new Array(EQ_BAR_COUNT);
    let sum = 0;
    let prevEnd = minB;
    for (let i = 0; i < EQ_BAR_COUNT; i++) {
      const s = prevEnd;
      let e = Math.floor(minB * Math.pow(ratio, (i + 1) / EQ_BAR_COUNT));
      if (e <= s) e = s + 1;
      prevEnd = e;
      let total = 0;
      let peak = 0;
      for (let j = s; j < e && j < bins; j++) {
        const v = freq[j];
        total += v;
        if (v > peak) peak = v;
      }
      const v = (total / (e - s) / 255) * 0.6 + (peak / 255) * 0.4;
      bars[i] = Math.min(1, Math.pow(v, 0.6) * (0.9 + i * 0.04));
      sum += v;
    }
    return { bars: bars, level: sum / EQ_BAR_COUNT };
  }

  // Chrome-side timer (Timer.sys.mjs) so a background SoundCloud tab
  // doesn't get its timers throttled to 1/s like page timers do.
  const schedule = Timer ? Timer.setTimeout : function (f, ms) {
    try { return content.setTimeout(f, ms); } catch (e) { return 0; }
  };

  let tick = 0;
  function frame() {
    let next = 500;
    try {
      if (!content) return; // tab is gone -> stop the loop
      tick++;
      if (isSoundCloud(content)) {
        if (tick % 5 === 0) {
          scanForMedia();
          for (const el of seenEls) {
            try { if (!el.__scWidgetTapped && !el.paused) tapElement(el, content); } catch (e) {}
          }
          if (!seenEls.length && tick % 100 === 0) {
            log("no media element seen yet. Reload the SoundCloud tab once so the hook loads before SoundCloud does.");
          }
        }

        const sources = [];
        if (tap) sources.push(tap);
        for (const g of graphTaps) sources.push(g);

        if (sources.length) {
          next = 50;
          let best = null;
          for (const s of sources) {
            try {
              s.analyser.getByteFrequencyData(s.freq);
              const r = computeBars(s.freq);
              if (!best || r.level > best.level) best = r;
            } catch (e) {}
          }
          if (best) {
            sendAsyncMessage("SCWidget:AudioData", best);
            if (tick % 200 === 0) log("flowing, level=" + best.level.toFixed(3));
          }
        }
      }
    } catch (e) {
      return; // frame script torn down
    }
    schedule(frame, next);
  }
  schedule(frame, 500);
}

// =====================================================================
// CHROME SIDE (the widget itself)
// =====================================================================
const SC_WIDGET_VERSION = "2.1.0";

function scWidgetInit() {
  if (document.getElementById("sc-widget-test")) return;
  console.log("[SC-WIDGET] init v" + SC_WIDGET_VERSION);

  // ---- Palette (Catppuccin Mocha) ----
  // Neutral glass/mica palette (no purple/blue tint) so the widget blends
  // into any mica/acrylic sidebar theme instead of fighting it.
  const COL_BG = "#18181b";
  const COL_TEXT = "#f4f4f5";
  const COL_SELECTION = "rgba(255, 255, 255, 0.16)";
  const COL_SURFACE = "rgba(255, 255, 255, 0.08)";
  const COL_SURFACE_SOFT = "rgba(255, 255, 255, 0.045)";
  const COL_BORDER = "rgba(255, 255, 255, 0.10)";
  const COL_TEXT_DIM = "rgba(255, 255, 255, 0.62)";
  const COL_TEXT_FAINT = "rgba(255, 255, 255, 0.38)";
  const COL_TRACK = "rgba(255, 255, 255, 0.16)";

  const EQ_BAR_COUNT = 14;
  const MINI_BAR_COUNT = 4;
  const HISTORY_MAX = 40;
  const SENS_MIN = 0.5;
  const SENS_MAX = 3.5;
  const SENS_STEP = 0.1;
  const SVG_NS = "http://www.w3.org/2000/svg";
  // Non-ASCII characters only as escapes: the loader reads this file as
  // Latin-1, so raw UTF-8 symbols turn into "A-with-hat" garbage.
  const DASH = "\u2014";
  const DOT = " \u00b7 ";

  // =================== SETTINGS (about:config "sc-widget.*") ===================
  const PREFIX = "sc-widget.";
  function getBool(n, d) { try { return Services.prefs.getBoolPref(PREFIX + n, d); } catch (e) { return d; } }
  function setBool(n, v) { try { Services.prefs.setBoolPref(PREFIX + n, !!v); } catch (e) {} }
  function getNum(n, d) {
    try {
      const v = parseFloat(Services.prefs.getStringPref(PREFIX + n, String(d)));
      return isFinite(v) ? v : d;
    } catch (e) { return d; }
  }
  function setNum(n, v) { try { Services.prefs.setStringPref(PREFIX + n, String(v)); } catch (e) {} }

  const DEFAULTS = { sensitivity: 1.6, showEq: true, glow: true, history: true, likeOnFav: false };
  const settings = {
    sensitivity: Math.min(SENS_MAX, Math.max(SENS_MIN, getNum("sensitivity", DEFAULTS.sensitivity))),
    showEq: getBool("showEq", DEFAULTS.showEq),
    glow: getBool("glow", DEFAULTS.glow),
    history: getBool("history", DEFAULTS.history),
    likeOnFav: getBool("likeOnFav", DEFAULTS.likeOnFav),
    blur: getBool("blur", false),
    minimized: getBool("minimized", false)
  };
  function saveSetting(k) {
    if (typeof settings[k] === "number") setNum(k, settings[k]);
    else setBool(k, settings[k]);
  }

  // =================== HELPERS ===================
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function btn(cls, size, title) {
    const b = el("button", "sc-btn" + (cls ? " " + cls : ""));
    b.style.width = size + "px";
    b.style.height = size + "px";
    b.style.minWidth = size + "px";
    if (title) b.title = title;
    return b;
  }

  function icon(paths, o) {
    o = o || {};
    const svg = document.createElementNS(SVG_NS, "svg");
    const size = String(o.size || 12);
    svg.setAttribute("viewBox", o.viewBox || "0 0 24 24");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("fill", o.fill || "none");
    if (o.stroke) {
      svg.setAttribute("stroke", o.stroke);
      svg.setAttribute("stroke-width", String(o.sw || 2));
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
    }
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    svg.style.pointerEvents = "none";
    return svg;
  }

  const PATHS = {
    down: "M6 9l6 6 6-6",
    up: "M6 15l6-6 6 6",
    left: "M15 6l-6 6 6 6",
    x: "M7 7l10 10M17 7L7 17",
    star: "M12 3.3l2.68 5.43 5.99.87-4.33 4.23 1.02 5.97L12 17.0l-5.36 2.8 1.02-5.97L3.33 9.6l5.99-.87z",
    list: ["M4 6h12", "M4 11h12", "M4 16h7", "M16 14.5v6l5-3z"],
    gear: "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
  };
  const iconChevron = (d) => icon([PATHS[d]], { stroke: COL_TEXT, sw: 3, size: 10 });
  const iconStar = (on, size) => icon([PATHS.star], { size: size || 12, stroke: COL_TEXT, sw: 2, fill: on ? COL_TEXT : "none" });

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = s / 60;
    if (m < 60) return Math.floor(m) + "m ago";
    const h = m / 60;
    if (h < 24) return Math.floor(h) + "h ago";
    const d = h / 24;
    if (d < 7) return Math.floor(d) + "d ago";
    try { return new Date(ts).toLocaleDateString(); } catch (e) { return ""; }
  }

  function cleanTrackTitle(raw) {
    if (!raw) return raw;
    let title = raw.replace(/^(current track|now playing)\s*:\s*/i, "").trim();
    const half = title.length / 2;
    if (Number.isInteger(half) && half > 0 && title.slice(0, half) === title.slice(half)) {
      title = title.slice(0, half);
    }
    return title;
  }

  function normUrl(u) {
    if (!u) return null;
    try {
      const x = new URL(u);
      if (!/(^|\.)soundcloud\.com$/i.test(x.hostname)) return null;
      const path = x.pathname.replace(/\/+$/, "");
      if (!path || path.split("/").length < 3) return null; // needs /artist/track
      return "https://soundcloud.com" + path;
    } catch (e) { return null; }
  }

  // SoundCloud serves art in many sizes, the player bar uses a tiny one.
  function bigArt(u) {
    if (!u) return "";
    return u.replace(/-(t\d+x\d+|large|small|badge|tiny|mini|crop)(\.\w+)$/, "-t200x200$2");
  }

  function cssUrl(u) {
    return 'url("' + String(u).replace(/["\\\n\r]/g, "") + '")';
  }

  function setArt(node, small) {
    if (!small) { node.style.backgroundImage = "none"; return; }
    const big = bigArt(small);
    node.style.backgroundImage = big !== small ? cssUrl(big) + ", " + cssUrl(small) : cssUrl(small);
  }

  // Two-step confirm for destructive buttons ("Clear" -> "Sure?")
  function confirmButton(b, label, confirmLabel, action) {
    let armed = false;
    let timer = null;
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        b.textContent = confirmLabel;
        b.classList.add("sc-armed");
        timer = setTimeout(() => {
          armed = false;
          b.textContent = label;
          b.classList.remove("sc-armed");
        }, 2500);
        return;
      }
      clearTimeout(timer);
      armed = false;
      b.textContent = label;
      b.classList.remove("sc-armed");
      action();
    });
  }

  // =================== ROOT + CSS ===================
  const widgetDiv = document.createElement("div");
  widgetDiv.id = "sc-widget-test";
  widgetDiv.style.cssText = `
    position: relative;
    display: none;
    flex-direction: column;
    align-items: stretch;
    flex-shrink: 0;
    min-width: 0;
    max-width: calc(100% - 16px);
    contain: inline-size;
    overflow: hidden;
    margin: 6px 8px 8px;
    padding: 10px 12px;
    box-sizing: border-box;
    -moz-window-dragging: no-drag;
    background: rgba(24, 24, 27, 0.38);
    backdrop-filter: blur(22px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: 16px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.20);
    transition: opacity 0.12s ease;
  `;

  const styleTag = document.createElement("style");
  styleTag.textContent = `
    #sc-widget-test { font-family: system-ui, -apple-system, sans-serif; color: ${COL_TEXT}; font-size: 11px; }
    #sc-widget-test *::selection { background-color: ${COL_SELECTION}; color: ${COL_TEXT}; }
    #sc-widget-test button {
      appearance: none; border: none; margin: 0; padding: 0;
      font: inherit; color: inherit; cursor: pointer; -moz-window-dragging: no-drag;
      transition: background-color 0.12s ease, transform 0.08s ease, opacity 0.15s ease, color 0.12s ease;
    }
    #sc-widget-test button:hover { background-color: ${COL_SELECTION} !important; }
    #sc-widget-test button:active { transform: scale(0.94); }
    #sc-widget-test .sc-btn {
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%; flex-shrink: 0; background-color: ${COL_SURFACE};
    }
    #sc-widget-test .sc-btn.sc-inv { background-color: ${COL_TEXT}; }
    #sc-widget-test .sc-corner { position: absolute; top: 6px; z-index: 2; opacity: 0.35; }
    #sc-widget-test:hover .sc-corner { opacity: 1; }
    #sc-widget-test .sc-btn.sc-disabled { opacity: 0.35; pointer-events: none; }

    /* ---- views ---- */
    #sc-widget-test.sc-narrow { display: none !important; }
    #sc-widget-test.sc-min { padding: 6px 8px !important; border-radius: 12px !important; }
    #sc-widget-test.sc-min #sc-full,
    #sc-widget-test:not(.sc-min) #sc-mini,
    #sc-widget-test.sc-min .sc-corner,
    #sc-widget-test.sc-panel-open #sc-full,
    #sc-widget-test.sc-panel-open #sc-mini,
    #sc-widget-test.sc-panel-open .sc-corner { display: none !important; }
    #sc-widget-test:not(.sc-view-library) #sc-library,
    #sc-widget-test:not(.sc-view-settings) #sc-settings { display: none !important; }
    #sc-widget-test.sc-no-eq #sc-widget-eq,
    #sc-widget-test.sc-no-eq #sc-mini-eq { display: none !important; }

    /* ---- marquee titles ---- */
    #sc-widget-test .sc-marquee { overflow: hidden; white-space: nowrap; min-width: 0; max-width: 100%; }
    #sc-widget-test .sc-marquee.sc-scrolling {
      mask-image: linear-gradient(90deg, transparent 0, #000 8px, #000 calc(100% - 8px), transparent 100%);
    }
    #sc-widget-test .sc-marquee > span { display: inline-block; white-space: nowrap; will-change: transform; }
    #sc-widget-test .sc-marquee.sc-scrolling > span {
      padding: 0 8px;
      animation: sc-marquee var(--sc-dur, 8s) ease-in-out infinite alternate;
    }
    #sc-widget-test .sc-marquee.sc-scrolling:hover > span { animation-play-state: paused; }
    @keyframes sc-marquee {
      0%, 15% { transform: translateX(0); }
      85%, 100% { transform: translateX(var(--sc-shift, 0px)); }
    }

    #sc-widget-test .sc-ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #sc-widget-test .sc-cover-click { cursor: pointer; }

    @keyframes sc-pop { 0% { transform: scale(1); } 40% { transform: scale(1.28); } 100% { transform: scale(1); } }
    #sc-widget-test .sc-pop { animation: sc-pop 0.3s ease; }

    /* ---- panels (library / settings) ---- */
    #sc-widget-test .sc-panel { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
    #sc-widget-test .sc-panel-head {
      display: grid; grid-template-columns: 20px 1fr 20px; align-items: center; gap: 6px;
    }
    #sc-widget-test .sc-panel-title { text-align: center; font-size: 12px; font-weight: 700; }

    #sc-widget-test .sc-seg {
      display: flex; justify-self: center; padding: 2px; gap: 2px;
      border-radius: 11px; background: ${COL_SURFACE};
    }
    #sc-widget-test .sc-seg > button {
      height: 18px; padding: 0 9px; border-radius: 9px;
      font-size: 10px; font-weight: 600; color: ${COL_TEXT_DIM}; background: transparent;
      white-space: nowrap;
    }
    #sc-widget-test .sc-seg > button.sc-active { background: ${COL_TEXT}; color: ${COL_BG}; }
    #sc-widget-test .sc-seg > button.sc-active:hover { color: ${COL_TEXT}; }

    #sc-widget-test .sc-list {
      display: flex; flex-direction: column; gap: 2px;
      max-height: 222px; overflow-y: auto; overflow-x: hidden;
      margin: 0 -6px; padding: 0 6px;
      scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
    }
    #sc-widget-test .sc-row {
      display: flex; align-items: center; gap: 8px; min-width: 0;
      padding: 4px; border-radius: 8px; cursor: pointer;
      transition: background-color 0.12s ease;
    }
    #sc-widget-test .sc-row:hover { background: ${COL_SURFACE}; }
    #sc-widget-test .sc-row-art {
      position: relative; width: 30px; height: 30px; border-radius: 6px; flex-shrink: 0;
      background-color: ${COL_SURFACE}; background-size: cover; background-position: center;
      overflow: hidden;
    }
    #sc-widget-test.sc-blur .sc-row-art { filter: blur(5px); }
    #sc-widget-test .sc-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    #sc-widget-test .sc-row-title { font-size: 11px; font-weight: 600; }
    #sc-widget-test .sc-row-sub { font-size: 9.5px; color: ${COL_TEXT_DIM}; }
    #sc-widget-test .sc-row-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    #sc-widget-test .sc-row-actions > button { background: transparent; opacity: 0; }
    #sc-widget-test .sc-row:hover .sc-row-actions > button,
    #sc-widget-test .sc-row-actions > button.sc-on { opacity: 1; }
    #sc-widget-test .sc-row.sc-now .sc-row-title { color: ${COL_TEXT}; }
    #sc-widget-test .sc-row:not(.sc-now) .sc-row-title { color: rgba(255, 255, 255, 0.88); }

    #sc-widget-test .sc-row-now {
      position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5);
      display: flex; align-items: flex-end; justify-content: center; gap: 2px; padding-bottom: 8px;
    }
    #sc-widget-test .sc-row-now > span {
      width: 2px; height: 4px; border-radius: 1px; background: ${COL_TEXT};
      animation: sc-bounce 0.8s ease-in-out infinite alternate;
    }
    #sc-widget-test .sc-row-now > span:nth-child(2) { animation-delay: -0.27s; }
    #sc-widget-test .sc-row-now > span:nth-child(3) { animation-delay: -0.54s; }
    #sc-widget-test.sc-paused .sc-row-now > span { animation-play-state: paused; }
    @keyframes sc-bounce { from { height: 3px; } to { height: 13px; } }

    #sc-widget-test .sc-empty {
      padding: 18px 8px; text-align: center; color: ${COL_TEXT_FAINT};
      font-size: 10.5px; line-height: 1.45;
    }
    #sc-widget-test .sc-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      font-size: 9.5px; color: ${COL_TEXT_FAINT}; min-height: 20px;
    }

    /* ---- settings ---- */
    #sc-widget-test .sc-card {
      display: flex; flex-direction: column; gap: 9px;
      padding: 9px 10px; border-radius: 10px;
      background: ${COL_SURFACE_SOFT}; border: 1px solid ${COL_BORDER};
    }
    #sc-widget-test .sc-set-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      min-height: 16px; cursor: pointer;
    }
    #sc-widget-test .sc-set-label { color: ${COL_TEXT_DIM}; font-size: 10.5px; }
    #sc-widget-test .sc-set-row:hover .sc-set-label { color: ${COL_TEXT}; }
    #sc-widget-test .sc-set-value { font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; }

    #sc-widget-test .sc-toggle {
      position: relative; width: 24px; height: 14px; border-radius: 7px; flex-shrink: 0;
      background: ${COL_TRACK}; transition: background-color 0.15s ease;
    }
    #sc-widget-test .sc-toggle::after {
      content: ""; position: absolute; top: 2px; left: 2px;
      width: 10px; height: 10px; border-radius: 50%;
      background: ${COL_TEXT_DIM};
      transition: transform 0.15s ease, background-color 0.15s ease;
    }
    #sc-widget-test .sc-toggle.sc-on { background: ${COL_TEXT}; }
    #sc-widget-test .sc-toggle.sc-on::after { transform: translateX(10px); background: ${COL_BG}; }

    #sc-widget-test .sc-slider { position: relative; height: 12px; cursor: pointer; margin: 0 5px; }
    #sc-widget-test .sc-slider-track {
      position: absolute; left: 0; right: 0; top: 4px; height: 4px; border-radius: 2px; background: ${COL_TRACK};
    }
    #sc-widget-test .sc-slider-fill { height: 100%; border-radius: 2px; background: ${COL_TEXT}; }
    #sc-widget-test .sc-slider-thumb {
      position: absolute; top: 1px; width: 10px; height: 10px; margin-left: -5px;
      border-radius: 50%; background: ${COL_TEXT}; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
      transition: transform 0.1s ease;
    }
    #sc-widget-test .sc-slider:hover .sc-slider-thumb,
    #sc-widget-test .sc-slider.sc-dragging .sc-slider-thumb { transform: scale(1.2); }

    #sc-widget-test .sc-pill {
      height: 22px; padding: 0 10px; border-radius: 11px;
      background: ${COL_SURFACE}; color: ${COL_TEXT_DIM};
      font-size: 10px; font-weight: 600; white-space: nowrap;
    }
    #sc-widget-test .sc-pill:hover { color: ${COL_TEXT}; }
    #sc-widget-test .sc-pill.sc-armed { background: rgba(243, 139, 168, 0.22) !important; color: #f38ba8; }
    #sc-widget-test .sc-pill-row { display: flex; gap: 6px; }
    #sc-widget-test .sc-pill-row > .sc-pill { flex: 1; }
    #sc-widget-test .sc-version { text-align: center; font-size: 9px; color: ${COL_TEXT_FAINT}; }
  `;
  widgetDiv.appendChild(styleTag);

  // =================== CORNER BUTTONS ===================
  const gearBtn = btn("sc-corner", 18, "Settings");
  gearBtn.id = "sc-widget-gear";
  gearBtn.style.left = "6px";
  gearBtn.appendChild(icon([PATHS.gear], { stroke: COL_TEXT, sw: 2.2, size: 11 }));
  widgetDiv.appendChild(gearBtn);

  const minBtn = btn("sc-corner", 18, "Minimize");
  minBtn.id = "sc-widget-minbtn";
  minBtn.style.right = "6px";
  minBtn.appendChild(iconChevron("down"));
  widgetDiv.appendChild(minBtn);

  // =================== FULL VIEW ===================
  const fullBody = el("div");
  fullBody.id = "sc-full";
  fullBody.style.cssText = `
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 7px; width: 100%; min-width: 0;
  `;

  // Artwork
  const artworkWrapper = el("div");
  artworkWrapper.style.cssText = `
    position: relative; width: 56px; height: 56px; border-radius: 8px;
    overflow: hidden; background-color: ${COL_SURFACE}; flex-shrink: 0;
  `;
  const artworkEl = el("div", "sc-cover-click");
  artworkEl.id = "sc-widget-artwork";
  artworkEl.title = "Go to SoundCloud tab";
  artworkEl.style.cssText = `
    width: 100%; height: 100%; background-size: cover;
    background-position: center; transition: filter 0.15s ease;
  `;
  artworkWrapper.appendChild(artworkEl);

  function buildEyeSvg(closed) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "10");
    svg.setAttribute("height", "10");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", COL_BG);
    svg.setAttribute("stroke-width", "2.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.pointerEvents = "none";
    if (!closed) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z");
      svg.appendChild(path);
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", "12");
      circle.setAttribute("cy", "12");
      circle.setAttribute("r", "3");
      svg.appendChild(circle);
    } else {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", "M17.94 17.94A10.94 10.94 0 0112 19c-7 0-11-7-11-7a21.6 21.6 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 7 11 7a21.6 21.6 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24");
      svg.appendChild(path);
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", "1");
      line.setAttribute("y1", "1");
      line.setAttribute("x2", "23");
      line.setAttribute("y2", "23");
      svg.appendChild(line);
    }
    return svg;
  }

  const eyeBtn = btn("sc-inv", 18, "Blur cover");
  eyeBtn.id = "sc-widget-eye";
  eyeBtn.style.position = "absolute";
  eyeBtn.style.top = "4px";
  eyeBtn.style.right = "4px";
  artworkWrapper.appendChild(eyeBtn);

  // Title + artist
  const titleBlock = el("div");
  titleBlock.style.cssText = `display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%; min-width: 0;`;
  const titleEl = el("div", "sc-marquee");
  titleEl.id = "sc-widget-title";
  titleEl.style.cssText = `font-size: 11px; font-weight: 600; width: 100%; text-align: center;`;
  const titleText = el("span", null, DASH);
  titleEl.appendChild(titleText);
  const artistEl = el("div", "sc-ellipsis");
  artistEl.style.cssText = `font-size: 10px; color: ${COL_TEXT_DIM}; max-width: 100%; text-align: center; display: none;`;
  titleBlock.appendChild(titleEl);
  titleBlock.appendChild(artistEl);

  // EQ
  const eqContainer = el("div");
  eqContainer.id = "sc-widget-eq";
  eqContainer.style.cssText = `
    display: flex; align-items: flex-end; justify-content: center;
    gap: 2px; width: 100%; height: 18px;
  `;
  const eqBarEls = [];
  for (let i = 0; i < EQ_BAR_COUNT; i++) {
    const bar = el("div");
    bar.style.cssText = `
      width: 3px; height: 3px; border-radius: 2px;
      background: linear-gradient(180deg, ${COL_TEXT} 0%, rgba(255, 255, 255, 0.35) 100%);
      opacity: 0.5;
    `;
    eqContainer.appendChild(bar);
    eqBarEls.push(bar);
  }

  // Mute
  function buildSpeakerSvg(muted) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "10");
    svg.setAttribute("height", "10");
    svg.setAttribute("fill", COL_BG);
    svg.style.pointerEvents = "none";
    const p1 = document.createElementNS(SVG_NS, "path");
    p1.setAttribute("d", "M7.14645 1.85356C7.46143 1.53858 8 1.76167 8 2.20712V13.7929C8 14.2384 7.46143 14.4614 7.14645 14.1465L4 11H1.5C1.22386 11 1 10.7762 1 10.5V5.50001C1 5.22387 1.22386 5.00001 1.5 5.00001H4L7.14645 1.85356Z");
    svg.appendChild(p1);
    const p2 = document.createElementNS(SVG_NS, "path");
    p2.setAttribute("d", muted
      ? "M13.4697 10.5303L12 9.06066L10.5303 10.5303L9.46967 9.46967L10.9393 8L9.46967 6.53033L10.5303 5.46967L12 6.93934L13.4697 5.46967L14.5303 6.53033L13.0607 8L14.5303 9.46967L13.4697 10.5303Z"
      : "M12 7.99999C12 9.48649 10.9189 10.7205 9.5 10.9585V5.04147C10.9189 5.27951 12 6.5135 12 7.99999Z");
    svg.appendChild(p2);
    return svg;
  }
  const muteBtn = btn("sc-inv", 20, "Mute");
  muteBtn.id = "sc-widget-mute";
  function setMuteIcon(muted) {
    muteBtn.textContent = "";
    muteBtn.appendChild(buildSpeakerSvg(muted));
    muteBtn.title = muted ? "Unmute" : "Mute";
  }
  setMuteIcon(false);

  // Progress
  const progressOuter = el("div");
  progressOuter.id = "sc-widget-progress-outer";
  progressOuter.style.cssText = `
    width: 100%; height: 4px; background: ${COL_TRACK};
    border-radius: 2px; cursor: pointer; position: relative;
  `;
  const progressFill = el("div");
  progressFill.style.cssText = `height: 100%; width: 0%; background: ${COL_TEXT}; border-radius: 2px;`;
  progressOuter.appendChild(progressFill);

  const timeRow = el("div");
  timeRow.style.cssText = `display: flex; align-items: center; justify-content: space-between; width: 100%;`;
  const timeEl = el("div", null, "0:00 / 0:00");
  timeEl.id = "sc-widget-time";
  timeEl.style.cssText = `color: ${COL_TEXT_DIM}; font-size: 10px; font-variant-numeric: tabular-nums;`;
  timeRow.appendChild(timeEl);
  timeRow.appendChild(muteBtn);

  // Controls: [fav] [prev] [play] [next] [library]
  const controlsRow = el("div");
  controlsRow.style.cssText = `
    display: flex; align-items: center; justify-content: center;
    column-gap: 6px; row-gap: 6px; flex-wrap: wrap; width: 100%;
  `;

  const favBtn = btn("", 24, "Add to favourites");
  favBtn.id = "sc-widget-fav";

  const prevBtn = btn("", 24, "Previous");
  prevBtn.id = "sc-widget-prev";
  const prevIcon = el("span");
  prevIcon.style.cssText = `
    width: 0; height: 0; border-top: 5px solid transparent;
    border-bottom: 5px solid transparent; border-right: 8px solid ${COL_TEXT}; margin-right: 2px;
  `;
  prevBtn.appendChild(prevIcon);

  const playPauseBtn = btn("sc-inv", 34, "Play / pause");
  playPauseBtn.id = "sc-widget-playpause";
  const icon1 = el("span");
  playPauseBtn.appendChild(icon1);

  const nextBtn = btn("", 24, "Next");
  nextBtn.id = "sc-widget-next";
  const nextIcon = el("span");
  nextIcon.style.cssText = `
    width: 0; height: 0; border-top: 5px solid transparent;
    border-bottom: 5px solid transparent; border-left: 8px solid ${COL_TEXT}; margin-left: 2px;
  `;
  nextBtn.appendChild(nextIcon);

  const libBtn = btn("", 24, "Recently played & favourites");
  libBtn.id = "sc-widget-library";
  libBtn.appendChild(icon(PATHS.list, { stroke: COL_TEXT, sw: 2.2, size: 12 }));

  controlsRow.appendChild(favBtn);
  controlsRow.appendChild(prevBtn);
  controlsRow.appendChild(playPauseBtn);
  controlsRow.appendChild(nextBtn);
  controlsRow.appendChild(libBtn);

  fullBody.appendChild(artworkWrapper);
  fullBody.appendChild(titleBlock);
  fullBody.appendChild(eqContainer);
  fullBody.appendChild(progressOuter);
  fullBody.appendChild(timeRow);
  fullBody.appendChild(controlsRow);
  widgetDiv.appendChild(fullBody);

  // =================== MINI VIEW ===================
  const miniRow = el("div");
  miniRow.id = "sc-mini";
  miniRow.style.cssText = `display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;`;

  const miniArtWrap = el("div");
  miniArtWrap.style.cssText = `
    width: 28px; height: 28px; border-radius: 6px; overflow: hidden;
    flex-shrink: 0; background-color: ${COL_SURFACE};
  `;
  const miniArt = el("div", "sc-cover-click");
  miniArt.title = "Go to SoundCloud tab";
  miniArt.style.cssText = `
    width: 100%; height: 100%; background-size: cover;
    background-position: center; transition: filter 0.15s ease;
  `;
  miniArtWrap.appendChild(miniArt);

  const miniText = el("div");
  miniText.style.cssText = `flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px;`;
  const miniTitle = el("div", "sc-marquee");
  miniTitle.style.cssText = `font-size: 11px; font-weight: 600; width: 100%;`;
  const miniTitleText = el("span", null, DASH);
  miniTitle.appendChild(miniTitleText);
  const miniProgress = el("div");
  miniProgress.style.cssText = `width: 100%; height: 3px; background: ${COL_TRACK}; border-radius: 2px; cursor: pointer;`;
  const miniProgressFill = el("div");
  miniProgressFill.style.cssText = `height: 100%; width: 0%; background: ${COL_TEXT}; border-radius: 2px;`;
  miniProgress.appendChild(miniProgressFill);
  miniText.appendChild(miniTitle);
  miniText.appendChild(miniProgress);

  const miniEq = el("div");
  miniEq.id = "sc-mini-eq";
  miniEq.style.cssText = `display: flex; align-items: flex-end; gap: 2px; height: 14px; flex-shrink: 0;`;
  const miniBarEls = [];
  for (let i = 0; i < MINI_BAR_COUNT; i++) {
    const b = el("div");
    b.style.cssText = `width: 2px; height: 2px; border-radius: 1px; background: ${COL_TEXT}; opacity: 0.6;`;
    miniEq.appendChild(b);
    miniBarEls.push(b);
  }

  const miniPlayBtn = btn("sc-inv", 24, "Play / pause");
  miniPlayBtn.id = "sc-widget-mini-play";
  const miniIcon = el("span");
  miniPlayBtn.appendChild(miniIcon);

  const expandBtn = btn("", 18, "Expand");
  expandBtn.id = "sc-widget-expand";
  expandBtn.appendChild(iconChevron("up"));

  miniRow.appendChild(miniArtWrap);
  miniRow.appendChild(miniText);
  miniRow.appendChild(miniEq);
  miniRow.appendChild(miniPlayBtn);
  miniRow.appendChild(expandBtn);
  widgetDiv.appendChild(miniRow);

  // =================== PANEL SCAFFOLD ===================
  function makePanel(id, center) {
    const panel = el("div", "sc-panel");
    panel.id = id;
    const head = el("div", "sc-panel-head");
    const back = btn("", 20, "Back");
    back.appendChild(iconChevron("left"));
    back.addEventListener("click", () => setView("player"));
    head.appendChild(back);
    head.appendChild(center);
    head.appendChild(el("div"));
    panel.appendChild(head);
    widgetDiv.appendChild(panel);
    return panel;
  }

  // =================== LIBRARY PANEL ===================
  const seg = el("div", "sc-seg");
  const segFav = el("button", "sc-active", "Favourites");
  const segRecent = el("button", null, "Recent");
  seg.appendChild(segFav);
  seg.appendChild(segRecent);
  const libPanel = makePanel("sc-library", seg);
  const libList = el("div", "sc-list");
  libPanel.appendChild(libList);
  const libFoot = el("div", "sc-foot");
  const libCount = el("span");
  const libClear = el("button", "sc-pill");
  libFoot.appendChild(libCount);
  libFoot.appendChild(libClear);
  libPanel.appendChild(libFoot);

  let libTab = "fav";
  function setLibTab(t) {
    libTab = t;
    segRecent.classList.toggle("sc-active", t === "recent");
    segFav.classList.toggle("sc-active", t === "fav");
    libList.scrollTop = 0;
    renderLibrary();
  }
  segRecent.addEventListener("click", () => setLibTab("recent"));
  segFav.addEventListener("click", () => setLibTab("fav"));

  // =================== SETTINGS PANEL ===================
  const setPanel = makePanel("sc-settings", el("div", "sc-panel-title", "Settings"));

  // Card: visuals
  const cardLook = el("div", "sc-card");
  const sensHead = el("div", "sc-set-row");
  sensHead.style.cursor = "default";
  sensHead.appendChild(el("span", "sc-set-label", "EQ sensitivity"));
  const sensValue = el("span", "sc-set-value");
  sensHead.appendChild(sensValue);
  const slider = el("div", "sc-slider");
  slider.title = "Drag or scroll";
  const sliderTrack = el("div", "sc-slider-track");
  const sliderFill = el("div", "sc-slider-fill");
  sliderTrack.appendChild(sliderFill);
  const sliderThumb = el("div", "sc-slider-thumb");
  slider.appendChild(sliderTrack);
  slider.appendChild(sliderThumb);
  cardLook.appendChild(sensHead);
  cardLook.appendChild(slider);
  setPanel.appendChild(cardLook);

  // Card: library
  const cardLib = el("div", "sc-card");
  setPanel.appendChild(cardLib);

  const toggleSyncers = [];
  function addToggle(card, label, key, onChange) {
    const row = el("div", "sc-set-row");
    row.appendChild(el("span", "sc-set-label", label));
    const t = el("div", "sc-toggle");
    row.appendChild(t);
    const sync = () => t.classList.toggle("sc-on", !!settings[key]);
    row.addEventListener("click", () => {
      settings[key] = !settings[key];
      saveSetting(key);
      sync();
      if (onChange) onChange();
    });
    card.appendChild(row);
    toggleSyncers.push(sync);
  }

  addToggle(cardLook, "Equalizer", "showEq", applyVisualSettings);
  addToggle(cardLook, "Cover glow", "glow", applyVisualSettings);
  addToggle(cardLib, "Remember history", "history");
  addToggle(cardLib, "Like on SoundCloud when starring", "likeOnFav");

  const pillRow = el("div", "sc-pill-row");
  const clearHistBtn = el("button", "sc-pill");
  const resetBtn = el("button", "sc-pill", "Reset settings");
  pillRow.appendChild(clearHistBtn);
  pillRow.appendChild(resetBtn);
  setPanel.appendChild(pillRow);
  setPanel.appendChild(el("div", "sc-version", "SoundCloud Widget v" + SC_WIDGET_VERSION));

  // Slider logic
  function setSliderUI() {
    const pct = (settings.sensitivity - SENS_MIN) / (SENS_MAX - SENS_MIN);
    sliderFill.style.width = (pct * 100).toFixed(1) + "%";
    sliderThumb.style.left = (pct * 100).toFixed(1) + "%";
    sensValue.textContent = settings.sensitivity.toFixed(1) + "x";
  }
  function setSensitivity(v, persist) {
    v = Math.round(Math.min(SENS_MAX, Math.max(SENS_MIN, v)) / SENS_STEP) * SENS_STEP;
    settings.sensitivity = Math.round(v * 10) / 10;
    setSliderUI();
    if (persist) saveSetting("sensitivity");
  }
  function sliderFromEvent(e) {
    const r = slider.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
    setSensitivity(SENS_MIN + pct * (SENS_MAX - SENS_MIN), false);
  }
  let dragging = false;
  slider.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    slider.classList.add("sc-dragging");
    try { slider.setPointerCapture(e.pointerId); } catch (err) {}
    sliderFromEvent(e);
    e.preventDefault();
  });
  slider.addEventListener("pointermove", (e) => { if (dragging) sliderFromEvent(e); });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    slider.classList.remove("sc-dragging");
    saveSetting("sensitivity");
  }
  slider.addEventListener("pointerup", endDrag);
  slider.addEventListener("pointercancel", endDrag);
  let sensSaveTimer = null;
  slider.addEventListener("wheel", (e) => {
    e.preventDefault();
    setSensitivity(settings.sensitivity + (e.deltaY > 0 ? -SENS_STEP : SENS_STEP), false);
    clearTimeout(sensSaveTimer);
    sensSaveTimer = setTimeout(() => saveSetting("sensitivity"), 400);
  }, { passive: false });

  function syncSettingsUI() {
    setSliderUI();
    for (const s of toggleSyncers) s();
    clearHistBtn.classList.toggle("sc-disabled", !store.history.length);
  }

  resetBtn.addEventListener("click", () => {
    for (const k of Object.keys(DEFAULTS)) {
      settings[k] = DEFAULTS[k];
      saveSetting(k);
    }
    syncSettingsUI();
    applyVisualSettings();
  });

  // =================== VIEW STATE ===================
  let view = "player";
  let viewHeightCleanup = null;
  function setView(v) {
    // The player/library/settings panels are different heights, so
    // swapping which one is visible used to snap the widget's height
    // instantly. Measure before/after and transition between them instead.
    if (viewHeightCleanup) { viewHeightCleanup(); viewHeightCleanup = null; }
    const startH = widgetDiv.getBoundingClientRect().height;

    view = v;
    widgetDiv.classList.toggle("sc-panel-open", v !== "player");
    widgetDiv.classList.toggle("sc-view-library", v === "library");
    widgetDiv.classList.toggle("sc-view-settings", v === "settings");
    if (v === "library") renderLibrary();
    if (v === "settings") syncSettingsUI();

    if (startH > 0 && widgetDiv.style.display !== "none") {
      widgetDiv.style.height = startH + "px";
      requestAnimationFrame(() => {
        const endH = widgetDiv.scrollHeight;
        widgetDiv.style.transition = "height 0.18s ease";
        widgetDiv.style.height = endH + "px";
      });
      const clear = () => {
        widgetDiv.style.transition = "";
        widgetDiv.style.height = "";
        widgetDiv.removeEventListener("transitionend", clear);
        if (viewHeightCleanup === clear) viewHeightCleanup = null;
      };
      widgetDiv.addEventListener("transitionend", clear);
      viewHeightCleanup = clear;
    }
    requestAnimationFrame(refreshAllMarquees);
  }
  gearBtn.addEventListener("click", () => setView("settings"));
  libBtn.addEventListener("click", () => setView("library"));

  function setMinimized(v, persist) {
    if (v) setView("player");
    settings.minimized = v;
    widgetDiv.classList.toggle("sc-min", v);
    if (persist) saveSetting("minimized");
    requestAnimationFrame(refreshAllMarquees);
  }
  minBtn.addEventListener("click", () => setMinimized(true, true));
  expandBtn.addEventListener("click", () => setMinimized(false, true));

  // Blur (remembered)
  function applyBlur(v) {
    settings.blur = v;
    artworkEl.style.filter = v ? "blur(16px)" : "none";
    miniArt.style.filter = v ? "blur(8px)" : "none";
    widgetDiv.classList.toggle("sc-blur", v);
    eyeBtn.textContent = "";
    eyeBtn.appendChild(buildEyeSvg(v));
  }
  eyeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    applyBlur(!settings.blur);
    saveSetting("blur");
  });

  function applyVisualSettings() {
    widgetDiv.classList.toggle("sc-no-eq", !settings.showEq);
    if (!settings.glow) {
      artworkWrapper.style.boxShadow = "none";
      miniArtWrap.style.boxShadow = "none";
    }
  }

  // =================== MARQUEE ===================
  function refreshMarquee(box, inner) {
    box.classList.remove("sc-scrolling");
    const overflow = inner.scrollWidth - box.clientWidth;
    if (box.clientWidth > 0 && overflow > 2) {
      const shift = overflow + 16;
      box.style.setProperty("--sc-shift", -shift + "px");
      box.style.setProperty("--sc-dur", Math.max(4, shift / 22).toFixed(1) + "s");
      box.style.textAlign = "left";
      box.classList.add("sc-scrolling");
    } else {
      box.style.textAlign = box === titleEl ? "center" : "left";
    }
  }
  function refreshAllMarquees() {
    refreshMarquee(titleEl, titleText);
    refreshMarquee(miniTitle, miniTitleText);
  }
  try {
    const mo = new ResizeObserver(() => refreshAllMarquees());
    mo.observe(titleEl);
    mo.observe(miniTitle);
  } catch (e) {}

  // =================== STORE (history + favourites) ===================
  // Saved as JSON in the profile folder: sc-widget-data.json
  const store = { history: [], favorites: [] };
  const WINDOW_TAG = Math.random().toString(36).slice(2);
  let DATA_FILE = null;
  try { DATA_FILE = PathUtils.join(PathUtils.profileDir, "sc-widget-data.json"); } catch (e) {}

  function cleanEntry(e) {
    if (!e) return null;
    const url = normUrl(e.url);
    if (!url) return null;
    return {
      url: url,
      title: String(e.title || "").slice(0, 300),
      artist: String(e.artist || "").slice(0, 200),
      artwork: typeof e.artwork === "string" && /^https:\/\//.test(e.artwork) ? e.artwork : "",
      ts: Number(e.ts) || Date.now()
    };
  }

  let saveTimer = null;
  function persistStore() {
    if (!DATA_FILE) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      IOUtils.writeJSON(DATA_FILE, { version: 1, history: store.history, favorites: store.favorites }, { tmpPath: DATA_FILE + ".tmp" })
        .catch((e) => console.log("[SC-WIDGET] save failed: " + (e && e.message)));
    }, 400);
  }

  function storeChanged() {
    persistStore();
    try {
      Services.obs.notifyObservers(null, "sc-widget-store",
        JSON.stringify({ from: WINDOW_TAG, history: store.history, favorites: store.favorites }));
    } catch (e) {}
    renderLibrary();
    updateFavButton();
  }

  // Keep multiple browser windows in sync
  const storeObserver = {
    observe(subject, topic, data) {
      try {
        const j = JSON.parse(data);
        if (j.from === WINDOW_TAG) return;
        store.history = (j.history || []).map(cleanEntry).filter(Boolean);
        store.favorites = (j.favorites || []).map(cleanEntry).filter(Boolean);
        renderLibrary();
        updateFavButton();
      } catch (e) {}
    }
  };
  try {
    Services.obs.addObserver(storeObserver, "sc-widget-store");
    window.addEventListener("unload", () => {
      try { Services.obs.removeObserver(storeObserver, "sc-widget-store"); } catch (e) {}
    }, { once: true });
  } catch (e) {}

  async function loadStore() {
    if (!DATA_FILE) return;
    try {
      if (!(await IOUtils.exists(DATA_FILE))) return;
      const j = await IOUtils.readJSON(DATA_FILE);
      store.history = (Array.isArray(j.history) ? j.history : []).map(cleanEntry).filter(Boolean).slice(0, HISTORY_MAX);
      store.favorites = (Array.isArray(j.favorites) ? j.favorites : []).map(cleanEntry).filter(Boolean);
    } catch (e) {
      console.log("[SC-WIDGET] load failed: " + (e && e.message));
    }
    renderLibrary();
    updateFavButton();
  }

  function isFav(url) { return !!url && store.favorites.some((f) => f.url === url); }

  function toggleFav(entry) {
    const i = store.favorites.findIndex((f) => f.url === entry.url);
    if (i >= 0) store.favorites.splice(i, 1);
    else store.favorites.unshift(Object.assign({}, entry, { ts: Date.now() }));
    storeChanged();
    return i < 0;
  }

  function addHistory(entry) {
    store.history = store.history.filter((h) => h.url !== entry.url);
    store.history.unshift(entry);
    if (store.history.length > HISTORY_MAX) store.history.length = HISTORY_MAX;
    storeChanged();
  }

  function removeHistory(url) {
    store.history = store.history.filter((h) => h.url !== url);
    storeChanged();
  }

  function clearHistory() {
    store.history = [];
    storeChanged();
    syncSettingsUI();
  }

  confirmButton(libClear, "Clear", "Sure?", clearHistory);
  confirmButton(clearHistBtn, "Clear history", "Tap again", clearHistory);

  // =================== LIBRARY RENDER ===================
  const current = { url: null, title: "", artist: "", artwork: "", liked: false };

  function buildRow(it) {
    const row = el("div", "sc-row");
    const isNow = !!current.url && it.url === current.url;
    if (isNow) row.classList.add("sc-now");
    row.title = (it.title || it.url) + (it.artist ? "\n" + it.artist : "") +
      "\n\nClick to play" + DOT + "middle-click opens a new tab";

    const art = el("div", "sc-row-art");
    if (it.artwork) setArt(art, it.artwork);
    if (isNow) {
      const now = el("div", "sc-row-now");
      for (let i = 0; i < 3; i++) now.appendChild(el("span"));
      art.appendChild(now);
    }

    const text = el("div", "sc-row-text");
    text.appendChild(el("div", "sc-row-title sc-ellipsis", it.title || it.url.replace("https://soundcloud.com/", "")));
    const subParts = [];
    if (it.artist) subParts.push(it.artist);
    subParts.push(isNow ? (isPlaying ? "playing" : "paused") : ago(it.ts));
    text.appendChild(el("div", "sc-row-sub sc-ellipsis", subParts.join(DOT)));

    const actions = el("div", "sc-row-actions");
    const fav = isFav(it.url);
    const star = btn(fav ? "sc-on" : "", 20, fav ? "Remove from favourites" : "Add to favourites");
    star.appendChild(iconStar(fav, 11));
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowFav = toggleFav(it);
      // Only the currently-playing track's like state is known here (it's
      // read live from the SoundCloud tab); syncing an arbitrary other
      // row would require navigating away to load its page.
      if (settings.likeOnFav && it.url === current.url) {
        if ((nowFav && !current.liked) || (!nowFav && current.liked)) {
          sendToSoundCloudTab("SCWidget:ToggleLike", "SCWidget:ToggleLikeReply", updateFromInfo);
        }
      }
    });
    actions.appendChild(star);

    if (libTab === "recent") {
      const rm = btn("", 20, "Remove from history");
      rm.appendChild(icon([PATHS.x], { stroke: COL_TEXT_DIM, sw: 2.4, size: 10 }));
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        removeHistory(it.url);
      });
      actions.appendChild(rm);
    }

    row.appendChild(art);
    row.appendChild(text);
    row.appendChild(actions);

    row.addEventListener("click", () => playEntry(it));
    row.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      openInNewTab(it.url);
    });
    row.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    return row;
  }

  function renderLibrary() {
    const items = libTab === "recent" ? store.history : store.favorites;
    const scroll = libList.scrollTop;
    libList.textContent = "";
    if (!items.length) {
      libList.appendChild(el("div", "sc-empty", libTab === "recent"
        ? "Nothing here yet.\nTracks you play show up here."
        : "No favourites yet.\nHit the star under a track to save it."));
      libList.lastChild.style.whiteSpace = "pre-line";
    } else {
      for (const it of items) libList.appendChild(buildRow(it));
    }
    libList.scrollTop = scroll;
    const n = items.length;
    libCount.textContent = libTab === "recent"
      ? (n ? n + (n === 1 ? " track" : " tracks") : "")
      : (n ? n + (n === 1 ? " favourite" : " favourites") : "");
    libClear.style.display = libTab === "recent" && n ? "" : "none";
  }

  // =================== PLAYER STATE ===================
  let lastArtworkUrl = null;
  let widgetVisible = false;
  let isPlaying = false;
  let isMuted = false;
  let iconsReady = false;
  let lastCurrent = 0;
  let lastDuration = 0;
  let candUrl = null;
  let candSince = 0;
  let lastRecordedUrl = null;

  function setPlayIcon(node, s) {
    node.style.cssText = `
      width: 0; height: 0;
      border-top: ${8 * s}px solid transparent;
      border-bottom: ${8 * s}px solid transparent;
      border-left: ${13 * s}px solid ${COL_BG};
      margin-left: ${3 * s}px;
    `;
  }
  function setPauseIcon(node, s) {
    const w = 13 * s, h = 14 * s, b = 4 * s;
    node.style.cssText = `
      width: ${w}px; height: ${h}px;
      background:
        linear-gradient(${COL_BG}, ${COL_BG}) 0 0 / ${b}px ${h}px no-repeat,
        linear-gradient(${COL_BG}, ${COL_BG}) ${w - b}px 0 / ${b}px ${h}px no-repeat;
    `;
  }

  function updateFavButton() {
    const on = isFav(current.url);
    favBtn.textContent = "";
    favBtn.appendChild(iconStar(on, 12));
    favBtn.title = on ? "Remove from favourites" : "Add to favourites";
    favBtn.classList.toggle("sc-disabled", !current.url);
  }

  function showWidget() {
    if (!widgetVisible) {
      widgetDiv.style.display = "flex";
      widgetVisible = true;
      requestAnimationFrame(refreshAllMarquees);
    }
  }
  function hideWidget() {
    if (widgetVisible) {
      widgetDiv.style.display = "none";
      widgetVisible = false;
    }
  }

  function updateFromInfo(data) {
    if (!data || !data.found) {
      hideWidget();
      isPlaying = false;
      return;
    }
    showWidget();

    const playing = typeof data.playing === "boolean" ? data.playing : data.playTitle === "Pause current";
    if (playing !== isPlaying || !iconsReady) {
      iconsReady = true;
      isPlaying = playing;
      if (playing) { setPauseIcon(icon1, 1); setPauseIcon(miniIcon, 0.6); }
      else { setPlayIcon(icon1, 1); setPlayIcon(miniIcon, 0.6); }
      widgetDiv.classList.toggle("sc-paused", !playing);
      if (view === "library") renderLibrary();
    }

    if (data.artworkUrl && data.artworkUrl !== lastArtworkUrl) {
      lastArtworkUrl = data.artworkUrl;
      setArt(artworkEl, data.artworkUrl);
      setArt(miniArt, data.artworkUrl);
    }

    const t = cleanTrackTitle(data.trackTitle) || "";
    if (t && titleText.textContent !== t) {
      titleText.textContent = t;
      miniTitleText.textContent = t;
      miniRow.title = t + (data.artist ? DOT + data.artist : "");
      titleEl.title = t;
      requestAnimationFrame(refreshAllMarquees);
    }
    const artist = data.artist || "";
    if (artistEl.textContent !== artist) {
      artistEl.textContent = artist;
      artistEl.title = artist;
      artistEl.style.display = artist ? "" : "none";
    }

    if (typeof data.muted === "boolean") {
      if (data.muted !== isMuted) setMuteIcon(data.muted);
      isMuted = data.muted;
    }

    const cur = data.currentTime || 0;
    const duration = data.duration || 0;
    lastCurrent = cur;
    lastDuration = duration;
    timeEl.textContent = formatTime(cur) + " / " + formatTime(duration);
    const percent = duration > 0 ? (cur / duration) * 100 : 0;
    progressFill.style.width = percent + "%";
    miniProgressFill.style.width = percent + "%";

    // ---- track identity / history ----
    const url = normUrl(data.trackUrl);
    current.title = t;
    current.artist = artist;
    current.liked = !!data.liked;
    if (url !== current.url) {
      current.url = url;
      updateFavButton();
      if (view === "library") renderLibrary();
    }
    // Art can lag a moment behind the title after a track change,
    // so only trust it once the track has been stable for a bit.
    const now = Date.now();
    if (url !== candUrl) { candUrl = url; candSince = now; }
    const stable = url && now - candSince > 2500;
    if (stable) current.artwork = lastArtworkUrl || "";

    if (stable && settings.history && playing && url !== lastRecordedUrl) {
      lastRecordedUrl = url;
      addHistory({ url, title: t, artist, artwork: current.artwork, ts: now });
    }
  }

  // =================== EQ RENDERING ===================
  let targetBars = new Array(EQ_BAR_COUNT).fill(0);
  const displayBars = new Array(EQ_BAR_COUNT).fill(0);
  let targetGlow = 0;
  let displayGlow = 0;
  let lastAudioMsgTime = 0;
  let lastLoudTime = 0;
  let agcPeak = 0.5;

  function idleBarValue(i, now) {
    return 0.12 + 0.10 * Math.sin(now / 320 + i * 0.75) + 0.05 * Math.sin(now / 130 + i * 1.9);
  }

  function animateEq() {
    if (widgetVisible && view === "player") {
      const now = Date.now();
      const useReal = (now - lastAudioMsgTime < 400) && (now - lastLoudTime < 1500);
      const mini = widgetDiv.classList.contains("sc-min");

      for (let i = 0; i < EQ_BAR_COUNT; i++) {
        let t;
        if (useReal) t = targetBars[i] || 0;
        else if (isPlaying) t = Math.max(0, idleBarValue(i, now));
        else t = 0;
        const k = t > displayBars[i] ? 0.7 : 0.25;
        displayBars[i] += (t - displayBars[i]) * k;
      }

      if (settings.showEq) {
        if (!mini) {
          for (let i = 0; i < EQ_BAR_COUNT; i++) {
            eqBarEls[i].style.height = (3 + displayBars[i] * 15).toFixed(1) + "px";
            eqBarEls[i].style.opacity = isMuted ? "0.3" : (0.45 + displayBars[i] * 0.55).toFixed(2);
          }
        } else {
          const per = EQ_BAR_COUNT / MINI_BAR_COUNT;
          for (let i = 0; i < MINI_BAR_COUNT; i++) {
            let s = 0, n = 0;
            for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) { s += displayBars[j]; n++; }
            const v = n ? s / n : 0;
            miniBarEls[i].style.height = (2 + v * 12).toFixed(1) + "px";
            miniBarEls[i].style.opacity = isMuted ? "0.3" : (0.45 + v * 0.55).toFixed(2);
          }
        }
      }

      let glowTarget;
      if (useReal) glowTarget = targetGlow;
      else if (isPlaying) glowTarget = 0.12 + 0.05 * Math.sin(now / 500);
      else glowTarget = 0;
      displayGlow += (glowTarget - displayGlow) * 0.15;

      if (settings.glow) {
        const shadow = "0 0 " + (8 + displayGlow * 26).toFixed(1) + "px rgba(255, 255, 255, " +
          (0.12 + displayGlow * 0.4).toFixed(2) + ")";
        if (mini) miniArtWrap.style.boxShadow = shadow;
        else artworkWrapper.style.boxShadow = shadow;
      }
    }
    requestAnimationFrame(animateEq);
  }

  // =================== TAB MESSAGING ===================
  function findSoundCloudTab() {
    for (const tab of gBrowser.tabs) {
      if (tab.hasAttribute("pending")) continue;
      try {
        const host = tab.linkedBrowser.currentURI.host;
        if (host && host.includes("soundcloud.com")) return tab;
      } catch (e) {}
    }
    return null;
  }

  function sendToSoundCloudTab(messageName, replyName, onReply, payload) {
    const tab = findSoundCloudTab();
    if (!tab) {
      hideWidget();
      return;
    }
    const mm = tab.linkedBrowser.messageManager;
    if (replyName && onReply) {
      mm.addMessageListener(replyName, function onReplyWrapper(msg) {
        mm.removeMessageListener(replyName, onReplyWrapper);
        onReply(msg.data);
      });
    }
    mm.sendAsyncMessage(messageName, payload);
  }

  function pollInfo() {
    if (!widgetDiv.isConnected) mountWidget();
    if (!findSoundCloudTab()) {
      hideWidget();
      return;
    }
    sendToSoundCloudTab("SCWidget:GetInfo", "SCWidget:GetInfoReply", updateFromInfo);
  }

  function playEntry(it) {
    setView("player");
    const existing = findSoundCloudTab();
    if (!existing) {
      // No SoundCloud tab open at all -> sendToSoundCloudTab would just
      // hideWidget() and silently do nothing. Open one at the track and
      // deliver PlayUrl once its frame script is up, so favourites/history
      // work even when the site isn't already open somewhere.
      let tab;
      try {
        tab = gBrowser.addTab(it.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        gBrowser.selectedTab = tab;
      } catch (e) {
        console.log("[SC-WIDGET] open tab for playEntry failed: " + (e && e.message));
        return;
      }
      const mm = tab.linkedBrowser.messageManager;
      const send = () => { try { mm.sendAsyncMessage("SCWidget:PlayUrl", { url: it.url }); } catch (e) {} };
      // The frame script loads process-wide, but give the new tab a moment
      // to spin up; retry a couple of times in case the first send races it.
      setTimeout(send, 500);
      setTimeout(send, 1500);
      setTimeout(pollInfo, 1800);
      setTimeout(pollInfo, 3000);
      return;
    }
    sendToSoundCloudTab("SCWidget:PlayUrl", null, null, { url: it.url });
    setTimeout(pollInfo, 600);
    setTimeout(pollInfo, 1500);
  }

  function openInNewTab(url) {
    try {
      gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
    } catch (e) {
      console.log("[SC-WIDGET] open tab failed: " + (e && e.message));
    }
  }

  function goToTab() {
    const tab = findSoundCloudTab();
    if (tab) gBrowser.selectedTab = tab;
  }

  // =================== MOUNTING ===================
  let resizeObs = null;
  function findMount() {
    for (const id of ["zen-sidebar-foot-buttons", "zen-sidebar-bottom-buttons"]) {
      const node = document.getElementById(id);
      if (node && node.parentNode) {
        let parent = node.parentNode;
        let before = node;
        try {
          const cs = getComputedStyle(parent);
          if (cs.display.includes("flex") && cs.flexDirection.startsWith("row") && parent.parentNode) {
            before = parent;
            parent = parent.parentNode;
          }
        } catch (e) {}
        return { parent, before };
      }
    }
    const tabs = document.getElementById("tabbrowser-tabs");
    if (tabs && tabs.parentNode) return { parent: tabs.parentNode, before: tabs.nextSibling };
    return null;
  }

  function mountWidget() {
    const m = findMount();
    if (!m) return false;
    if (widgetDiv.parentNode !== m.parent || widgetDiv.nextSibling !== m.before) {
      m.parent.insertBefore(widgetDiv, m.before);
      console.log("[SC-WIDGET] mounted into", m.parent.id || m.parent.tagName);
    }
    try {
      if (resizeObs) resizeObs.disconnect();
      resizeObs = new ResizeObserver(() => {
        widgetDiv.classList.toggle("sc-narrow", m.parent.clientWidth < 150);
      });
      resizeObs.observe(m.parent);
    } catch (e) {}
    return true;
  }

  // =================== WIRE UP ===================
  if (!mountWidget()) {
    let tries = 0;
    const iv = setInterval(() => {
      if (mountWidget() || ++tries > 30) clearInterval(iv);
    }, 500);
  }

  setPlayIcon(icon1, 1);
  setPlayIcon(miniIcon, 0.6);
  applyBlur(settings.blur);
  applyVisualSettings();
  setMinimized(settings.minimized, false);
  updateFavButton();
  renderLibrary();
  loadStore();
  requestAnimationFrame(animateEq);

  // Frame script: loaded globally & early so the audio hooks land before
  // SoundCloud's own scripts run.
  const FRAME_SCRIPT = "(" + scFrameScript.toString() + ")(" + EQ_BAR_COUNT + ");";
  window.messageManager.loadFrameScript(
    "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT), true);

  let lastStatusText = "";
  window.messageManager.addMessageListener("SCWidget:Status", (msg) => {
    const tab = findSoundCloudTab();
    if (!tab || tab.linkedBrowser !== msg.target) return;
    const st = (msg.data && msg.data.status) || "";
    if (st === lastStatusText) return;
    lastStatusText = st;
    eqContainer.title = "EQ: " + st;
    miniEq.title = "EQ: " + st;
    console.log("[SC-WIDGET][tab] " + st);
  });

  window.messageManager.addMessageListener("SCWidget:AudioData", (msg) => {
    const tab = findSoundCloudTab();
    if (!tab || tab.linkedBrowser !== msg.target) return;
    const now = Date.now();
    lastAudioMsgTime = now;
    const raw = msg.data.bars || new Array(EQ_BAR_COUNT).fill(0);
    // Auto-gain: quiet tracks get boosted so the bars always move.
    let peak = 0;
    for (const v of raw) if (v > peak) peak = v;
    agcPeak = Math.max(peak, agcPeak * 0.985, 0.2);
    const gain = settings.sensitivity / agcPeak;
    targetBars = raw.map((v) => Math.min(1, Math.pow(Math.min(1, v * gain * 0.75), 1.15)));
    const lvl = typeof msg.data.level === "number" ? msg.data.level : 0;
    targetGlow = Math.min(1, lvl * 2.2 * settings.sensitivity / Math.max(agcPeak, 0.3));
    if (targetGlow > 0.004) lastLoudTime = now;
  });

  pollInfo();
  gBrowser.tabContainer.addEventListener("SSTabRestored", (event) => {
    try {
      const host = event.target.linkedBrowser.currentURI.host;
      if (host && host.includes("soundcloud.com")) pollInfo();
    } catch (e) {}
  });
  gBrowser.tabContainer.addEventListener("TabClose", () => setTimeout(pollInfo, 100));
  setInterval(pollInfo, 1000);

  // Controls
  function togglePlay() {
    sendToSoundCloudTab("SCWidget:TogglePlay", "SCWidget:TogglePlayReply", updateFromInfo);
  }
  playPauseBtn.addEventListener("click", togglePlay);
  miniPlayBtn.addEventListener("click", togglePlay);

  muteBtn.addEventListener("click", () => {
    sendToSoundCloudTab("SCWidget:ToggleMute", "SCWidget:ToggleMuteReply", updateFromInfo);
  });
  nextBtn.addEventListener("click", () => {
    sendToSoundCloudTab("SCWidget:Next", "SCWidget:NextReply", () => setTimeout(pollInfo, 300));
  });
  prevBtn.addEventListener("click", () => {
    sendToSoundCloudTab("SCWidget:Prev", "SCWidget:PrevReply", () => setTimeout(pollInfo, 300));
  });

  favBtn.addEventListener("click", () => {
    if (!current.url) return;
    const nowFav = toggleFav({
      url: current.url,
      title: current.title,
      artist: current.artist,
      artwork: current.artwork || lastArtworkUrl || "",
      ts: Date.now()
    });
    favBtn.classList.remove("sc-pop");
    void favBtn.offsetWidth;
    favBtn.classList.add("sc-pop");
    // Keep the SoundCloud like in sync in both directions: liking when a
    // track is favourited, and un-liking when it's un-favourited (this used
    // to only ever add the like, never remove it).
    if (settings.likeOnFav) {
      if ((nowFav && !current.liked) || (!nowFav && current.liked)) {
        sendToSoundCloudTab("SCWidget:ToggleLike", "SCWidget:ToggleLikeReply", updateFromInfo);
      }
    }
  });

  artworkEl.addEventListener("click", goToTab);
  miniArt.addEventListener("click", goToTab);

  function seekFrom(node) {
    return (e) => {
      const rect = node.getBoundingClientRect();
      const percent = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      sendToSoundCloudTab("SCWidget:Seek", "SCWidget:SeekReply", updateFromInfo, { percent });
    };
  }
  progressOuter.addEventListener("click", seekFrom(progressOuter));
  miniProgress.addEventListener("click", seekFrom(miniProgress));

  // Scroll on the progress bar = skip 5s
  function wheelSeek(e) {
    if (!lastDuration) return;
    e.preventDefault();
    const delta = e.deltaY > 0 || e.deltaX > 0 ? 5 : -5;
    const target = Math.min(lastDuration - 0.5, Math.max(0, lastCurrent + delta));
    lastCurrent = target;
    const percent = target / lastDuration;
    progressFill.style.width = percent * 100 + "%";
    miniProgressFill.style.width = percent * 100 + "%";
    sendToSoundCloudTab("SCWidget:Seek", "SCWidget:SeekReply", updateFromInfo, { percent });
  }
  progressOuter.addEventListener("wheel", wheelSeek, { passive: false });
  miniProgress.addEventListener("wheel", wheelSeek, { passive: false });

  function hoverTime(node) {
    return (e) => {
      if (!lastDuration) return;
      const rect = node.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      node.title = formatTime(pct * lastDuration);
    };
  }
  progressOuter.addEventListener("mousemove", hoverTime(progressOuter));
  miniProgress.addEventListener("mousemove", hoverTime(miniProgress));

  // Don't draw over the urlbar results panel
  try {
    const urlbarPanel = window.gURLBar && window.gURLBar.view && window.gURLBar.view.panel;
    if (urlbarPanel) {
      urlbarPanel.addEventListener("popupshowing", () => {
        widgetDiv.style.opacity = "0";
        widgetDiv.style.pointerEvents = "none";
      });
      urlbarPanel.addEventListener("popuphidden", () => {
        widgetDiv.style.opacity = "1";
        widgetDiv.style.pointerEvents = "";
      });
    }
  } catch (e) {}
}

// ---- Boot ----
try {
  if (typeof UC_API !== "undefined" && UC_API && UC_API.Runtime && UC_API.Runtime.startupFinished) {
    UC_API.Runtime.startupFinished().then(scWidgetInit);
  } else if (document.readyState === "complete") {
    scWidgetInit();
  } else {
    window.addEventListener("load", scWidgetInit, { once: true });
  }
} catch (e) {
  console.log("[SC-WIDGET] top-level error while triggering init: " + (e && e.message));
}