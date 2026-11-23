import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type {
  BasicToolResult,
  DeviceActionResult,
  DeviceActionType,
  FrameResult,
  GestureResult,
  HostCapabilitiesSummary,
  ListPhonesResult,
  PhoneHardwareButton,
  PhoneKey,
  PhonePaneState,
} from "./types";

interface CallToolResultLike {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
}

export function extractTextError(result: CallToolResultLike | undefined): string | undefined {
  if (!result?.content) return undefined;
  const parts = result.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text!.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function parseStructuredPayload<T extends { ok?: boolean; error?: string; message?: string }>(
  result: CallToolResultLike | undefined,
): T | null {
  if (!result) return null;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    const sc = result.structuredContent as T;
    if (result.isError && sc.ok !== false) {
      return {
        ...sc,
        ok: false,
        error: sc.error ?? sc.message ?? extractTextError(result) ?? "工具呼叫失敗",
      };
    }
    return sc;
  }

  const text = extractTextError(result);
  if (text && text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as T;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // fall through
    }
  }

  if (result.isError) {
    return {
      ok: false,
      error: text ?? "工具執行失敗",
    } as T;
  }

  return null;
}

export function applyHostContextToDocument(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
}

interface QueuedTask<T> {
  priority: number; // 0 = high (toolbar/device), 1 = gesture, 2 = frame
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/**
 * Antigravity enforces at most 4 in-flight `app.callServerTool` requests.
 * We cap total concurrent calls at 3, keep gestures strictly serialized,
 * and guarantee `app_frame` is single-flight and yields to interactive calls.
 */
export class PhoneMcpBridge {
  readonly app: App;
  private connected = false;
  private inFlight = 0;
  private readonly maxInFlight = 3;
  private readonly queue: Array<QueuedTask<unknown>> = [];

  private gestureChain: Promise<unknown> = Promise.resolve();
  private pendingGestures = 0;
  private readonly maxPendingGestures = 6;
  private frameInFlight = false;

  constructor() {
    this.app = new App(
      { name: "ios-phone-pane", version: "0.1.0" },
      {},
      { autoResize: true },
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  markConnected(): void {
    this.connected = true;
  }

  getCapabilitiesSummary(): HostCapabilitiesSummary {
    const caps = this.app.getHostCapabilities();
    return {
      canUpdateModelContext: Boolean(caps?.updateModelContext),
      canSendMessage: Boolean(caps?.message),
    };
  }

  private pump(): void {
    while (this.inFlight < this.maxInFlight && this.queue.length > 0) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const next = this.queue.shift();
      if (!next) break;
      this.inFlight += 1;
      next
        .run()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.pump();
        });
    }
  }

  private schedule<T>(priority: number, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        run: fn,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  private async invokeTool<T extends { ok?: boolean; error?: string; message?: string }>(
    name: string,
    args: Record<string, unknown>,
    priority: number,
  ): Promise<T> {
    if (!this.connected) {
      throw new Error("尚未連線至 Antigravity 主機");
    }
    const raw = await this.schedule(priority, () =>
      this.app.callServerTool({ name, arguments: args }),
    );
    const parsed = parseStructuredPayload<T>(raw as CallToolResultLike);
    if (!parsed) {
      throw new Error(`工具 ${name} 未回傳結構化結果`);
    }
    return parsed;
  }

  listPhones(): Promise<ListPhonesResult> {
    return this.invokeTool<ListPhonesResult>("app_list_phones", {}, 0);
  }

  selectPhone(phone: string, boot?: boolean): Promise<PhonePaneState> {
    const args: Record<string, unknown> = { phone };
    if (boot !== undefined) args.boot = boot;
    return this.invokeTool<PhonePaneState>("app_select_phone", args, 0);
  }

  /**
   * Strictly single-flight frame fetch. Returns `null` if skipped due to
   * an already-running frame fetch or high interactive concurrency.
   */
  async fetchFrame(params: {
    phone?: string;
    maxWidth?: number;
    quality?: number;
  }): Promise<FrameResult | null> {
    if (!this.connected) return null;
    if (this.frameInFlight) return null;
    // Leave at least one slot open for interactive clicks/gestures.
    if (this.inFlight >= this.maxInFlight - 1) return null;

    this.frameInFlight = true;
    try {
      const args: Record<string, unknown> = {};
      if (params.phone) args.phone = params.phone;
      if (params.maxWidth !== undefined) args.maxWidth = params.maxWidth;
      if (params.quality !== undefined) args.quality = params.quality;
      return await this.invokeTool<FrameResult>("app_frame", args, 2);
    } finally {
      this.frameInFlight = false;
    }
  }

  tap(phone: string | undefined, x: number, y: number): Promise<GestureResult | null> {
    return this.enqueueGesture(() => {
      const args: Record<string, unknown> = { x, y };
      if (phone) args.phone = phone;
      return this.invokeTool<GestureResult>("app_tap", args, 1);
    });
  }

  swipe(
    phone: string | undefined,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
  ): Promise<GestureResult | null> {
    return this.enqueueGesture(() => {
      const args: Record<string, unknown> = { x1, y1, x2, y2 };
      if (phone) args.phone = phone;
      if (duration !== undefined) args.duration = duration;
      return this.invokeTool<GestureResult>("app_swipe", args, 1);
    });
  }

  private enqueueGesture<T>(task: () => Promise<T>): Promise<T | null> {
    if (this.pendingGestures >= this.maxPendingGestures) {
      return Promise.resolve(null);
    }
    this.pendingGestures += 1;
    const resultPromise = this.gestureChain
      .catch(() => undefined)
      .then(async () => {
        try {
          return await task();
        } finally {
          this.pendingGestures = Math.max(0, this.pendingGestures - 1);
        }
      });
    this.gestureChain = resultPromise;
    return resultPromise;
  }

  typeText(phone: string | undefined, text: string): Promise<BasicToolResult> {
    const args: Record<string, unknown> = { text };
    if (phone) args.phone = phone;
    return this.invokeTool<BasicToolResult>("app_type", args, 0);
  }

  sendKey(phone: string | undefined, key: PhoneKey): Promise<BasicToolResult> {
    const args: Record<string, unknown> = { key };
    if (phone) args.phone = phone;
    return this.invokeTool<BasicToolResult>("app_key", args, 0);
  }

  pressButton(phone: string | undefined, button: PhoneHardwareButton): Promise<BasicToolResult> {
    const args: Record<string, unknown> = { button };
    if (phone) args.phone = phone;
    return this.invokeTool<BasicToolResult>("app_button", args, 0);
  }

  deviceAction(
    phone: string | undefined,
    action: DeviceActionType,
  ): Promise<DeviceActionResult> {
    const args: Record<string, unknown> = { action };
    if (phone) args.phone = phone;
    return this.invokeTool<DeviceActionResult>("app_device_action", args, 0);
  }

  async attachScreenshotContext(params: {
    phone: string;
    screenshotPath?: string;
    screenshotUri?: string;
  }): Promise<void> {
    const caps = this.getCapabilitiesSummary();
    if (!caps.canUpdateModelContext) {
      throw new Error("目前視圖不支援附帶上下文給 Agent");
    }
    const pathNote = params.screenshotPath
      ? `，已儲存截圖 ${params.screenshotPath}`
      : "";
    const content: Array<
      | { type: "text"; text: string }
      | { type: "resource_link"; uri: string; name: string; mimeType: string }
    > = [
      {
        type: "text",
        text: `目前 iPhone 預覽畫面（${params.phone}${pathNote}）`,
      },
    ];
    if (params.screenshotUri) {
      content.push({
        type: "resource_link",
        uri: params.screenshotUri,
        name: `${params.phone}-screenshot.png`,
        mimeType: "image/png",
      });
    }
    await this.app.updateModelContext({ content });
  }

  async askAgentToInspect(params: {
    phone: string;
    screenshotPath?: string;
  }): Promise<{ isError?: boolean }> {
    const caps = this.getCapabilitiesSummary();
    if (!caps.canSendMessage) {
      throw new Error("目前視圖不支援傳送訊息給 Agent");
    }
    const pathSegment = params.screenshotPath
      ? `（截圖路徑：${params.screenshotPath}）`
      : "";
    return this.app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: `請檢查目前 iPhone 模擬器「${params.phone}」的預覽畫面${pathSegment}，協助確認 UI 排版、元件狀態與任何異常。`,
        },
      ],
    });
  }
}
