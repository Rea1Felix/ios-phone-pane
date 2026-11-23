<p align="center">
  <img src="assets/logo.svg" alt="ios-phone-pane logo" width="84" height="84" />
</p>

<h1 align="center">ios-phone-pane</h1>

<p align="center">
  <strong>Interactive 30fps iOS Simulator Preview Pane for Google Antigravity (MCP App Plugin)</strong><br />
  專為 Google Antigravity 打造的本地 iOS 模擬器 30fps 即時互動預覽側邊面板（MCP App 外掛）
</p>

<p align="center">
  <a href="#english">English</a> •
  <a href="#繁體中文">繁體中文</a> •
  <a href="#license">License (MIT)</a>
</p>

---

<a id="english"></a>

## English

**`ios-phone-pane`** embeds a live, interactive iOS Simulator right inside Antigravity's **auxiliary side pane (`aux_pane`)** and **full-page sidebar view (`global`)** using the [MCP Apps (SEP-1865)](https://github.com/modelcontextprotocol/ext-apps) specification.

It reuses the local [`govijr/terminal-phone`](https://github.com/govijr/terminal-phone) runtime (`idb_companion` + `fb-idb`) without disturbing existing simulator sessions, so you can chat with agents on the left and watch or directly tap, swipe, and type on your iOS app on the right.

### Features

- **30fps Live MJPEG Stream + Automatic Fallback**: Streams smooth MJPEG frames over a loopback-only (`127.0.0.1`) ephemeral HTTP endpoint protected by a per-session random token. If streaming is blocked or stalls (> 3.5s), the UI automatically falls back to serialized MCP `app_frame` polling with a one-click mode toggle.
- **Full Touch, Scroll & Keyboard Control**: Exact display-point tap & swipe mapping (with ripple/trail feedback), mouse-wheel scrolling, ASCII + CJK/Unicode text input, HID keys (`Return`, `Backspace`, `Escape`, `Tab`), and hardware buttons (`Home`, `Lock`, `Siri`, `Side`).
- **Simulator Management**: Switch between registered `terminal-phone` simulators, boot/stop simulators in one click, toggle Dark/Light appearance, and release `terminal-phone` agent input control.
- **Native Antigravity Agent Integration**:
  - **Attach screen to Agent**: Saves a crisp PNG screenshot and attaches it to your next message via `updateModelContext` (`ios-phone://screenshot/<id>`).
  - **Ask Agent to inspect screen**: Captures the current screen and sends a prompt directly to the active conversation via `sendMessage`.
- **Zero-Build Install**: Pre-bundled single-file UI (`dist/app.html`, ~300 KB) and zero extra Python dependencies beyond `terminal-phone`'s built-in `idb-venv`.

### Prerequisites

- **macOS** with **Xcode** and at least one iOS Simulator runtime installed
- **[`govijr/terminal-phone`](https://github.com/govijr/terminal-phone)** installed and initialized (`terminal-phone setup`), providing `~/.local/bin/terminal-phone` and `~/Library/Application Support/terminal-phone/dependencies/{idb-venv,companion}`
- **Google Antigravity**

### Quick Install

Clone directly into Antigravity's global plugins directory — no Node.js or build step required:

```bash
git clone https://github.com/Rea1Felix/ios-phone-pane.git ~/.gemini/config/plugins/ios-phone-pane
```

Antigravity automatically discovers plugins placed under `~/.gemini/config/plugins/`.

> **Environment Overrides (Optional)**
> - `TERMINAL_PHONE_HOME`: Custom `terminal-phone` data directory (defaults to `~/Library/Application Support/terminal-phone`)
> - `TERMINAL_PHONE_BIN`: Custom path to the `terminal-phone` executable (defaults to `PATH` lookup or `~/.local/bin/terminal-phone`)
> - `IOS_PHONE_PANE_PYTHON`: Custom Python interpreter with `fb-idb` installed
> - `IOS_PHONE_PANE_HTML`: Custom path to `app.html` for fast UI iteration

### Usage

1. Click **`+` → `iPhone 預覽`** in Antigravity's right-hand auxiliary pane (or **`iPhone 預覽`** in the left sidebar), or ask your agent to call `open_phone_pane`.
2. The pane automatically connects to a booted `terminal-phone` simulator (e.g. `default`). If none is booted, click **"啟動模擬器"** (Boot Simulator) directly inside the bezel.
3. Click, drag-swipe, scroll with the mouse wheel, or open the bottom keyboard bar to interact live.

### Security Model

- The MJPEG HTTP server binds strictly to `127.0.0.1` on an ephemeral port (`0`).
- Every HTTP request (`/health`, `/snapshot`, `/stream`) requires a startup-generated 192-bit token (`secrets.token_urlsafe(24)`) verified with `hmac.compare_digest`; invalid or missing tokens receive `403 Forbidden`.
- Tokens are passed only in `structuredContent` to the isolated iframe and are never printed to model-visible text `content`.
- The MCP App UI resource declares strict `_meta.ui.csp` origins scoped exclusively to `http://127.0.0.1:<port>`.

### Development & Rebuilding the UI

Only needed if you modify `web/src/`:

```bash
cd ~/.gemini/config/plugins/ios-phone-pane/web
npm install
npm run build   # outputs self-contained ../dist/app.html
```

Because `dist/app.html` is read fresh every time the pane opens, UI changes take effect immediately upon reopening the pane. If you modify `server/`, restart `ios-phone-pane_phone` from Antigravity's **MCP Servers** settings.

---

<a id="繁體中文"></a>

## 繁體中文

**`ios-phone-pane`** 是專為 Google Antigravity 打造的本地 iOS 模擬器即時預覽與互動控制 MCP App 外掛，遵循 [MCP Apps (SEP-1865)](https://github.com/modelcontextprotocol/ext-apps) 標準，可直接嵌入 Antigravity 的 **右側輔助面板（`aux_pane`）** 與 **左側全域檢視（`global`）**。

底層直接複用本機已安裝的 [`govijr/terminal-phone`](https://github.com/govijr/terminal-phone)（`idb_companion` 與 `fb-idb`），不干擾既有的模擬器或自動化工作階段，讓你左邊與 Agent 對話寫程式、右邊直接以 30fps 高清畫面點擊與滑動測試 iOS App。

### 主要功能

- **30fps 即時串流（方案 A）＋ 自動無縫降級（方案 B）**：透過僅限本機 `127.0.0.1`、隨機埠與一次性高熵 Token 保護的 MJPEG 串流提供流暢互動畫面；若串流逾時（3.5 秒）或遭阻擋，會自動降級為序列化 MCP `app_frame` 抓幀模式，並可隨時一鍵切換。
- **完整觸控、滾輪與鍵盤操作**：精準映射 iOS 邏輯座標的點擊與拖曳滑動（附漣漪／軌跡視覺回饋）、滑鼠滾輪捲動、ASCII 與中文輸入（自動剪貼簿貼上）、快捷按鍵（`Return`、`Backspace`、`Escape`、`Tab`）及實體按鍵（`HOME`、`LOCK`、`SIRI`、`SIDE_BUTTON`）。
- **模擬器快速管理**：切換多台已註冊模擬器、一鍵啟動／停止模擬器、切換深淺色外觀，以及一鍵釋放 `terminal-phone` Agent 輸入控制權。
- **Antigravity 專屬連動**：
  - **附帶畫面給 Agent**：儲存高解析 PNG 截圖並透過 `updateModelContext` 自動掛入下一則對話上下文（`ios-phone://screenshot/<id>`）。
  - **請 Agent 檢查此畫面**：自動存圖並送出提示詞請目前對話中的 Agent 檢查畫面。
- **免建置開箱即用**：倉庫內建已編譯好的單檔 UI（`dist/app.html`，約 300 KB），後端直接使用 `terminal-phone` 內建的 Python 3.13 `idb-venv`，不需額外安裝套件。

### 系統需求

- **macOS**、**Xcode** 與至少一組 iOS Simulator Runtime
- 已安裝並完成初始化的 **[`govijr/terminal-phone`](https://github.com/govijr/terminal-phone)**（執行過 `terminal-phone setup`，具備 `~/.local/bin/terminal-phone` 與 `~/Library/Application Support/terminal-phone/dependencies/`）
- **Google Antigravity**

### 快速安裝

直接 clone 到 Antigravity 的全域外掛目錄，免裝 Node.js、免編譯即可自動載入：

```bash
git clone https://github.com/Rea1Felix/ios-phone-pane.git ~/.gemini/config/plugins/ios-phone-pane
```

### 使用方式

1. 在 Antigravity 右側輔助面板點選 **`+` → `iPhone 預覽`**（或左側 Sidebar 的 **`iPhone 預覽`**），或在對話中請 Agent 呼叫 `open_phone_pane`。
2. 面板會自動連線至目前執行中的 `terminal-phone` 模擬器（例如 `default`）；若尚未開機，直接點手機畫面中央的 **「啟動模擬器」** 即可。
3. 直接用滑鼠點擊、拖曳滑動、滾輪捲動，或點擊底部鍵盤圖示輸入文字。

### 開發與重新建置

僅在修改 `web/src/` 前端介面時需要重新建置：

```bash
cd ~/.gemini/config/plugins/ios-phone-pane/web
npm install
npm run build   # 輸出單檔至 ../dist/app.html
```

每次開啟面板都會即時重讀 `dist/app.html`，修改前端不需重啟伺服器；若修改 `server/` 後端程式，請於 Antigravity 的 **MCP Servers** 設定中重新載入 `ios-phone-pane_phone`。

---

<a id="license"></a>

## License

Released under the [MIT License](LICENSE). Built to work alongside [`govijr/terminal-phone`](https://github.com/govijr/terminal-phone) (MIT).
