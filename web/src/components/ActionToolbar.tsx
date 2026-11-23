import { useEffect, useRef } from "react";
import {
  AttachScreenIcon,
  HomeIcon,
  KeyboardIcon,
  MoonSunIcon,
  ReleaseControlIcon,
  SparkleInspectIcon,
} from "../icons";
import type { HostCapabilitiesSummary } from "../types";

interface ActionToolbarProps {
  isVertical: boolean;
  isBooted: boolean;
  busyAction: string | null;
  simDarkMode: boolean;
  sessionControlsInput: boolean;
  keyboardOpen: boolean;
  capabilities: HostCapabilitiesSummary;
  onPressHome: () => void;
  onToggleSimTheme: () => void;
  onReleaseSession: () => void;
  onToggleKeyboard: () => void;
  onAttachScreenToAgent: () => void;
  onAskAgentInspect: () => void;
}

const SUPPORTS_FOCUSGROUP =
  typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype;

export function ActionToolbar({
  isVertical,
  isBooted,
  busyAction,
  simDarkMode,
  sessionControlsInput,
  keyboardOpen,
  capabilities,
  onPressHome,
  onToggleSimTheme,
  onReleaseSession,
  onToggleKeyboard,
  onAttachScreenToAgent,
  onAskAgentInspect,
}: ActionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const hasAgentActions =
    capabilities.canUpdateModelContext || capabilities.canSendMessage;

  // Fallback roving tabindex ONLY when native HTML focusgroup is unsupported.
  useEffect(() => {
    if (SUPPORTS_FOCUSGROUP) return;
    const bar = toolbarRef.current;
    if (!bar) return;

    const getItems = () =>
      Array.from(bar.querySelectorAll<HTMLButtonElement>("button"));

    const items = getItems();
    if (items.length === 0) return;

    const activeIdx = items.findIndex((b) => b.tabIndex === 0);
    const initialIdx = activeIdx >= 0 ? activeIdx : 0;
    items.forEach((b, i) => {
      b.tabIndex = i === initialIdx ? 0 : -1;
    });

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const currentItems = getItems();
      if (!currentItems.includes(target)) return;
      currentItems.forEach((b) => {
        b.tabIndex = b === target ? 0 : -1;
      });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const currentItems = getItems();
      if (currentItems.length === 0) return;
      const current = document.activeElement;
      const idx =
        current instanceof HTMLButtonElement
          ? currentItems.indexOf(current)
          : -1;
      if (idx < 0) return;

      const vertical = bar.getAttribute("aria-orientation") === "vertical";
      const rtl = getComputedStyle(bar).direction === "rtl";
      const steps: Record<string, number> = vertical
        ? { ArrowDown: 1, ArrowUp: -1 }
        : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };

      let nextIdx: number | null = null;
      if (e.key in steps) {
        nextIdx = (idx + steps[e.key] + currentItems.length) % currentItems.length;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = currentItems.length - 1;
      }

      if (nextIdx !== null) {
        e.preventDefault();
        const nextBtn = currentItems[nextIdx];
        currentItems.forEach((b, i) => {
          b.tabIndex = i === nextIdx ? 0 : -1;
        });
        nextBtn.focus();
      }
    };

    bar.addEventListener("focusin", handleFocusIn);
    bar.addEventListener("keydown", handleKeyDown);
    return () => {
      bar.removeEventListener("focusin", handleFocusIn);
      bar.removeEventListener("keydown", handleKeyDown);
    };
  }, [isVertical, hasAgentActions, capabilities.canUpdateModelContext, capabilities.canSendMessage]);

  const deviceDisabled = !isBooted || busyAction !== null;

  const guardClick = (disabled: boolean, fn: () => void) => () => {
    if (disabled) return;
    fn();
  };

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="iPhone 控制工具列"
      aria-controls="phone-screen-stage"
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      className="action-toolbar"
      {...({
        focusgroup: isVertical ? "toolbar wrap block" : "toolbar wrap",
      } as Record<string, string>)}
    >
      <div role="group" aria-label="裝置快捷鍵" className="toolbar-group">
        <button
          type="button"
          className="tb-btn"
          aria-label="主畫面鍵 (Home)"
          title="主畫面鍵 (Home)"
          aria-disabled={deviceDisabled ? "true" : undefined}
          onClick={guardClick(deviceDisabled, onPressHome)}
        >
          <HomeIcon width={16} height={16} />
          <span className="tb-label">Home</span>
        </button>

        <button
          type="button"
          className="tb-btn"
          aria-label="切換模擬器深淺色外觀"
          aria-pressed={simDarkMode ? "true" : "false"}
          title={simDarkMode ? "切換模擬器為淺色外觀" : "切換模擬器為深色外觀"}
          aria-disabled={deviceDisabled ? "true" : undefined}
          onClick={guardClick(deviceDisabled, onToggleSimTheme)}
        >
          <MoonSunIcon isDark={simDarkMode} width={16} height={16} />
          <span className="tb-label">{simDarkMode ? "淺色" : "深色"}</span>
        </button>

        <button
          type="button"
          className={`tb-btn ${sessionControlsInput ? "tb-btn-attention" : ""}`}
          aria-label={
            sessionControlsInput
              ? "釋放控制權（目前由 Agent 工作階段占用）"
              : "釋放控制權"
          }
          title={
            sessionControlsInput
              ? "目前由工作階段占用輸入，點擊釋放控制權"
              : "釋放控制權"
          }
          aria-disabled={deviceDisabled ? "true" : undefined}
          onClick={guardClick(deviceDisabled, onReleaseSession)}
        >
          <span className="tb-icon-badge-wrap">
            <ReleaseControlIcon width={16} height={16} />
            {sessionControlsInput && (
              <span className="tb-attention-dot" aria-hidden="true" />
            )}
          </span>
          <span className="tb-label">釋放控制</span>
        </button>

        <button
          type="button"
          className="tb-btn"
          aria-label="鍵盤文字輸入列"
          aria-pressed={keyboardOpen ? "true" : "false"}
          title="開啟／收合鍵盤文字輸入列"
          aria-disabled={!isBooted ? "true" : undefined}
          onClick={guardClick(!isBooted, onToggleKeyboard)}
        >
          <KeyboardIcon width={16} height={16} />
          <span className="tb-label">鍵盤</span>
        </button>
      </div>

      {hasAgentActions && (
        <>
          <span
            role="separator"
            aria-orientation={isVertical ? "horizontal" : "vertical"}
            className="toolbar-separator"
          />

          <div role="group" aria-label="Agent 協作動作" className="toolbar-group">
            {capabilities.canUpdateModelContext && (
              <button
                type="button"
                className="tb-btn tb-btn-agent"
                aria-label="附帶畫面給 Agent"
                title="儲存目前 iPhone 截圖並附帶到 Agent 對話上下文"
                aria-disabled={deviceDisabled ? "true" : undefined}
                onClick={guardClick(deviceDisabled, onAttachScreenToAgent)}
              >
                <AttachScreenIcon width={16} height={16} />
                <span className="tb-label">
                  {busyAction === "attach" ? "截圖中…" : "附帶畫面"}
                </span>
              </button>
            )}

            {capabilities.canSendMessage && (
              <button
                type="button"
                className="tb-btn tb-btn-agent-primary"
                aria-label="請 Agent 檢查此畫面"
                title="儲存目前畫面並立即請 Agent 檢查 UI 狀態"
                aria-disabled={deviceDisabled ? "true" : undefined}
                onClick={guardClick(deviceDisabled, onAskAgentInspect)}
              >
                <SparkleInspectIcon width={16} height={16} />
                <span className="tb-label">
                  {busyAction === "inspect" ? "傳送中…" : "請 Agent 檢查"}
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
