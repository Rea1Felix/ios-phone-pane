import { useCallback, useEffect, useRef, useState } from "react";
import { ActionToolbar } from "./components/ActionToolbar";
import { KeyboardBar } from "./components/KeyboardBar";
import { PhoneStage } from "./components/PhoneStage";
import { ToastRegion } from "./components/ToastRegion";
import { PollIcon, PowerIcon, RefreshIcon, StreamIcon } from "./icons";
import {
  applyHostContextToDocument,
  parseStructuredPayload,
  PhoneMcpBridge,
} from "./mcpClient";
import type {
  FallbackReason,
  HostCapabilitiesSummary,
  PhoneKey,
  PhonePaneState,
  StreamMode,
  ToastItem,
} from "./types";

const WIDE_CONTAINER_BREAKPOINT = 660;
const POLL_BASE_INTERVAL_MS = 220;

let sharedBridge: PhoneMcpBridge | null = null;
function getSharedBridge(): PhoneMcpBridge {
  if (!sharedBridge) {
    sharedBridge = new PhoneMcpBridge();
  }
  return sharedBridge;
}

function announceToScreenReaders(
  message: string,
  setLive: (msg: string) => void,
): void {
  const doc = document as Document & {
    ariaNotify?: (text: string, options?: { priority?: "normal" | "high" }) => void;
  };
  if (typeof doc.ariaNotify === "function") {
    try {
      doc.ariaNotify(message);
    } catch {
      // fall through to live region
    }
  }
  // Also update pre-mounted live region fallback for browsers without ariaNotify().
  setLive("");
  window.requestAnimationFrame(() => {
    setLive(message);
  });
}

export function App() {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const bridgeRef = useRef<PhoneMcpBridge>(getSharedBridge());

  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "standalone" | "cancelled" | "error"
  >("connecting");
  const [connectionMessage, setConnectionMessage] = useState<string | undefined>();
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [capabilities, setCapabilities] = useState<HostCapabilitiesSummary>({
    canUpdateModelContext: false,
    canSendMessage: false,
  });

  const [pane, setPane] = useState<PhonePaneState | null>(null);
  const [streamMode, setStreamMode] = useState<StreamMode>("stream");
  const [fallbackReason, setFallbackReason] = useState<FallbackReason>("none");
  const [streamNonce, setStreamNonce] = useState(1);
  const [pollFrameSrc, setPollFrameSrc] = useState<string | null>(null);

  const [isWideContainer, setIsWideContainer] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [simDarkMode, setSimDarkMode] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const nextToastIdRef = useRef(1);

  const receivedToolResultRef = useRef(false);
  const activePhoneRef = useRef<string>("");
  const pollBurstRef = useRef(0);
  const wakePollRef = useRef<(() => void) | null>(null);

  const pushToast = useCallback(
    (message: string, tone: ToastItem["tone"] = "info") => {
      const id = nextToastIdRef.current++;
      setToasts((prev) => [...prev.slice(-1), { id, message, tone }]);
      announceToScreenReaders(message, setLiveAnnouncement);
    },
    [],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const triggerPollBurst = useCallback(() => {
    pollBurstRef.current = 4;
    wakePollRef.current?.();
  }, []);

  const applyPaneState = useCallback(
    (next: PhonePaneState, options?: { preserveManualPoll?: boolean }) => {
      const prevPhone = activePhoneRef.current;
      activePhoneRef.current = next.phone ?? "";
      setPane(next);
      setLoadingInitial(false);

      const phoneChanged = Boolean(prevPhone && next.phone && prevPhone !== next.phone);
      if (phoneChanged) {
        setPollFrameSrc(null);
      }

      if (next.state === "Booted") {
        if (next.streamUrl) {
          if (!options?.preserveManualPoll || phoneChanged) {
            setStreamMode("stream");
            setFallbackReason("none");
            setStreamNonce((n) => n + 1);
          }
        } else {
          setStreamMode("poll");
          setFallbackReason("no-stream");
        }
      }
    },
    [],
  );

  // Sync toolbar ARIA orientation with our CSS @container breakpoint.
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      setIsWideContainer(el.clientWidth >= WIDE_CONTAINER_BREAKPOINT);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Connect to Antigravity host using the official @modelcontextprotocol/ext-apps SDK.
  useEffect(() => {
    let disposed = false;
    let bootstrapTimer: number | null = null;
    const bridge = bridgeRef.current;
    const app = bridge.app;

    // Register ALL lifecycle handlers BEFORE calling app.connect().
    app.ontoolinput = () => {
      if (disposed) return;
      if (!receivedToolResultRef.current) {
        setLoadingInitial(true);
      }
    };

    app.ontoolresult = (result) => {
      if (disposed) return;
      receivedToolResultRef.current = true;
      if (bootstrapTimer !== null) {
        window.clearTimeout(bootstrapTimer);
        bootstrapTimer = null;
      }
      const parsed = parseStructuredPayload<PhonePaneState>(
        result as Parameters<typeof parseStructuredPayload>[0],
      );
      if (parsed) {
        applyPaneState(parsed);
        if (parsed.ok === false && parsed.error) {
          pushToast(parsed.error, "danger");
        }
      } else {
        setLoadingInitial(false);
        setConnectionStatus("error");
        setConnectionMessage("伺服器未回傳有效的模擬器資訊");
      }
    };

    app.ontoolcancelled = (params) => {
      if (disposed) return;
      setLoadingInitial(false);
      if (!receivedToolResultRef.current) {
        setConnectionStatus("cancelled");
        setConnectionMessage(params?.reason || "工具執行已被取消");
      } else {
        pushToast("先前的操作已被取消", "warning");
      }
    };

    app.onhostcontextchanged = (ctx) => {
      if (disposed) return;
      applyHostContextToDocument(ctx);
      if (ctx?.theme) {
        setSimDarkMode((prev) => prev); // preserve simulator preference independently
      }
    };

    const connectToHost = async () => {
      if (window.parent === window) {
        setConnectionStatus("standalone");
        setLoadingInitial(false);
        return;
      }

      try {
        if (!bridge.isConnected()) {
          await app.connect();
          bridge.markConnected();
        }
        if (disposed) return;

        const ctx = app.getHostContext();
        applyHostContextToDocument(ctx);
        if (ctx?.theme === "dark") {
          setSimDarkMode(true);
        }

        setCapabilities(bridge.getCapabilitiesSummary());
        setConnectionStatus("connected");

        // Fallback bootstrap if host didn't deliver an initial ontoolresult within 2.6s.
        bootstrapTimer = window.setTimeout(async () => {
          if (disposed || receivedToolResultRef.current) return;
          if (!app.getHostCapabilities()?.serverTools) {
            setLoadingInitial(false);
            return;
          }
          try {
            const list = await bridge.listPhones();
            if (disposed || receivedToolResultRef.current) return;
            const target =
              list.activePhone ||
              list.phones?.find((p) => p.state === "Booted")?.name ||
              list.phones?.[0]?.name;
            if (target) {
              const selected = await bridge.selectPhone(target);
              if (!disposed && !receivedToolResultRef.current) {
                receivedToolResultRef.current = true;
                applyPaneState(selected);
              }
            } else {
              setPane({
                ok: true,
                phone: "",
                udid: "",
                state: "Shutdown",
                width: 402,
                height: 874,
                scale: 3,
                phones: list.phones ?? [],
              });
              setLoadingInitial(false);
            }
          } catch (err) {
            if (!disposed && !receivedToolResultRef.current) {
              setLoadingInitial(false);
              setConnectionStatus("error");
              setConnectionMessage(
                err instanceof Error ? err.message : "載入裝置列表失敗",
              );
            }
          }
        }, 2600);
      } catch (err) {
        if (disposed) return;
        setLoadingInitial(false);
        setConnectionStatus("error");
        setConnectionMessage(
          err instanceof Error ? err.message : "無法建立 MCP App 主機連線",
        );
      }
    };

    void connectToHost();

    return () => {
      disposed = true;
      if (bootstrapTimer !== null) {
        window.clearTimeout(bootstrapTimer);
      }
    };
  }, [applyPaneState, pushToast]);

  // Plan B strictly serialized polling loop (`app_frame`), never overlapping requests.
  useEffect(() => {
    if (
      connectionStatus !== "connected" ||
      !pane ||
      pane.state !== "Booted" ||
      !pane.phone ||
      streamMode !== "poll"
    ) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    let consecutiveErrors = 0;
    let wakePending: (() => void) | null = null;
    const bridge = bridgeRef.current;
    const targetPhone = pane.phone;

    const sleepInterruptible = (ms: number) =>
      new Promise<void>((resolve) => {
        if (cancelled) {
          resolve();
          return;
        }
        const finish = () => {
          if (timerId !== null) {
            window.clearTimeout(timerId);
            timerId = null;
          }
          wakePending = null;
          resolve();
        };
        wakePending = finish;
        timerId = window.setTimeout(finish, ms);
      });

    wakePollRef.current = () => {
      wakePending?.();
    };

    const handleVisibility = () => {
      if (!document.hidden) {
        wakePending?.();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    const loop = async () => {
      while (!cancelled) {
        if (document.hidden) {
          await sleepInterruptible(1000);
          continue;
        }

        try {
          const frame = await bridge.fetchFrame({
            phone: targetPhone,
            maxWidth: 480,
            quality: 72,
          });
          if (cancelled) break;

          if (frame && frame.ok && frame.base64) {
            consecutiveErrors = 0;
            const mime = frame.mimeType || "image/jpeg";
            setPollFrameSrc(`data:${mime};base64,${frame.base64}`);
          } else if (frame && frame.ok === false) {
            consecutiveErrors += 1;
          }
        } catch {
          consecutiveErrors += 1;
        }

        if (cancelled) break;

        let delay = POLL_BASE_INTERVAL_MS;
        if (consecutiveErrors > 0) {
          delay = Math.min(2000, 450 * Math.pow(1.6, Math.min(consecutiveErrors - 1, 4)));
        } else if (pollBurstRef.current > 0) {
          const step = pollBurstRef.current;
          pollBurstRef.current -= 1;
          delay = step >= 4 ? 70 : step === 3 ? 110 : 150;
        }

        await sleepInterruptible(delay);
      }
    };

    void loop();

    return () => {
      cancelled = true;
      wakePollRef.current = null;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [connectionStatus, pane?.phone, pane?.state, streamMode]);

  const handleAutoFallback = useCallback(
    (reason: string) => {
      setStreamMode((current) => {
        if (current === "poll") return current;
        setFallbackReason("auto");
        pushToast(reason, "warning");
        return "poll";
      });
    },
    [pushToast],
  );

  const handleStreamHealthy = useCallback(() => {
    setFallbackReason("none");
  }, []);

  const handleToggleStreamMode = () => {
    if (!pane || pane.state !== "Booted") return;
    if (streamMode === "stream") {
      setStreamMode("poll");
      setFallbackReason("manual");
      pushToast("已切換為抓幀模式", "info");
    } else if (pane.streamUrl) {
      setStreamMode("stream");
      setFallbackReason("none");
      setStreamNonce((n) => n + 1);
      pushToast("正在重新連接 30fps 串流…", "info");
    } else {
      void handleRefreshDevices();
    }
  };

  const handleRefreshDevices = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge.isConnected()) return;
    setRefreshing(true);
    try {
      const list = await bridge.listPhones();
      const desired =
        pane?.phone ||
        list.activePhone ||
        list.phones?.find((p) => p.state === "Booted")?.name ||
        list.phones?.[0]?.name;

      if (desired) {
        const updated = await bridge.selectPhone(desired);
        setConnectionStatus("connected");
        applyPaneState(
          {
            ...updated,
            phones: updated.phones?.length ? updated.phones : list.phones ?? [],
          },
          { preserveManualPoll: streamMode === "poll" && fallbackReason === "manual" },
        );
        if (streamMode === "stream") {
          setStreamNonce((n) => n + 1);
        } else {
          triggerPollBurst();
        }
        pushToast("已更新裝置狀態與畫面", "info");
      } else {
        setPane({
          ok: true,
          phone: "",
          udid: "",
          state: "Shutdown",
          width: 402,
          height: 874,
          scale: 3,
          phones: list.phones ?? [],
        });
        setConnectionStatus("connected");
      }
    } catch (err) {
      pushToast(
        err instanceof Error ? `重新整理失敗：${err.message}` : "重新整理失敗",
        "danger",
      );
    } finally {
      setRefreshing(false);
    }
  }, [pane?.phone, streamMode, fallbackReason, applyPaneState, pushToast, triggerPollBurst]);

  const handleSelectPhone = async (nextPhone: string) => {
    if (!nextPhone || nextPhone === pane?.phone) return;
    const bridge = bridgeRef.current;
    setBusyAction("select");
    try {
      const updated = await bridge.selectPhone(nextPhone);
      applyPaneState(updated);
      pushToast(`已切換至 ${updated.phone}`, "info");
    } catch (err) {
      pushToast(
        err instanceof Error ? `切換裝置失敗：${err.message}` : "切換裝置失敗",
        "danger",
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleBootOrStop = async () => {
    if (!pane?.phone) return;
    const bridge = bridgeRef.current;
    const isCurrentlyBooted = pane.state === "Booted";

    if (isCurrentlyBooted) {
      setBusyAction("stop");
      try {
        const res = await bridge.deviceAction(pane.phone, "stop");
        if (!res.ok) {
          throw new Error(res.error || res.message || "停止模擬器失敗");
        }
        setPollFrameSrc(null);
        const refreshed = await bridge.selectPhone(pane.phone);
        applyPaneState(refreshed);
        pushToast(`已停止 ${pane.phone}`, "info");
      } catch (err) {
        pushToast(
          err instanceof Error ? err.message : "停止模擬器失敗",
          "danger",
        );
      } finally {
        setBusyAction(null);
      }
      return;
    }

    setBooting(true);
    setBusyAction("boot");
    try {
      const updated = await bridge.selectPhone(pane.phone, true);
      if (updated.ok === false) {
        throw new Error(updated.error || updated.message || "啟動模擬器失敗");
      }
      applyPaneState(updated);
      pushToast(`${updated.phone} 已啟動`, "success");
    } catch (err) {
      pushToast(
        err instanceof Error ? `啟動失敗：${err.message}` : "啟動模擬器失敗",
        "danger",
      );
    } finally {
      setBooting(false);
      setBusyAction(null);
    }
  };

  const handleTap = useCallback(
    (x: number, y: number) => {
      const phone = activePhoneRef.current;
      if (!phone) return;
      void bridgeRef.current
        .tap(phone, x, y)
        .then((res) => {
          if (res && res.ok === false && res.error) {
            pushToast(`點擊失敗：${res.error}`, "danger");
          } else {
            triggerPollBurst();
          }
        })
        .catch((err) => {
          pushToast(
            err instanceof Error ? `點擊失敗：${err.message}` : "點擊失敗",
            "danger",
          );
        });
    },
    [pushToast, triggerPollBurst],
  );

  const handleSwipe = useCallback(
    (x1: number, y1: number, x2: number, y2: number, duration: number) => {
      const phone = activePhoneRef.current;
      if (!phone) return;
      void bridgeRef.current
        .swipe(phone, x1, y1, x2, y2, duration)
        .then((res) => {
          if (res && res.ok === false && res.error) {
            pushToast(`滑動失敗：${res.error}`, "danger");
          } else {
            triggerPollBurst();
          }
        })
        .catch((err) => {
          pushToast(
            err instanceof Error ? `滑動失敗：${err.message}` : "滑動失敗",
            "danger",
          );
        });
    },
    [pushToast, triggerPollBurst],
  );

  const handleTypeText = async (text: string) => {
    if (!pane?.phone) return;
    setBusyAction("type");
    try {
      const res = await bridgeRef.current.typeText(pane.phone, text);
      if (!res.ok) {
        throw new Error(res.error || res.message || "輸入文字失敗");
      }
      triggerPollBurst();
      announceToScreenReaders("已傳送文字到 iPhone", setLiveAnnouncement);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "輸入文字失敗", "danger");
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendKey = async (key: PhoneKey) => {
    if (!pane?.phone) return;
    setBusyAction("key");
    try {
      const res = await bridgeRef.current.sendKey(pane.phone, key);
      if (!res.ok) {
        throw new Error(res.error || res.message || "送出按鍵失敗");
      }
      triggerPollBurst();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "送出按鍵失敗", "danger");
    } finally {
      setBusyAction(null);
    }
  };

  const handlePressHome = async () => {
    if (!pane?.phone) return;
    setBusyAction("home");
    try {
      const res = await bridgeRef.current.pressButton(pane.phone, "HOME");
      if (!res.ok) {
        throw new Error(res.error || res.message || "主畫面鍵執行失敗");
      }
      triggerPollBurst();
      announceToScreenReaders("已按下主畫面鍵", setLiveAnnouncement);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "主畫面鍵執行失敗", "danger");
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleSimTheme = async () => {
    if (!pane?.phone) return;
    const nextDark = !simDarkMode;
    setBusyAction("theme");
    try {
      const res = await bridgeRef.current.deviceAction(
        pane.phone,
        nextDark ? "dark" : "light",
      );
      if (!res.ok) {
        throw new Error(res.error || res.message || "切換外觀失敗");
      }
      setSimDarkMode(nextDark);
      triggerPollBurst();
      pushToast(
        nextDark ? "已切換模擬器為深色外觀" : "已切換模擬器為淺色外觀",
        "info",
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "切換外觀失敗", "danger");
    } finally {
      setBusyAction(null);
    }
  };

  const handleReleaseSession = async () => {
    if (!pane?.phone) return;
    setBusyAction("release");
    try {
      const res = await bridgeRef.current.deviceAction(
        pane.phone,
        "release_session",
      );
      if (!res.ok) {
        throw new Error(res.error || res.message || "釋放控制權失敗");
      }
      setPane((prev) => (prev ? { ...prev, sessionControlsInput: false } : prev));
      pushToast(res.message || "已釋放模擬器輸入控制權", "success");
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : "釋放控制權失敗",
        "danger",
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleAttachScreenToAgent = async () => {
    if (!pane?.phone) return;
    setBusyAction("attach");
    try {
      const shot = await bridgeRef.current.deviceAction(
        pane.phone,
        "save_screenshot",
      );
      if (!shot.ok) {
        throw new Error(shot.error || shot.message || "擷取模擬器截圖失敗");
      }
      await bridgeRef.current.attachScreenshotContext({
        phone: pane.phone,
        screenshotPath: shot.screenshotPath,
        screenshotUri: shot.screenshotUri,
      });
      pushToast("已將目前 iPhone 畫面附帶給 Agent", "success");
    } catch (err) {
      pushToast(
        err instanceof Error ? `附帶畫面失敗：${err.message}` : "附帶畫面失敗",
        "danger",
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleAskAgentInspect = async () => {
    if (!pane?.phone) return;
    setBusyAction("inspect");
    try {
      const shot = await bridgeRef.current.deviceAction(
        pane.phone,
        "save_screenshot",
      );
      if (!shot.ok) {
        throw new Error(shot.error || shot.message || "擷取模擬器截圖失敗");
      }
      if (capabilities.canUpdateModelContext) {
        await bridgeRef.current.attachScreenshotContext({
          phone: pane.phone,
          screenshotPath: shot.screenshotPath,
          screenshotUri: shot.screenshotUri,
        });
      }
      const msgResult = await bridgeRef.current.askAgentToInspect({
        phone: pane.phone,
        screenshotPath: shot.screenshotPath,
      });
      if (msgResult?.isError) {
        throw new Error("主機拒絕傳送訊息");
      }
      pushToast("已請 Agent 檢查此 iPhone 畫面", "success");
    } catch (err) {
      pushToast(
        err instanceof Error ? `傳送請求失敗：${err.message}` : "傳送請求失敗",
        "danger",
      );
    } finally {
      setBusyAction(null);
    }
  };

  const isBooted = Boolean(pane && pane.state === "Booted");
  const phones = pane?.phones ?? [];

  const modeBadgeLabel =
    streamMode === "stream"
      ? "30fps 串流"
      : fallbackReason === "auto"
        ? "抓幀模式 (自動降級)"
        : "抓幀模式";

  const modeBadgeShort =
    streamMode === "stream"
      ? "30fps"
      : fallbackReason === "auto"
        ? "抓幀·降級"
        : "抓幀";

  return (
    <div ref={shellRef} className="app-shell">
      <header className="top-bar" aria-label="模擬器頂部狀態與控制列">
        <div className="top-bar-left">
          <label htmlFor="phone-selector" className="sr-only">
            選擇 iPhone 模擬器
          </label>
          <select
            id="phone-selector"
            className="phone-select"
            value={pane?.phone ?? ""}
            disabled={phones.length === 0 || busyAction !== null}
            onChange={(e) => void handleSelectPhone(e.target.value)}
            aria-label="選擇 iPhone 模擬器"
          >
            {phones.length === 0 ? (
              <option value="">
                {loadingInitial ? "載入裝置中…" : "無可用模擬器"}
              </option>
            ) : (
              phones.map((p) => (
                <option key={p.udid || p.name} value={p.name}>
                  {p.state === "Booted" ? "● " : "○ "}
                  {p.name}
                </option>
              ))
            )}
          </select>

          <button
            type="button"
            className={`top-btn ${isBooted ? "top-btn-stop" : "top-btn-boot"}`}
            disabled={!pane?.phone || busyAction !== null}
            onClick={() => void handleBootOrStop()}
            aria-label={isBooted ? "停止模擬器" : "啟動模擬器"}
            title={isBooted ? "停止模擬器" : "啟動模擬器"}
          >
            <PowerIcon width={14} height={14} />
            <span className="top-btn-label">
              {booting ? "啟動中" : isBooted ? "停止" : "啟動"}
            </span>
          </button>
        </div>

        <div className="top-bar-right">
          {isBooted && (
            <button
              type="button"
              className={`mode-badge mode-${streamMode} ${
                fallbackReason === "auto" ? "is-fallback" : ""
              }`}
              onClick={handleToggleStreamMode}
              title={
                streamMode === "stream"
                  ? "目前為 30fps MJPEG 串流，點擊切換至抓幀模式"
                  : "點擊重試 30fps 串流"
              }
              aria-label={`目前預覽模式：${modeBadgeLabel}，點擊切換`}
            >
              {streamMode === "stream" ? (
                <StreamIcon width={13} height={13} />
              ) : (
                <PollIcon width={13} height={13} />
              )}
              <span className="mode-text-full">{modeBadgeLabel}</span>
              <span className="mode-text-compact" aria-hidden="true">
                {modeBadgeShort}
              </span>
            </button>
          )}

          <button
            type="button"
            className={`top-icon-btn ${refreshing ? "is-spinning" : ""}`}
            disabled={connectionStatus !== "connected" || refreshing}
            onClick={() => void handleRefreshDevices()}
            aria-label="重新整理裝置與畫面"
            title="重新整理裝置與畫面"
          >
            <RefreshIcon width={15} height={15} />
          </button>
        </div>
      </header>

      <div className="workspace-body">
        <PhoneStage
          pane={pane}
          loadingInitial={loadingInitial}
          connectionStatus={connectionStatus}
          connectionMessage={connectionMessage}
          streamMode={streamMode}
          streamNonce={streamNonce}
          pollFrameSrc={pollFrameSrc}
          booting={booting}
          onAutoFallback={handleAutoFallback}
          onStreamHealthy={handleStreamHealthy}
          onTap={handleTap}
          onSwipe={handleSwipe}
          onBootPhone={() => void handleBootOrStop()}
          onRefreshDevices={() => void handleRefreshDevices()}
        />

        <aside className="dock-container" aria-label="快捷控制區">
          <ActionToolbar
            isVertical={isWideContainer}
            isBooted={isBooted}
            busyAction={busyAction}
            simDarkMode={simDarkMode}
            sessionControlsInput={Boolean(pane?.sessionControlsInput)}
            keyboardOpen={keyboardOpen}
            capabilities={capabilities}
            onPressHome={() => void handlePressHome()}
            onToggleSimTheme={() => void handleToggleSimTheme()}
            onReleaseSession={() => void handleReleaseSession()}
            onToggleKeyboard={() => setKeyboardOpen((open) => !open)}
            onAttachScreenToAgent={() => void handleAttachScreenToAgent()}
            onAskAgentInspect={() => void handleAskAgentInspect()}
          />
        </aside>
      </div>

      {keyboardOpen && isBooted && (
        <footer className="keyboard-drawer">
          <KeyboardBar
            disabled={!isBooted}
            sending={busyAction === "type" || busyAction === "key"}
            onTypeText={handleTypeText}
            onSendKey={handleSendKey}
          />
        </footer>
      )}

      <ToastRegion
        toasts={toasts}
        liveAnnouncement={liveAnnouncement}
        onDismiss={dismissToast}
      />
    </div>
  );
}
