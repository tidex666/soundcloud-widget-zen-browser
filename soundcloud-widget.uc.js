// ==UserScript==
// @name           soundcloud-widget
// @include        main
// ==/UserScript==
//
// v1.3.0
//  - More sensitive EQ (hotter analyser range + auto-gain). Tweak EQ_SENSITIVITY.
//  - Long titles no longer widen the widget; they scroll (marquee) instead.
//
// v1.2.0
//  - Fix: minimize button no longer shows in minimized mode.
//  - Fix: audio hook used a global (exportFunction) that doesn't exist in
//    frame scripts, so it silently never installed. Now uses Cu.exportFunction.
//  - EQ only taps when its AudioContext is running (never mutes music),
//    retries automatically, and reports status (hover the EQ bars).
//
// v1.1.0
//  - Widget now lives in normal layout flow above Zen's sidebar footer
//    (reserves its own space, tabs scroll above it instead of going under).
//  - Minimize / expand (state remembered in pref "sc-widget.minimized").
//  - Real audio-reactive EQ: taps SoundCloud's <audio> element (which is
//    what SoundCloud actually plays through, via MSE/HLS) instead of only
//    hooking Web Audio connect(). The Web Audio hook is kept as a backup.

console.log("[SC-WIDGET] script file loaded");

// =====================================================================
// FRAME SCRIPT (runs inside every tab's content process).
// Written as a real function and serialized with toString(), so there is
// no escaping hell. It must NOT reference anything from the chrome scope.
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

    let rawTitle = null;
    if (titleBadge) {
      const inner = titleBadge.querySelector("a, span");
      rawTitle = inner ? inner.textContent.trim() : titleBadge.textContent.trim();
    }

    return {
      found: !!playBtn,
      playTitle: playBtn ? playBtn.title : null,
      trackTitle: rawTitle,
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
function scWidgetInit() {
  if (document.getElementById("sc-widget-test")) return;
  console.log("[SC-WIDGET] scWidgetInit() running");

  // ---- Palette (Catppuccin Mocha) ----
  const COL_BG = "#1e1e2e";
  const COL_TEXT = "#cdd6f4";
  const COL_SELECTION = "#585b70";
  const COL_SURFACE = "rgba(205, 214, 244, 0.08)";
  const COL_TEXT_DIM = "rgba(205, 214, 244, 0.6)";
  const COL_TRACK = "rgba(205, 214, 244, 0.14)";

  const EQ_BAR_COUNT = 14;
  const MINI_BAR_COUNT = 4;
  // EQ sensitivity: 1 = calm, 1.6 = default, 2.5+ = very jumpy
  const EQ_SENSITIVITY = 1.6;
  const PREF_MIN = "sc-widget.minimized";
  const SVG_NS = "http://www.w3.org/2000/svg";

  function readMinPref() {
    try { return Services.prefs.getBoolPref(PREF_MIN, false); } catch (e) { return false; }
  }
  function writeMinPref(v) {
    try { Services.prefs.setBoolPref(PREF_MIN, v); } catch (e) {}
  }

  // ---- Root ----
  // Normal flow + flex-shrink:0 = it takes real space in the sidebar,
  // the tab list shrinks/scrolls above it instead of sliding underneath.
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
    contain: inline-size;      /* content (long titles) can't widen the widget */
    overflow: hidden;
    margin: 6px 8px 8px;
    padding: 10px 12px;
    box-sizing: border-box;
    -moz-window-dragging: no-drag;
    font-family: system-ui, -apple-system, sans-serif;
    background: rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(6px) saturate(120%);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: 16px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.20);
    transition: opacity 0.12s ease;
  `;

  const styleTag = document.createElement("style");
  styleTag.textContent = `
    #sc-widget-test *::selection { background-color: ${COL_SELECTION}; color: ${COL_TEXT}; }
    #sc-widget-test button { transition: background-color 0.12s ease, transform 0.08s ease, opacity 0.15s ease; }
    #sc-widget-test button:hover { background-color: ${COL_SELECTION} !important; }
    #sc-widget-test button:active { transform: scale(0.94); }

    #sc-widget-test.sc-narrow { display: none !important; }
    #sc-widget-test.sc-min { padding: 6px 8px !important; border-radius: 12px !important; }
    #sc-widget-test.sc-min #sc-full { display: none !important; }
    #sc-widget-test:not(.sc-min) #sc-mini { display: none !important; }
    #sc-widget-test.sc-min #sc-widget-minbtn { display: none !important; }

    .sc-marquee {
      overflow: hidden;
      white-space: nowrap;
      min-width: 0;
      max-width: 100%;
    }
    .sc-marquee.sc-scrolling {
      mask-image: linear-gradient(90deg, transparent 0, #000 8px, #000 calc(100% - 8px), transparent 100%);
    }
    .sc-marquee > span {
      display: inline-block;
      white-space: nowrap;
      will-change: transform;
    }
    .sc-marquee.sc-scrolling > span {
      padding: 0 8px;
      animation: sc-marquee var(--sc-dur, 8s) ease-in-out infinite alternate;
    }
    .sc-marquee.sc-scrolling:hover > span { animation-play-state: paused; }
    @keyframes sc-marquee {
      0%, 15%   { transform: translateX(0); }
      85%, 100% { transform: translateX(var(--sc-shift, 0px)); }
    }

    #sc-widget-minbtn { opacity: 0.35; }
    #sc-widget-test:hover #sc-widget-minbtn { opacity: 1; }
  `;
  widgetDiv.appendChild(styleTag);

  // ---- Small helpers ----
  function circleBtn(id, size, bg) {
    const b = document.createElement("button");
    if (id) b.id = id;
    b.style.cssText = `
      width: ${size}px; height: ${size}px; min-width: ${size}px;
      border-radius: 50%; border: none; background-color: ${bg};
      cursor: pointer; -moz-window-dragging: no-drag;
      display: flex; align-items: center; justify-content: center;
      padding: 0; flex-shrink: 0; appearance: none;
    `;
    return b;
  }

  function buildChevron(up) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "10");
    svg.setAttribute("height", "10");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", COL_TEXT);
    svg.setAttribute("stroke-width", "3");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6");
    svg.appendChild(p);
    return svg;
  }

  function setPlayIcon(el, s) {
    el.style.cssText = `
      width: 0; height: 0;
      border-top: ${8 * s}px solid transparent;
      border-bottom: ${8 * s}px solid transparent;
      border-left: ${13 * s}px solid ${COL_BG};
      margin-left: ${3 * s}px;
    `;
  }

  function setPauseIcon(el, s) {
    const w = 13 * s, h = 14 * s, b = 4 * s;
    el.style.cssText = `
      width: ${w}px; height: ${h}px;
      background:
        linear-gradient(${COL_BG}, ${COL_BG}) 0 0 / ${b}px ${h}px no-repeat,
        linear-gradient(${COL_BG}, ${COL_BG}) ${w - b}px 0 / ${b}px ${h}px no-repeat;
    `;
  }

  // ---- Minimize button (full mode, top-right) ----
  const minBtn = circleBtn("sc-widget-minbtn", 18, COL_SURFACE);
  minBtn.title = "Minimize";
  minBtn.style.position = "absolute";
  minBtn.style.top = "6px";
  minBtn.style.right = "6px";
  minBtn.style.zIndex = "2";
  minBtn.appendChild(buildChevron(false));
  widgetDiv.appendChild(minBtn);

  // =================== FULL VIEW ===================
  const fullBody = document.createElement("div");
  fullBody.id = "sc-full";
  fullBody.style.cssText = `
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 7px; width: 100%; min-width: 0;
  `;

  // Artwork
  const artworkWrapper = document.createElement("div");
  artworkWrapper.style.cssText = `
    position: relative; width: 56px; height: 56px; border-radius: 8px;
    overflow: hidden; background-color: ${COL_SURFACE}; flex-shrink: 0;
  `;
  const artworkEl = document.createElement("div");
  artworkEl.id = "sc-widget-artwork";
  artworkEl.style.cssText = `
    width: 100%; height: 100%; background-size: cover;
    background-position: center; transition: filter 0.15s ease;
  `;
  artworkWrapper.appendChild(artworkEl);

  // Eye (blur artwork)
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

  const eyeBtn = circleBtn("sc-widget-eye", 18, COL_TEXT);
  eyeBtn.style.position = "absolute";
  eyeBtn.style.top = "4px";
  eyeBtn.style.right = "4px";
  function setEyeIcon(closed) {
    eyeBtn.textContent = "";
    eyeBtn.appendChild(buildEyeSvg(closed));
  }
  setEyeIcon(false);

  let artworkHidden = false;
  eyeBtn.addEventListener("click", () => {
    artworkHidden = !artworkHidden;
    const f = artworkHidden ? "blur(16px)" : "none";
    artworkEl.style.filter = f;
    miniArt.style.filter = artworkHidden ? "blur(8px)" : "none";
    setEyeIcon(artworkHidden);
  });
  artworkWrapper.appendChild(eyeBtn);

  // Title
  const titleEl = document.createElement("div");
  titleEl.id = "sc-widget-title";
  titleEl.className = "sc-marquee";
  titleEl.style.cssText = `
    color: ${COL_TEXT}; font-size: 11px; font-weight: 600;
    width: 100%; text-align: center;
  `;
  const titleText = document.createElement("span");
  titleText.textContent = "â€”";
  titleEl.appendChild(titleText);

  // EQ
  const eqContainer = document.createElement("div");
  eqContainer.id = "sc-widget-eq";
  eqContainer.style.cssText = `
    display: flex; align-items: flex-end; justify-content: center;
    gap: 2px; width: 100%; height: 18px;
  `;
  const eqBarEls = [];
  for (let i = 0; i < EQ_BAR_COUNT; i++) {
    const bar = document.createElement("div");
    bar.style.cssText = `
      width: 3px; height: 3px; border-radius: 2px;
      background: linear-gradient(180deg, ${COL_TEXT} 0%, rgba(205, 214, 244, 0.35) 100%);
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

  const muteBtn = circleBtn("sc-widget-mute", 20, COL_TEXT);
  function setMuteIcon(muted) {
    muteBtn.textContent = "";
    muteBtn.appendChild(buildSpeakerSvg(muted));
  }
  setMuteIcon(false);

  // Progress
  const progressOuter = document.createElement("div");
  progressOuter.id = "sc-widget-progress-outer";
  progressOuter.style.cssText = `
    width: 100%; height: 4px; background: ${COL_TRACK};
    border-radius: 2px; cursor: pointer; position: relative;
  `;
  const progressFill = document.createElement("div");
  progressFill.style.cssText = `height: 100%; width: 0%; background: ${COL_TEXT}; border-radius: 2px;`;
  progressOuter.appendChild(progressFill);

  // Time + mute row
  const timeRow = document.createElement("div");
  timeRow.style.cssText = `display: flex; align-items: center; justify-content: space-between; width: 100%;`;
  const timeEl = document.createElement("div");
  timeEl.id = "sc-widget-time";
  timeEl.style.cssText = `color: ${COL_TEXT_DIM}; font-size: 10px; font-variant-numeric: tabular-nums;`;
  timeEl.textContent = "0:00 / 0:00";
  timeRow.appendChild(timeEl);
  timeRow.appendChild(muteBtn);

  // Controls
  const controlsRow = document.createElement("div");
  controlsRow.style.cssText = `display: flex; align-items: center; justify-content: center; gap: 8px;`;

  const prevBtn = circleBtn("sc-widget-prev", 24, COL_SURFACE);
  const prevIcon = document.createElement("span");
  prevIcon.style.cssText = `
    width: 0; height: 0; border-top: 5px solid transparent;
    border-bottom: 5px solid transparent; border-right: 8px solid ${COL_TEXT}; margin-right: 2px;
  `;
  prevBtn.appendChild(prevIcon);

  const playPauseBtn = circleBtn("sc-widget-playpause", 34, COL_TEXT);
  const icon = document.createElement("span");
  playPauseBtn.appendChild(icon);

  const nextBtn = circleBtn("sc-widget-next", 24, COL_SURFACE);
  const nextIcon = document.createElement("span");
  nextIcon.style.cssText = `
    width: 0; height: 0; border-top: 5px solid transparent;
    border-bottom: 5px solid transparent; border-left: 8px solid ${COL_TEXT}; margin-left: 2px;
  `;
  nextBtn.appendChild(nextIcon);

  controlsRow.appendChild(prevBtn);
  controlsRow.appendChild(playPauseBtn);
  controlsRow.appendChild(nextBtn);

  fullBody.appendChild(artworkWrapper);
  fullBody.appendChild(titleEl);
  fullBody.appendChild(eqContainer);
  fullBody.appendChild(progressOuter);
  fullBody.appendChild(timeRow);
  fullBody.appendChild(controlsRow);
  widgetDiv.appendChild(fullBody);

  // =================== MINI VIEW ===================
  const miniRow = document.createElement("div");
  miniRow.id = "sc-mini";
  miniRow.style.cssText = `display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;`;

  const miniArtWrap = document.createElement("div");
  miniArtWrap.style.cssText = `
    width: 28px; height: 28px; border-radius: 6px; overflow: hidden;
    flex-shrink: 0; background-color: ${COL_SURFACE};
  `;
  const miniArt = document.createElement("div");
  miniArt.style.cssText = `
    width: 100%; height: 100%; background-size: cover;
    background-position: center; transition: filter 0.15s ease;
  `;
  miniArtWrap.appendChild(miniArt);

  const miniText = document.createElement("div");
  miniText.style.cssText = `flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px;`;
  const miniTitle = document.createElement("div");
  miniTitle.className = "sc-marquee";
  miniTitle.style.cssText = `color: ${COL_TEXT}; font-size: 11px; font-weight: 600; width: 100%;`;
  const miniTitleText = document.createElement("span");
  miniTitleText.textContent = "â€”";
  miniTitle.appendChild(miniTitleText);
  const miniProgress = document.createElement("div");
  miniProgress.style.cssText = `width: 100%; height: 3px; background: ${COL_TRACK}; border-radius: 2px; cursor: pointer;`;
  const miniProgressFill = document.createElement("div");
  miniProgressFill.style.cssText = `height: 100%; width: 0%; background: ${COL_TEXT}; border-radius: 2px;`;
  miniProgress.appendChild(miniProgressFill);
  miniText.appendChild(miniTitle);
  miniText.appendChild(miniProgress);

  const miniEq = document.createElement("div");
  miniEq.style.cssText = `display: flex; align-items: flex-end; gap: 2px; height: 14px; flex-shrink: 0;`;
  const miniBarEls = [];
  for (let i = 0; i < MINI_BAR_COUNT; i++) {
    const b = document.createElement("div");
    b.style.cssText = `width: 2px; height: 2px; border-radius: 1px; background: ${COL_TEXT}; opacity: 0.6;`;
    miniEq.appendChild(b);
    miniBarEls.push(b);
  }

  const miniPlayBtn = circleBtn("sc-widget-mini-play", 24, COL_TEXT);
  const miniIcon = document.createElement("span");
  miniPlayBtn.appendChild(miniIcon);

  const expandBtn = circleBtn("sc-widget-expand", 18, COL_SURFACE);
  expandBtn.title = "Expand";
  expandBtn.appendChild(buildChevron(true));

  miniRow.appendChild(miniArtWrap);
  miniRow.appendChild(miniText);
  miniRow.appendChild(miniEq);
  miniRow.appendChild(miniPlayBtn);
  miniRow.appendChild(expandBtn);
  widgetDiv.appendChild(miniRow);

  setPlayIcon(icon, 1);
  setPlayIcon(miniIcon, 0.6);

  function setMinimized(v, persist) {
    widgetDiv.classList.toggle("sc-min", v);
    requestAnimationFrame(() => { try { refreshAllMarquees(); } catch (e) {} });
    if (persist) writeMinPref(v);
  }
  setMinimized(readMinPref(), false);
  minBtn.addEventListener("click", () => setMinimized(true, true));
  expandBtn.addEventListener("click", () => setMinimized(false, true));

  // =================== MOUNTING ===================
  // Put the widget right above Zen's sidebar footer (workspace switcher
  // etc.). Fallback: right after the tab strip.
  let resizeObs = null;

  function findMount() {
    for (const id of ["zen-sidebar-foot-buttons", "zen-sidebar-bottom-buttons"]) {
      const el = document.getElementById(id);
      if (el && el.parentNode) {
        let parent = el.parentNode;
        let before = el;
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
    // Hide when the sidebar is collapsed to icons-only
    try {
      if (resizeObs) resizeObs.disconnect();
      resizeObs = new ResizeObserver(() => {
        widgetDiv.classList.toggle("sc-narrow", m.parent.clientWidth < 150);
      });
      resizeObs.observe(m.parent);
    } catch (e) {}
    return true;
  }

  if (!mountWidget()) {
    let tries = 0;
    const iv = setInterval(() => {
      if (mountWidget() || ++tries > 30) clearInterval(iv);
    }, 500);
  }

  // =================== TITLE MARQUEE ===================
  // If the title doesn't fit, it slides left -> right and back (pauses on hover).
  function refreshMarquee(box, inner) {
    box.classList.remove("sc-scrolling");
    const overflow = inner.scrollWidth - box.clientWidth;
    if (box.clientWidth > 0 && overflow > 2) {
      const shift = overflow + 16; // + padding
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

  // =================== STATE / UPDATES ===================
  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec;
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

  let lastArtworkUrl = null;
  let widgetVisible = false;
  let isPlaying = false;
  let isMuted = false;

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

    if (data.playTitle === "Pause current") {
      setPauseIcon(icon, 1);
      setPauseIcon(miniIcon, 0.6);
      isPlaying = true;
    } else if (data.playTitle === "Play current") {
      setPlayIcon(icon, 1);
      setPlayIcon(miniIcon, 0.6);
      isPlaying = false;
    }

    if (data.artworkUrl && data.artworkUrl !== lastArtworkUrl) {
      lastArtworkUrl = data.artworkUrl;
      artworkEl.style.backgroundImage = `url("${data.artworkUrl}")`;
      miniArt.style.backgroundImage = `url("${data.artworkUrl}")`;
    }

    if (data.trackTitle) {
      const t = cleanTrackTitle(data.trackTitle);
      if (titleText.textContent !== t) {
        titleText.textContent = t;
        miniTitleText.textContent = t;
        miniRow.title = t;
        titleEl.title = t;
        requestAnimationFrame(refreshAllMarquees);
      }
    }

    if (typeof data.muted === "boolean") {
      setMuteIcon(data.muted);
      isMuted = data.muted;
    }

    const current = data.currentTime || 0;
    const duration = data.duration || 0;
    timeEl.textContent = formatTime(current) + " / " + formatTime(duration);
    const percent = duration > 0 ? (current / duration) * 100 : 0;
    progressFill.style.width = percent + "%";
    miniProgressFill.style.width = percent + "%";
  }

  // =================== EQ RENDERING ===================
  let targetBars = new Array(EQ_BAR_COUNT).fill(0);
  let displayBars = new Array(EQ_BAR_COUNT).fill(0);
  let targetGlow = 0;
  let displayGlow = 0;
  let lastAudioMsgTime = 0;
  let lastLoudTime = 0;
  let agcPeak = 0.5;

  function idleBarValue(i, now) {
    return 0.12 + 0.10 * Math.sin(now / 320 + i * 0.75) + 0.05 * Math.sin(now / 130 + i * 1.9);
  }

  function animateEq() {
    if (widgetVisible) {
      const now = Date.now();
      // Real data = messages are arriving AND there was actual signal recently.
      const useReal = (now - lastAudioMsgTime < 400) && (now - lastLoudTime < 1500);

      for (let i = 0; i < EQ_BAR_COUNT; i++) {
        let t;
        if (useReal) t = targetBars[i] || 0;
        else if (isPlaying) t = Math.max(0, idleBarValue(i, now));
        else t = 0;
        // fast attack, slower release = punchier bars
        const k = t > displayBars[i] ? 0.7 : 0.25;
        displayBars[i] += (t - displayBars[i]) * k;
      }

      if (!widgetDiv.classList.contains("sc-min")) {
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

      let glowTarget;
      if (useReal) glowTarget = targetGlow;
      else if (isPlaying) glowTarget = 0.12 + 0.05 * Math.sin(now / 500);
      else glowTarget = 0;
      displayGlow += (glowTarget - displayGlow) * 0.15;

      const shadow = "0 0 " + (8 + displayGlow * 26).toFixed(1) + "px rgba(205, 214, 244, " +
        (0.12 + displayGlow * 0.4).toFixed(2) + ")";
      artworkWrapper.style.boxShadow = shadow;
      miniArtWrap.style.boxShadow = shadow;
    }
    requestAnimationFrame(animateEq);
  }
  requestAnimationFrame(animateEq);

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

  // Load the frame script globally & early, so the hooks are in place
  // before SoundCloud's own scripts run on fresh page loads.
  const FRAME_SCRIPT = "(" + scFrameScript.toString() + ")(" + EQ_BAR_COUNT + ");";
  window.messageManager.loadFrameScript(
    "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT), true);

  // Audio tap status -> hover the EQ bars to see it, also in Browser Console.
  let lastStatusText = "";
  window.messageManager.addMessageListener("SCWidget:Status", (msg) => {
    const currentTab = findSoundCloudTab();
    if (!currentTab || currentTab.linkedBrowser !== msg.target) return;
    const st = (msg.data && msg.data.status) || "";
    if (st === lastStatusText) return;
    lastStatusText = st;
    eqContainer.title = "EQ: " + st;
    miniEq.title = "EQ: " + st;
    console.log("[SC-WIDGET][tab] " + st);
  });

  window.messageManager.addMessageListener("SCWidget:AudioData", (msg) => {
    const currentTab = findSoundCloudTab();
    if (!currentTab || currentTab.linkedBrowser !== msg.target) return;
    const now = Date.now();
    lastAudioMsgTime = now;
    const raw = msg.data.bars || new Array(EQ_BAR_COUNT).fill(0);
    // Auto-gain: quiet tracks get boosted so the bars always move.
    let peak = 0;
    for (const v of raw) if (v > peak) peak = v;
    agcPeak = Math.max(peak, agcPeak * 0.985, 0.2);
    const gain = EQ_SENSITIVITY / agcPeak;
    targetBars = raw.map((v) => Math.min(1, Math.pow(Math.min(1, v * gain * 0.75), 1.15)));
    const lvl = typeof msg.data.level === "number" ? msg.data.level : 0;
    targetGlow = Math.min(1, lvl * 2.2 * EQ_SENSITIVITY / Math.max(agcPeak, 0.3));
    if (targetGlow > 0.004) lastLoudTime = now;
  });

  function sendToSoundCloudTab(messageName, replyName, onReply, payload) {
    const tab = findSoundCloudTab();
    if (!tab) {
      hideWidget();
      return;
    }
    const mm = tab.linkedBrowser.messageManager;
    mm.addMessageListener(replyName, function onReplyWrapper(msg) {
      mm.removeMessageListener(replyName, onReplyWrapper);
      onReply(msg.data);
    });
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

  pollInfo();

  gBrowser.tabContainer.addEventListener("SSTabRestored", (event) => {
    try {
      const host = event.target.linkedBrowser.currentURI.host;
      if (host && host.includes("soundcloud.com")) pollInfo();
    } catch (e) {}
  });
  gBrowser.tabContainer.addEventListener("TabClose", () => setTimeout(pollInfo, 100));
  setInterval(pollInfo, 1000);

  // =================== CONTROLS ===================
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

  function seekFrom(el) {
    return (e) => {
      const rect = el.getBoundingClientRect();
      const percent = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      sendToSoundCloudTab("SCWidget:Seek", "SCWidget:SeekReply", updateFromInfo, { percent });
    };
  }
  progressOuter.addEventListener("click", seekFrom(progressOuter));
  miniProgress.addEventListener("click", seekFrom(miniProgress));

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