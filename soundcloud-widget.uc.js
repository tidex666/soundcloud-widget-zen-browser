// ==UserScript==
// @name           soundcloud-widget-test
// @include        main
// ==/UserScript==

UC_API.Runtime.startupFinished().then(() => {
  const container = document.querySelector(".zen-workspace-empty-space");

  if (!container) {
    console.log("[SC-WIDGET] Nie znaleziono .zen-workspace-empty-space :(");
    return;
  }

  container.style.position = "relative";

  // ---- Paleta (Catppuccin Mocha) ----
  const COL_BG = "#1e1e2e";
  const COL_TEXT = "#cdd6f4";
  const COL_SELECTION = "#585b70";
  const COL_SURFACE = "rgba(205, 214, 244, 0.08)";
  const COL_SURFACE_HOVER = "rgba(205, 214, 244, 0.16)";
  const COL_BORDER = "rgba(205, 214, 244, 0.08)";
  const COL_TEXT_DIM = "rgba(205, 214, 244, 0.6)";
  const COL_TRACK = "rgba(205, 214, 244, 0.14)";

  // Musi być zgodne z EQ_BAR_COUNT w FRAME_SCRIPT (poniżej)!
  const EQ_BAR_COUNT = 14;

  const widgetDiv = document.createElement("div");
  widgetDiv.id = "sc-widget-test";
  // Ukryty dopóki nie znajdziemy karty z SoundCloudem
  widgetDiv.style.cssText = `
    position: absolute;
    bottom: 50px;
    left: 20px;
    right: 20px;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 10px 12px;
    box-sizing: border-box;
    -moz-window-dragging: no-drag;
    font-family: system-ui, -apple-system, sans-serif;

    /* --- Glossy / transparent look --- */
    background:
      linear-gradient(160deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 40%, rgba(255,255,255,0.00) 60%),
      rgba(30, 30, 46, 0.55);
    backdrop-filter: blur(22px) saturate(160%);
    -moz-backdrop-filter: blur(22px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-top-color: rgba(255, 255, 255, 0.28);
    border-radius: 16px;
    box-shadow:
      0 10px 24px rgba(0, 0, 0, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.12);
  `;

  const styleTag = document.createElement("style");
  styleTag.textContent = `
    #sc-widget-test *::selection {
      background-color: ${COL_SELECTION};
      color: ${COL_TEXT};
    }
    #sc-widget-test button {
      transition: background-color 0.12s ease, transform 0.08s ease;
    }
    #sc-widget-test button:hover {
      background-color: ${COL_SELECTION} !important;
    }
    #sc-widget-test button:active {
      transform: scale(0.94);
    }
    #sc-widget-test .sc-eq-bar {
      transition: opacity 0.15s ease;
    }
  `;
  widgetDiv.appendChild(styleTag);

  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---- Okładka ----
  const artworkWrapper = document.createElement("div");
  artworkWrapper.style.cssText = `
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 8px;
    overflow: hidden;
    background-color: ${COL_SURFACE};
    flex-shrink: 0;
    transition: box-shadow 0.05s linear;
  `;

  const artworkEl = document.createElement("div");
  artworkEl.id = "sc-widget-artwork";
  artworkEl.style.cssText = `
    width: 100%;
    height: 100%;
    background-size: cover;
    background-position: center;
    transition: filter 0.15s ease;
  `;
  artworkWrapper.appendChild(artworkEl);

  // ---- Ikonka oka (blur okładki) ----
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

  const eyeBtn = document.createElement("button");
  eyeBtn.id = "sc-widget-eye";
  eyeBtn.style.cssText = `
    position: absolute;
    top: 4px;
    right: 4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: none;
    background-color: ${COL_TEXT};
    cursor: pointer;
    -moz-window-dragging: no-drag;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  `;

  function setEyeIcon(closed) {
    eyeBtn.textContent = "";
    eyeBtn.appendChild(buildEyeSvg(closed));
  }

  setEyeIcon(false);

  let artworkHidden = false;
  eyeBtn.addEventListener("click", () => {
    artworkHidden = !artworkHidden;
    if (artworkHidden) {
      artworkEl.style.filter = "blur(16px)";
      setEyeIcon(true);
    } else {
      artworkEl.style.filter = "none";
      setEyeIcon(false);
    }
  });

  artworkWrapper.appendChild(eyeBtn);

  // ---- Tytuł utworu ----
  const titleEl = document.createElement("div");
  titleEl.id = "sc-widget-title";
  titleEl.style.cssText = `
    color: ${COL_TEXT};
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    text-align: center;
  `;
  titleEl.textContent = "—";

  // ---- Equalizer (reaguje na dźwięk z karty SoundClouda) ----
  const eqContainer = document.createElement("div");
  eqContainer.id = "sc-widget-eq";
  eqContainer.style.cssText = `
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 2px;
    width: 100%;
    height: 18px;
    -moz-window-dragging: no-drag;
  `;

  const eqBarEls = [];
  for (let i = 0; i < EQ_BAR_COUNT; i++) {
    const bar = document.createElement("div");
    bar.className = "sc-eq-bar";
    bar.style.cssText = `
      width: 3px;
      height: 3px;
      border-radius: 2px;
      background: linear-gradient(180deg, ${COL_TEXT} 0%, rgba(205, 214, 244, 0.35) 100%);
      opacity: 0.5;
    `;
    eqContainer.appendChild(bar);
    eqBarEls.push(bar);
  }

  // ---- Przycisk mute ----
  function buildSpeakerSvg(muted) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "10");
    svg.setAttribute("height", "10");
    svg.setAttribute("fill", COL_BG);

    const path1 = document.createElementNS(SVG_NS, "path");
    path1.setAttribute("d", "M7.14645 1.85356C7.46143 1.53858 8 1.76167 8 2.20712V13.7929C8 14.2384 7.46143 14.4614 7.14645 14.1465L4 11H1.5C1.22386 11 1 10.7762 1 10.5V5.50001C1 5.22387 1.22386 5.00001 1.5 5.00001H4L7.14645 1.85356Z");
    svg.appendChild(path1);

    const path2 = document.createElementNS(SVG_NS, "path");
    if (muted) {
      path2.setAttribute("d", "M13.4697 10.5303L12 9.06066L10.5303 10.5303L9.46967 9.46967L10.9393 8L9.46967 6.53033L10.5303 5.46967L12 6.93934L13.4697 5.46967L14.5303 6.53033L13.0607 8L14.5303 9.46967L13.4697 10.5303Z");
    } else {
      path2.setAttribute("d", "M12 7.99999C12 9.48649 10.9189 10.7205 9.5 10.9585V5.04147C10.9189 5.27951 12 6.5135 12 7.99999Z");
    }
    svg.appendChild(path2);

    return svg;
  }

  const muteBtn = document.createElement("button");
  muteBtn.id = "sc-widget-mute";
  muteBtn.style.cssText = `
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: none;
    background-color: ${COL_TEXT};
    cursor: pointer;
    -moz-window-dragging: no-drag;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    flex-shrink: 0;
  `;

  function setMuteIcon(muted) {
    muteBtn.textContent = "";
    muteBtn.appendChild(buildSpeakerSvg(muted));
  }

  setMuteIcon(false);

  muteBtn.addEventListener("click", () => {
    sendToSoundCloudTab("SCWidget:ToggleMute", "SCWidget:ToggleMuteReply", (data) => {
      updateFromInfo(data);
    });
  });

  // ---- Pasek postępu ----
  const progressOuter = document.createElement("div");
  progressOuter.id = "sc-widget-progress-outer";
  progressOuter.style.cssText = `
    width: 100%;
    height: 4px;
    background: ${COL_TRACK};
    border-radius: 2px;
    cursor: pointer;
    position: relative;
    -moz-window-dragging: no-drag;
  `;
  const progressFill = document.createElement("div");
  progressFill.id = "sc-widget-progress-fill";
  progressFill.style.cssText = `
    height: 100%;
    width: 0%;
    background: ${COL_TEXT};
    border-radius: 2px;
  `;
  progressOuter.appendChild(progressFill);

  // ---- Rząd: czas + mute ----
  const timeRow = document.createElement("div");
  timeRow.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  `;

  const timeEl = document.createElement("div");
  timeEl.id = "sc-widget-time";
  timeEl.style.cssText = `
    color: ${COL_TEXT_DIM};
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  `;
  timeEl.textContent = "0:00 / 0:00";

  timeRow.appendChild(timeEl);
  timeRow.appendChild(muteBtn);

  // ---- Rząd przycisków ----
  const controlsRow = document.createElement("div");
  controlsRow.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  `;

  const prevBtn = document.createElement("button");
  prevBtn.id = "sc-widget-prev";
  prevBtn.style.cssText = `
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: none;
    background-color: ${COL_SURFACE};
    cursor: pointer;
    -moz-window-dragging: no-drag;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  `;
  const prevIcon = document.createElement("span");
  prevIcon.style.cssText = `
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-right: 8px solid ${COL_TEXT};
    margin-right: 2px;
  `;
  prevBtn.appendChild(prevIcon);

  const playPauseBtn = document.createElement("button");
  playPauseBtn.id = "sc-widget-playpause";
  playPauseBtn.style.cssText = `
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: none;
    background-color: ${COL_TEXT};
    cursor: pointer;
    -moz-window-dragging: no-drag;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  `;
  const icon = document.createElement("span");
  icon.id = "sc-widget-icon";
  playPauseBtn.appendChild(icon);

  const nextBtn = document.createElement("button");
  nextBtn.id = "sc-widget-next";
  nextBtn.style.cssText = `
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: none;
    background-color: ${COL_SURFACE};
    cursor: pointer;
    -moz-window-dragging: no-drag;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  `;
  const nextIcon = document.createElement("span");
  nextIcon.style.cssText = `
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-left: 8px solid ${COL_TEXT};
    margin-left: 2px;
  `;
  nextBtn.appendChild(nextIcon);

  controlsRow.appendChild(prevBtn);
  controlsRow.appendChild(playPauseBtn);
  controlsRow.appendChild(nextBtn);

  widgetDiv.appendChild(artworkWrapper);
  widgetDiv.appendChild(titleEl);
  widgetDiv.appendChild(eqContainer);
  widgetDiv.appendChild(progressOuter);
  widgetDiv.appendChild(timeRow);
  widgetDiv.appendChild(controlsRow);
  container.appendChild(widgetDiv);
  console.log("[SC-WIDGET] Widget wstrzyknięty pomyślnie (ukryty do czasu znalezienia karty SC)!");

  function setIconPlay() {
    icon.style.cssText = `
      width: 0;
      height: 0;
      border-top: 8px solid transparent;
      border-bottom: 8px solid transparent;
      border-left: 13px solid ${COL_BG};
      margin-left: 3px;
    `;
  }

  function setIconPause() {
    icon.style.cssText = `
      width: 13px;
      height: 14px;
      background:
        linear-gradient(${COL_BG}, ${COL_BG}) 0 0 / 4px 14px no-repeat,
        linear-gradient(${COL_BG}, ${COL_BG}) 9px 0 / 4px 14px no-repeat;
    `;
  }

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  // Usuwa domyślny prefiks SoundClouda typu "Current track: ", "Now playing: " itp.
  function cleanTrackTitle(raw) {
    if (!raw) return raw;
    return raw.replace(/^(current track|now playing)\s*:\s*/i, "").trim();
  }

  let lastArtworkUrl = null;
  let widgetVisible = false;
  let isPlaying = false;
  let isMuted = false;

  function showWidget() {
    if (!widgetVisible) {
      widgetDiv.style.display = "flex";
      widgetVisible = true;
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
      setIconPause();
      isPlaying = true;
    } else if (data.playTitle === "Play current") {
      setIconPlay();
      isPlaying = false;
    }

    if (data.artworkUrl && data.artworkUrl !== lastArtworkUrl) {
      lastArtworkUrl = data.artworkUrl;
      artworkEl.style.backgroundImage = `url("${data.artworkUrl}")`;
    }

    if (data.trackTitle) {
      titleEl.textContent = cleanTrackTitle(data.trackTitle);
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
  }

  // ==================================================
  // Equalizer: wygładzone renderowanie 60fps
  // Dane wejściowe (targetBars/targetGlow) przychodzą z karty SC
  // przez SCWidget:AudioData (patrz FRAME_SCRIPT + onAudioData niżej).
  // Jeśli dane nie napływają (np. hook do Web Audio się nie udał),
  // a utwór gra - włącza się subtelna, syntetyczna animacja "oddechu",
  // żeby widget nigdy nie wyglądał na martwy.
  // ==================================================

  let targetBars = new Array(EQ_BAR_COUNT).fill(0);
  let displayBars = new Array(EQ_BAR_COUNT).fill(0);
  let targetGlow = 0;
  let displayGlow = 0;
  let lastAudioMsgTime = 0;

  function idleBarValue(i, now) {
    return 0.12 + 0.10 * Math.sin(now / 320 + i * 0.75) + 0.05 * Math.sin(now / 130 + i * 1.9);
  }

  function animateEq() {
    if (widgetVisible) {
      const now = Date.now();
      const hasRecentData = now - lastAudioMsgTime < 400;

      for (let i = 0; i < EQ_BAR_COUNT; i++) {
        let t;
        if (hasRecentData) {
          t = targetBars[i] || 0;
        } else if (isPlaying) {
          t = Math.max(0, idleBarValue(i, now));
        } else {
          t = 0;
        }
        displayBars[i] += (t - displayBars[i]) * 0.25;

        const px = 3 + displayBars[i] * 15;
        eqBarEls[i].style.height = px.toFixed(1) + "px";
        eqBarEls[i].style.opacity = isMuted ? "0.3" : (0.45 + displayBars[i] * 0.55).toFixed(2);
      }

      let glowTarget;
      if (hasRecentData) {
        glowTarget = targetGlow;
      } else if (isPlaying) {
        glowTarget = 0.12 + 0.05 * Math.sin(now / 500);
      } else {
        glowTarget = 0;
      }
      displayGlow += (glowTarget - displayGlow) * 0.15;

      artworkWrapper.style.boxShadow =
        "0 0 " + (8 + displayGlow * 26).toFixed(1) + "px rgba(205, 214, 244, " + (0.12 + displayGlow * 0.4).toFixed(2) + ")";
    }

    requestAnimationFrame(animateEq);
  }
  requestAnimationFrame(animateEq);

  // ==================================================
  // Frame script wstrzykiwany do procesu treści karty SC
  // ==================================================

  const FRAME_SCRIPT = `
    (function () {
      function dispatchClick(selector) {
        const btn = content.document.querySelector(selector);
        if (btn) {
          const ev = new content.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: content
          });
          btn.dispatchEvent(ev);
        }
        return !!btn;
      }

      function extractArtworkUrl(el) {
        if (!el) return null;
        const bg = el.style.backgroundImage;
        const match = /url\\(["']?(.*?)["']?\\)/.exec(bg || "");
        return match ? match[1] : null;
      }

      function getInfo() {
        const playBtn = content.document.querySelector(".playControls__play");
        const titleBadge = content.document.querySelector(".playbackSoundBadge__title");
        const progressWrapper = content.document.querySelector(".playbackTimeline__progressWrapper");
        const artworkEl = content.document.querySelector('.playbackSoundBadge .sc-artwork[style*="background-image"]');
        const volumeBtn = content.document.querySelector(".volume__button");

        // Preferuj czysty tekst z linku/tytułu (bez aria-label typu "Current track: X"),
        // sięgając po najbardziej wewnętrzny element tekstowy jeśli to możliwe.
        let rawTitle = null;
        if (titleBadge) {
          const innerLink = titleBadge.querySelector("a, span");
          rawTitle = innerLink ? innerLink.textContent.trim() : titleBadge.textContent.trim();
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

      addMessageListener("SCWidget:GetInfo", function (msg) {
        sendAsyncMessage("SCWidget:GetInfoReply", getInfo());
      });

      addMessageListener("SCWidget:TogglePlay", function (msg) {
        dispatchClick(".playControls__play");
        sendAsyncMessage("SCWidget:TogglePlayReply", getInfo());
      });

      addMessageListener("SCWidget:Next", function (msg) {
        const clicked = dispatchClick(".playControls__next");
        sendAsyncMessage("SCWidget:NextReply", { clicked: clicked });
      });

      addMessageListener("SCWidget:Prev", function (msg) {
        const clicked = dispatchClick(".playControls__prev");
        sendAsyncMessage("SCWidget:PrevReply", { clicked: clicked });
      });

      addMessageListener("SCWidget:ToggleMute", function (msg) {
        dispatchClick(".volume__button");
        sendAsyncMessage("SCWidget:ToggleMuteReply", getInfo());
      });

      addMessageListener("SCWidget:Seek", function (msg) {
        const wrapper = content.document.querySelector(".playbackTimeline__progressWrapper");
        if (wrapper) {
          const rect = wrapper.getBoundingClientRect();
          const targetX = rect.left + rect.width * msg.data.percent;
          const targetY = rect.top + rect.height / 2;
          const baseOpts = {
            bubbles: true,
            cancelable: true,
            view: content,
            clientX: targetX,
            clientY: targetY
          };

          // SoundCloud's timeline drag handling now relies on the Pointer
          // Events API rather than plain mouse events, so fire both to
          // stay compatible regardless of which one it listens for.
          const downOpts = Object.assign({}, baseOpts, {
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons: 1
          });
          const upOpts = Object.assign({}, baseOpts, {
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons: 0
          });

          wrapper.dispatchEvent(new content.PointerEvent("pointerdown", downOpts));
          wrapper.dispatchEvent(new content.MouseEvent("mousedown", baseOpts));
          wrapper.dispatchEvent(new content.PointerEvent("pointermove", upOpts));
          wrapper.dispatchEvent(new content.MouseEvent("mousemove", baseOpts));
          wrapper.dispatchEvent(new content.PointerEvent("pointerup", upOpts));
          wrapper.dispatchEvent(new content.MouseEvent("mouseup", baseOpts));
          wrapper.dispatchEvent(new content.MouseEvent("click", baseOpts));
        }
        sendAsyncMessage("SCWidget:SeekReply", getInfo());
      });

      // ---- Audio-reactive equalizer ----
      // Podpina AnalyserNode pod pierwszy znaleziony element <audio> na stronie
      // i co 50ms wysyła uśrednione dane częstotliwości do chrome (SCWidget:AudioData).
      // Musi być zgodne z EQ_BAR_COUNT w skrypcie chrome!
      var EQ_BAR_COUNT = 14;
      var audioCtx = null;
      var analyserNode = null;
      var freqData = null;
      var hookedAudioEl = null;

      function tryHookAudio() {
        var el = content.document.querySelector("audio");
        if (!el || el === hookedAudioEl || el.__scWidgetHooked) return;
        try {
          if (!audioCtx) {
            var AC = content.AudioContext || content.webkitAudioContext;
            audioCtx = new AC();
          }
          var source = audioCtx.createMediaElementSource(el);
          var an = audioCtx.createAnalyser();
          an.fftSize = 64;
          an.smoothingTimeConstant = 0.6;
          source.connect(an);
          an.connect(audioCtx.destination);
          analyserNode = an;
          freqData = new Uint8Array(an.frequencyBinCount);
          hookedAudioEl = el;
          el.__scWidgetHooked = true;
          console.log("[SC-WIDGET] Web Audio podpiete do <audio>.");
        } catch (e) {
          console.log("[SC-WIDGET] Nie udalo sie podpiac Web Audio: " + e);
        }
      }

      function sendAudioFrame() {
        if (!analyserNode) return;
        if (audioCtx.state === "suspended") {
          audioCtx.resume().catch(function () {});
        }
        analyserNode.getByteFrequencyData(freqData);
        var bars = new Array(EQ_BAR_COUNT);
        var bins = freqData.length;
        var sum = 0;
        for (var i = 0; i < EQ_BAR_COUNT; i++) {
          var start = Math.floor((i * bins) / EQ_BAR_COUNT);
          var end = Math.max(start + 1, Math.floor(((i + 1) * bins) / EQ_BAR_COUNT));
          var bucketSum = 0;
          for (var j = start; j < end; j++) bucketSum += freqData[j];
          var avg = bucketSum / (end - start) / 255;
          bars[i] = Math.pow(avg, 0.6);
          sum += avg;
        }
        sendAsyncMessage("SCWidget:AudioData", { bars: bars, level: sum / EQ_BAR_COUNT });
      }

      var eqTick = 0;
      content.setInterval(function () {
        eqTick++;
        if (!hookedAudioEl || hookedAudioEl !== content.document.querySelector("audio")) {
          if (!hookedAudioEl || eqTick % 20 === 0) tryHookAudio();
        }
        sendAudioFrame();
      }, 50);

      tryHookAudio();
    })();
  `;

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

  const scriptLoadedBrowsers = new WeakSet();

  function sendToSoundCloudTab(messageName, replyName, onReply, payload) {
    const tab = findSoundCloudTab();
    if (!tab) {
      hideWidget();
      return;
    }

    const browser = tab.linkedBrowser;
    const mm = browser.messageManager;

    if (!scriptLoadedBrowsers.has(browser)) {
      const dataURL = "data:application/javascript," + encodeURIComponent(FRAME_SCRIPT);
      mm.loadFrameScript(dataURL, false);
      scriptLoadedBrowsers.add(browser);

      // Stały nasłuch danych equalizera dla tej konkretnej karty.
      mm.addMessageListener("SCWidget:AudioData", (msg) => {
        const currentTab = findSoundCloudTab();
        if (!currentTab || currentTab.linkedBrowser !== browser) return;
        lastAudioMsgTime = Date.now();
        targetBars = msg.data.bars || new Array(EQ_BAR_COUNT).fill(0);
        targetGlow = typeof msg.data.level === "number" ? msg.data.level : 0;
      });
    }

    mm.addMessageListener(replyName, function onReplyWrapper(msg) {
      mm.removeMessageListener(replyName, onReplyWrapper);
      onReply(msg.data);
    });

    mm.sendAsyncMessage(messageName, payload);
  }

  function pollInfo() {
    if (!findSoundCloudTab()) {
      hideWidget();
      return;
    }
    sendToSoundCloudTab("SCWidget:GetInfo", "SCWidget:GetInfoReply", (data) => {
      updateFromInfo(data);
    });
  }

  function tryInitialPing() {
    if (findSoundCloudTab()) {
      pollInfo();
    } else {
      console.log("[SC-WIDGET] Karta SC jeszcze niedostępna, czekam na SSTabRestored / poll...");
    }
  }

  tryInitialPing();

  gBrowser.tabContainer.addEventListener("SSTabRestored", function onTabRestored(event) {
    const tab = event.target;
    try {
      const host = tab.linkedBrowser.currentURI.host;
      if (host && host.includes("soundcloud.com")) {
        console.log("[SC-WIDGET] Karta SC przywrócona, sprawdzam stan.");
        pollInfo();
      }
    } catch (e) {}
  });

  // Reaguj też na otwarcie/zamknięcie/przejście na kartę SC, nie tylko na przywracanie sesji
  gBrowser.tabContainer.addEventListener("TabClose", () => {
    setTimeout(pollInfo, 100);
  });

  setInterval(pollInfo, 1000);

  playPauseBtn.addEventListener("click", () => {
    sendToSoundCloudTab("SCWidget:TogglePlay", "SCWidget:TogglePlayReply", (data) => {
      updateFromInfo(data);
    });
  });

  nextBtn.addEventListener("click", () => {
    sendToSoundCloudTab("SCWidget:Next", "SCWidget:NextReply", () => {
      setTimeout(pollInfo, 300);
    });
  });

  prevBtn.addEventListener("click", () => {
    sendToSoundCloudTab("SCWidget:Prev", "SCWidget:PrevReply", () => {
      setTimeout(pollInfo, 300);
    });
  });

  progressOuter.addEventListener("click", (e) => {
    const rect = progressOuter.getBoundingClientRect();
    const percent = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    sendToSoundCloudTab("SCWidget:Seek", "SCWidget:SeekReply", (data) => {
      updateFromInfo(data);
    }, { percent: percent });
  });
});