export interface PhoneSummary {
  name: string;
  udid: string;
  state: string;
  kind?: string;
  deviceType?: string;
  runtime?: string;
}

export interface PhonePaneState {
  ok: boolean;
  phone: string;
  udid: string;
  state: string;
  width: number;
  height: number;
  scale: number;
  streamUrl?: string | null;
  snapshotUrl?: string | null;
  phones: PhoneSummary[];
  sessionControlsInput?: boolean;
  message?: string;
  error?: string;
}

export interface ListPhonesResult {
  ok: boolean;
  phones: PhoneSummary[];
  activePhone?: string | null;
  error?: string;
}

export interface FrameResult {
  ok: boolean;
  mimeType: string;
  base64: string;
  width?: number;
  height?: number;
  capturedAt?: number | string;
  error?: string;
}

export interface GestureResult {
  ok: boolean;
  elapsedMs?: number;
  error?: string;
}

export interface BasicToolResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export type PhoneKey = "return" | "backspace" | "escape" | "tab";
export type PhoneHardwareButton = "HOME" | "LOCK" | "SIRI" | "SIDE_BUTTON";
export type DeviceActionType =
  | "boot"
  | "stop"
  | "release_session"
  | "dark"
  | "light"
  | "save_screenshot";

export interface DeviceActionResult {
  ok: boolean;
  message?: string;
  state?: string;
  screenshotId?: string;
  screenshotUri?: string;
  screenshotPath?: string;
  base64?: string;
  error?: string;
}

export type StreamMode = "stream" | "poll";
export type FallbackReason = "none" | "auto" | "manual" | "no-stream";

export interface HostCapabilitiesSummary {
  canUpdateModelContext: boolean;
  canSendMessage: boolean;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "success" | "warning" | "danger";
}

export interface TapRipple {
  id: number;
  pctX: number;
  pctY: number;
}

export interface SwipeTrail {
  id: number;
  x1Pct: number;
  y1Pct: number;
  x2Pct: number;
  y2Pct: number;
  active: boolean;
}
