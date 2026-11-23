import { useEffect, useRef, useState } from "react";
import { PhoneIcon, PowerIcon, RefreshIcon } from "../icons";
import type {
  PhonePaneState,
  StreamMode,
  SwipeTrail,
  TapRipple,
} from "../types";

interface PhoneStageProps {
  pane: PhonePaneState | null;
  loadingInitial: boolean;
  connectionStatus: "connecting" | "connected" | "standalone" | "cancelled" | "error";
  connectionMessage?: string;
  streamMode: StreamMode;
  streamNonce: number;
  pollFrameSrc: string | null;
  booting: boolean;
  onAutoFallback: (reason: string) => void;
  onStreamHealthy: () => void;
  onTap: (x: number, y: number) => void;
  onSwipe: (x1: number, y1: number, x2: number, y2: number, duration: number) => void;
  onBootPhone: () => void;
  onRefreshDevices: () => void;
}

const TAP_THRESHOLD_PX = 8;
const FIRST_FRAME_TIMEOUT_MS = 3500;
const WHEEL_DEBOUNCE_MS = 110;

function appendCacheBust(url: string, nonce: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${nonce}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function PhoneStage({
  pane,
  loadingInitial,
  connectionStatus,
  connectionMessage,
  streamMode,
  streamNonce,
  pollFrameSrc,
  booting,
  onAutoFallback,
  onStreamHealthy,
  onTap,
  onSwipe,
  onBootPhone,
  onRefreshDevices,
}: PhoneStageProps) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [streamLoaded, setStreamLoaded] = useState(false);
  const [ripples, setRipples] = useState<TapRipple[]>([]);
  const [swipeTrail, setSwipeTrail] = useState<SwipeTrail | null>(null);

  const nextFxId = useRef(1);
  const fallbackTriggeredRef = useRef(false);

  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startTime: number;
    startPctX: number;
    startPctY: number;
    startIosX: number;
    startIosY: number;
    moved: boolean;
  } | null>(null);

  const wheelStateRef = useRef<{
    deltaX: number;
    deltaY: number;
    anchorIosX: number;
    anchorIosY: number;
    timer: number | null;
  }>({
    deltaX: 0,
    deltaY: 0,
    anchorIosX: 0,
    anchorIosY: 0,
    timer: null,
  });

  const deviceWidth = pane && pane.width > 0 ? pane.width : 402;
  const deviceHeight = pane && pane.height > 0 ? pane.height : 874;
  const aspectRatio = deviceWidth / deviceHeight;
  const isBooted = Boolean(pane && pane.state === "Booted");
  const hasPhones = Boolean(pane && pane.phones && pane.phones.length > 0);
  const showStreamImg = Boolean(isBooted && streamMode === "stream" && pane?.streamUrl);
  const streamSrc = showStreamImg && pane?.streamUrl
    ? appendCacheBust(pane.streamUrl, streamNonce)
    : null;

  // Reset stream-loaded gate whenever stream URL or reconnect nonce changes.
  useEffect(() => {
    setStreamLoaded(false);
    fallbackTriggeredRef.current = false;
  }, [streamSrc, streamMode, pane?.phone]);

  // Ensure MJPEG HTTP connection is actively aborted when unmounting or switching modes.
  useEffect(() => {
    const img = imgRef.current;
    return () => {
      if (img && showStreamImg) {
        img.src = "";
      }
    };
  }, [showStreamImg, streamSrc]);

  // 3.5-second first-frame watchdog for Plan A -> Plan B automatic fallback.
  useEffect(() => {
    if (!showStreamImg || streamLoaded) return;
    const timer = window.setTimeout(() => {
      const el = imgRef.current;
      if (el && el.complete && el.naturalWidth > 0) {
        setStreamLoaded(true);
        onStreamHealthy();
        return;
      }
      if (!fallbackTriggeredRef.current) {
        fallbackTriggeredRef.current = true;
        onAutoFallback("3.5 秒內未收到串流畫面，已自動切換為抓幀模式");
      }
    }, FIRST_FRAME_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [showStreamImg, streamLoaded, streamSrc, onAutoFallback, onStreamHealthy]);

  const mapClientToPhone = (clientX: number, clientY: number) => {
    const targetEl = imgRef.current ?? screenRef.current;
    if (!targetEl) return null;
    const rect = targetEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const normX = clamp((clientX - rect.left) / rect.width, 0, 1);
    const normY = clamp((clientY - rect.top) / rect.height, 0, 1);

    return {
      iosX: clamp(Math.round(normX * deviceWidth), 0, deviceWidth),
      iosY: clamp(Math.round(normY * deviceHeight), 0, deviceHeight),
      pctX: normX * 100,
      pctY: normY * 100,
    };
  };

  // Non-passive wheel handler -> debounced vertical/horizontal swipe on the simulator.
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen || !isBooted) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const mapped = mapClientToPhone(e.clientX, e.clientY);
      const ws = wheelStateRef.current;
      ws.deltaX += e.deltaX;
      ws.deltaY += e.deltaY;
      if (mapped) {
        ws.anchorIosX = clamp(mapped.iosX, Math.round(deviceWidth * 0.15), Math.round(deviceWidth * 0.85));
        ws.anchorIosY = clamp(mapped.iosY, Math.round(deviceHeight * 0.2), Math.round(deviceHeight * 0.8));
      } else {
        ws.anchorIosX = Math.round(deviceWidth * 0.5);
        ws.anchorIosY = Math.round(deviceHeight * 0.5);
      }

      if (ws.timer !== null) {
        window.clearTimeout(ws.timer);
      }
      ws.timer = window.setTimeout(() => {
        const dx = ws.deltaX;
        const dy = ws.deltaY;
        const cx = ws.anchorIosX || Math.round(deviceWidth * 0.5);
        const cy = ws.anchorIosY || Math.round(deviceHeight * 0.5);
        ws.deltaX = 0;
        ws.deltaY = 0;
        ws.timer = null;

        if (Math.abs(dy) >= Math.abs(dx)) {
          if (Math.abs(dy) < 4) return;
          // Scrolling down (dy > 0) drags finger upward (y2 < y1).
          const travel = clamp(Math.abs(dy) * 1.15, 95, deviceHeight * 0.52);
          const half = travel / 2;
          const safeTop = Math.round(deviceHeight * 0.14);
          const safeBottom = Math.round(deviceHeight * 0.86);
          const midY = clamp(cy, safeTop + half, safeBottom - half);
          const y1 = Math.round(dy > 0 ? midY + half : midY - half);
          const y2 = Math.round(dy > 0 ? midY - half : midY + half);
          onSwipe(cx, y1, cx, y2, 0.22);
        } else {
          if (Math.abs(dx) < 4) return;
          const travel = clamp(Math.abs(dx) * 1.15, 80, deviceWidth * 0.65);
          const half = travel / 2;
          const safeLeft = Math.round(deviceWidth * 0.12);
          const safeRight = Math.round(deviceWidth * 0.88);
          const midX = clamp(cx, safeLeft + half, safeRight - half);
          const x1 = Math.round(dx > 0 ? midX + half : midX - half);
          const x2 = Math.round(dx > 0 ? midX - half : midX + half);
          onSwipe(x1, cy, x2, cy, 0.22);
        }
      }, WHEEL_DEBOUNCE_MS);
    };

    screen.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      screen.removeEventListener("wheel", handleWheel);
      if (wheelStateRef.current.timer !== null) {
        window.clearTimeout(wheelStateRef.current.timer);
        wheelStateRef.current.timer = null;
      }
    };
  }, [isBooted, deviceWidth, deviceHeight, onSwipe]);

  const spawnRipple = (pctX: number, pctY: number) => {
    const id = nextFxId.current++;
    setRipples((prev) => [...prev.slice(-4), { id, pctX, pctY }]);
    // Always clean up via timer so reduced-motion mode never leaves stale ripples.
    window.setTimeout(() => {
      setRipples((prev) => prev.filter((item) => item.id !== id));
    }, 460);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isBooted) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const mapped = mapClientToPhone(e.clientX, e.clientY);
    if (!mapped) return;

    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture is unsupported
    }

    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTime: performance.now(),
      startPctX: mapped.pctX,
      startPctY: mapped.pctY,
      startIosX: mapped.iosX,
      startIosY: mapped.iosY,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const dist = Math.hypot(
      e.clientX - drag.startClientX,
      e.clientY - drag.startClientY,
    );
    if (dist >= TAP_THRESHOLD_PX) {
      drag.moved = true;
      const mapped = mapClientToPhone(e.clientX, e.clientY);
      if (mapped) {
        setSwipeTrail({
          id: nextFxId.current,
          x1Pct: drag.startPctX,
          y1Pct: drag.startPctY,
          x2Pct: mapped.pctX,
          y2Pct: mapped.pctY,
          active: true,
        });
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }

    const mapped = mapClientToPhone(e.clientX, e.clientY);
    const dist = Math.hypot(
      e.clientX - drag.startClientX,
      e.clientY - drag.startClientY,
    );

    if (dist < TAP_THRESHOLD_PX || !mapped) {
      setSwipeTrail(null);
      spawnRipple(drag.startPctX, drag.startPctY);
      onTap(drag.startIosX, drag.startIosY);
      return;
    }

    const rawSeconds = (performance.now() - drag.startTime) / 1000;
    const duration = Number(clamp(rawSeconds, 0.15, 1.2).toFixed(2));
    const trailId = nextFxId.current++;

    setSwipeTrail({
      id: trailId,
      x1Pct: drag.startPctX,
      y1Pct: drag.startPctY,
      x2Pct: mapped.pctX,
      y2Pct: mapped.pctY,
      active: false,
    });
    window.setTimeout(() => {
      setSwipeTrail((prev) => (prev && prev.id === trailId ? null : prev));
    }, 360);

    onSwipe(drag.startIosX, drag.startIosY, mapped.iosX, mapped.iosY, duration);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setSwipeTrail(null);
  };

  const activePhoneSummary = pane?.phones?.find((p) => p.name === pane.phone);

  const renderScreenContent = () => {
    if (loadingInitial || connectionStatus === "connecting") {
      return (
        <div className="screen-placeholder">
          <span className="spinner-ring" aria-hidden="true" />
          <p className="placeholder-title">正在連線至 iPhone 模擬器…</p>
          <p className="placeholder-sub">等待 Antigravity 傳送裝置資訊</p>
        </div>
      );
    }

    if (connectionStatus === "standalone") {
      return (
        <div className="screen-placeholder">
          <PhoneIcon width={30} height={30} className="placeholder-icon" />
          <p className="placeholder-title">iPhone 互動預覽面板</p>
          <p className="placeholder-sub">請在 Antigravity 側邊面板或主頁檢視中開啟此 MCP App</p>
        </div>
      );
    }

    if (connectionStatus === "cancelled" || connectionStatus === "error") {
      return (
        <div className="screen-placeholder">
          <PhoneIcon width={30} height={30} className="placeholder-icon" />
          <p className="placeholder-title">
            {connectionStatus === "cancelled" ? "初始化已取消" : "無法取得裝置資訊"}
          </p>
          {connectionMessage && <p className="placeholder-sub">{connectionMessage}</p>}
          <button type="button" className="boot-cta" onClick={onRefreshDevices}>
            <RefreshIcon width={15} height={15} />
            <span>重新載入裝置</span>
          </button>
        </div>
      );
    }

    if (!pane || (!pane.phone && !hasPhones)) {
      return (
        <div className="screen-placeholder">
          <PhoneIcon width={30} height={30} className="placeholder-icon" />
          <p className="placeholder-title">找不到模擬器裝置</p>
          <p className="placeholder-sub">
            {pane?.error || "請先使用 terminal-phone 建立或註冊 iOS 模擬器。"}
          </p>
          <button type="button" className="boot-cta" onClick={onRefreshDevices}>
            <RefreshIcon width={15} height={15} />
            <span>重新整理裝置</span>
          </button>
        </div>
      );
    }

    if (!isBooted) {
      return (
        <div className="screen-placeholder screen-sleeping">
          <div className="sleep-status-pill">
            <span className="sleep-dot" aria-hidden="true" />
            <span>{booting ? "啟動中…" : pane.state || "已關機"}</span>
          </div>
          <PhoneIcon width={34} height={34} className="placeholder-icon" />
          <p className="placeholder-title">{pane.phone}</p>
          {(activePhoneSummary?.deviceType || activePhoneSummary?.runtime) && (
            <p className="placeholder-sub">
              {[activePhoneSummary.deviceType, activePhoneSummary.runtime]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          <button
            type="button"
            className="boot-cta"
            disabled={booting}
            onClick={onBootPhone}
          >
            {booting ? (
              <span className="spinner-ring spinner-sm" aria-hidden="true" />
            ) : (
              <PowerIcon width={16} height={16} />
            )}
            <span>{booting ? "正在啟動模擬器…" : "啟動模擬器"}</span>
          </button>
        </div>
      );
    }

    if (showStreamImg && streamSrc) {
      return (
        <>
          <img
            ref={imgRef}
            key={streamSrc}
            src={streamSrc}
            alt={`${pane.phone} 即時預覽畫面`}
            className={`phone-video-img ${streamLoaded ? "is-loaded" : ""}`}
            draggable={false}
            onLoad={(e) => {
              if (e.currentTarget.naturalWidth > 0) {
                setStreamLoaded(true);
                onStreamHealthy();
              }
            }}
            onError={() => {
              if (!fallbackTriggeredRef.current) {
                fallbackTriggeredRef.current = true;
                onAutoFallback("MJPEG 串流連線失敗，已自動降級為抓幀模式");
              }
            }}
          />
          {!streamLoaded && (
            <div className="screen-loading-overlay">
              <span className="spinner-ring" aria-hidden="true" />
              <p className="placeholder-sub">正在連接 30fps 串流…</p>
            </div>
          )}
        </>
      );
    }

    return (
      <>
        {pollFrameSrc ? (
          <img
            ref={imgRef}
            src={pollFrameSrc}
            alt={`${pane.phone} 抓幀預覽畫面`}
            className="phone-video-img is-loaded"
            draggable={false}
          />
        ) : (
          <div className="screen-loading-overlay">
            <span className="spinner-ring" aria-hidden="true" />
            <p className="placeholder-sub">正在擷取模擬器畫面…</p>
          </div>
        )}
      </>
    );
  };

  return (
    <main
      id="phone-screen-stage"
      className="stage-viewport"
      aria-label="iPhone 模擬器預覽畫布"
    >
      <div
        className={`phone-bezel ${isBooted ? "is-awake" : "is-sleeping"}`}
        style={{ "--phone-aspect": String(aspectRatio) } as React.CSSProperties}
      >
        {/* Subtle physical side buttons etched into the titanium frame */}
        <span className="bezel-btn bezel-btn-silent" aria-hidden="true" />
        <span className="bezel-btn bezel-btn-vol-up" aria-hidden="true" />
        <span className="bezel-btn bezel-btn-vol-down" aria-hidden="true" />
        <span className="bezel-btn bezel-btn-power" aria-hidden="true" />

        <div
          ref={screenRef}
          className={`phone-screen ${isBooted ? "is-interactive" : ""}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          role={isBooted ? "application" : undefined}
          aria-label={
            isBooted
              ? `${pane?.phone ?? "iPhone"} 觸控螢幕（可點擊、拖曳滑動、滾輪捲動）`
              : undefined
          }
        >
          {renderScreenContent()}

          {/* Touch ripple rings */}
          {ripples.map((r) => (
            <span
              key={r.id}
              className="touch-ripple"
              style={{
                left: `${r.pctX}%`,
                top: `${r.pctY}%`,
              }}
              aria-hidden="true"
            />
          ))}

          {/* Swipe trajectory indicator */}
          {swipeTrail && (
            <svg
              className={`swipe-trail-svg ${swipeTrail.active ? "is-active" : "is-fading"}`}
              viewBox={`0 0 ${deviceWidth} ${deviceHeight}`}
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <line
                x1={(swipeTrail.x1Pct / 100) * deviceWidth}
                y1={(swipeTrail.y1Pct / 100) * deviceHeight}
                x2={(swipeTrail.x2Pct / 100) * deviceWidth}
                y2={(swipeTrail.y2Pct / 100) * deviceHeight}
                className="swipe-trail-line"
                strokeWidth="4"
                strokeLinecap="round"
              />
              <circle
                cx={(swipeTrail.x1Pct / 100) * deviceWidth}
                cy={(swipeTrail.y1Pct / 100) * deviceHeight}
                r="6"
                className="swipe-trail-start"
              />
              <circle
                cx={(swipeTrail.x2Pct / 100) * deviceWidth}
                cy={(swipeTrail.y2Pct / 100) * deviceHeight}
                r="10"
                className="swipe-trail-end"
              />
            </svg>
          )}
        </div>
      </div>
    </main>
  );
}
