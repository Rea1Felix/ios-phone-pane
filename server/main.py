"""MCP App stdio server + loopback MJPEG streaming server for ios-phone-pane.

Implements JSON-RPC 2.0 over newline-delimited stdio with zero third-party
dependencies outside the existing terminal-phone idb-venv (Python 3.13 + fb-idb).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hmac
import json
import logging
import os
import secrets
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from idb_bridge import IDBBridge, PhoneInfo

# Strictly log only to stderr — stdout is exclusively MCP JSON-RPC frames.
logging.basicConfig(
    level=os.environ.get("IOS_PHONE_PANE_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("ios-phone-pane.server")

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
APP_RESOURCE_URI = "ui://ios-phone-pane/app.html"
APP_MIME_TYPE = "text/html;profile=mcp-app"
SCREENSHOT_URI_PREFIX = "ios-phone://screenshot/"
SERVER_NAME = "ios-phone-pane"
SERVER_VERSION = "0.1.0"

PLACEHOLDER_HTML = """<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>iPhone 互動預覽面板</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      background: var(--color-background-primary, #111827);
      color: var(--color-text-primary, #f3f4f6);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      max-width: 360px;
      padding: 20px 24px;
      border-radius: 14px;
      background: var(--color-background-secondary, rgba(255,255,255,0.06));
      border: 1px solid var(--color-border-primary, rgba(255,255,255,0.14));
      text-align: center;
    }
    h1 { font-size: 16px; margin: 0 0 8px; }
    p { font-size: 13px; margin: 0; color: var(--color-text-secondary, #9ca3af); line-height: 1.5; }
    code { font-size: 12px; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="card">
    <h1>iPhone 互動預覽面板建置中</h1>
    <p>找不到前端檔案 <code>dist/app.html</code>。完成前端編譯後重新開啟此面板即可自動載入。</p>
  </div>
</body>
</html>
"""

PANE_META: dict[str, Any] = {
    "ui": {"resourceUri": APP_RESOURCE_URI},
    "com.google.antigravity/ui": {
        "entrypoints": [
            {"type": "aux_pane", "title": "iPhone 預覽"},
            {"type": "global", "title": "iPhone 預覽"},
        ]
    },
}

APP_ONLY_META: dict[str, Any] = {
    "ui": {"visibility": ["app"]},
}

TOOLS_SCHEMA: list[dict[str, Any]] = [
    {
        "name": "open_phone_pane",
        "title": "開啟 iPhone 互動預覽面板",
        "description": (
            "在 Antigravity 側邊欄或全頁面板中開啟本地 iOS 模擬器即時預覽與互動控制介面。"
            "未指定 phone 時會自動選擇目前執行中的模擬器（例如 default）。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {
                    "type": "string",
                    "description": "已註冊的 terminal-phone 裝置名稱（選填，預設自動挑選執行中的模擬器）。",
                }
            },
            "additionalProperties": False,
        },
        "_meta": PANE_META,
    },
    {
        "name": "app_list_phones",
        "title": "List registered phones",
        "description": "列出所有已註冊的 terminal-phone 裝置與即時啟動狀態。",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
    {
        "name": "app_select_phone",
        "title": "Select active phone",
        "description": "切換目前預覽面板綁定的裝置，選擇性地自動啟動模擬器。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "boot": {"type": "boolean"},
            },
            "required": ["phone"],
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
    {
        "name": "app_frame",
        "title": "Capture JPEG preview frame",
        "description": "抓取單張壓縮 JPEG 預覽影格（Plan B 降級抓幀模式）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "maxWidth": {"type": "number"},
                "quality": {"type": "number"},
            },
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
    {
        "name": "app_tap",
        "title": "Tap screen coordinates",
        "description": "在模擬器畫面的指定點位座標（points）執行點擊。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            "required": ["x", "y"],
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
    {
        "name": "app_swipe",
        "title": "Swipe screen coordinates",
        "description": "在模擬器畫面的起迄點位座標（points）執行滑動手勢。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "x1": {"type": "number"},
                "y1": {"type": "number"},
                "x2": {"type": "number"},
                "y2": {"type": "number"},
                "duration": {"type": "number"},
            },
            "required": ["x1", "y1", "x2", "y2"],
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
    {
        "name": "app_type",
        "title": "Type text",
        "description": "向模擬器輸入文字（支援 ASCII 與透過剪貼簿貼上中文/Unicode）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["text"],
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
    {
        "name": "app_key",
        "title": "Press special key",
        "description": "傳送快捷按鍵（return、backspace、escape、tab）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "key": {
                    "type": "string",
                    "enum": ["return", "backspace", "escape", "tab"],
                },
            },
            "required": ["key"],
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
    {
        "name": "app_button",
        "title": "Press hardware button",
        "description": "按下模擬器實體按鍵（HOME、LOCK、SIRI、SIDE_BUTTON）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "button": {
                    "type": "string",
                    "enum": ["HOME", "LOCK", "SIRI", "SIDE_BUTTON"],
                },
            },
            "required": ["button"],
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
    {
        "name": "app_device_action",
        "title": "Perform device action",
        "description": "執行裝置控制動作（boot、stop、release_session、dark、light、save_screenshot）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "action": {
                    "type": "string",
                    "enum": [
                        "boot",
                        "stop",
                        "release_session",
                        "dark",
                        "light",
                        "save_screenshot",
                    ],
                },
            },
            "required": ["action"],
            "additionalProperties": False,
        },
        "_meta": APP_ONLY_META,
    },
]


class LoopbackMediaServer:
    """Minimal pure-asyncio loopback HTTP server for MJPEG stream & snapshots."""

    def __init__(self, bridge: IDBBridge) -> None:
        self.bridge = bridge
        self.token = secrets.token_urlsafe(24)
        self.host = "127.0.0.1"
        self.port: int = 0
        self._server: asyncio.AbstractServer | None = None
        self._active_clients: set[asyncio.Task[None]] = set()

    @property
    def origin(self) -> str:
        return f"http://{self.host}:{self.port}"

    def stream_url(self, phone_name: str, *, fps: int = 24, scale: float = 0.5) -> str:
        q_phone = quote(phone_name, safe="")
        return (
            f"{self.origin}/stream?phone={q_phone}&token={self.token}"
            f"&fps={fps}&scale={scale}"
        )

    def snapshot_url(self, phone_name: str) -> str:
        q_phone = quote(phone_name, safe="")
        return f"{self.origin}/snapshot?phone={q_phone}&token={self.token}"

    async def start(self) -> None:
        self._server = await asyncio.start_server(
            self._handle_connection_wrapper,
            host=self.host,
            port=0,
        )
        sockets = self._server.sockets
        if not sockets:
            raise RuntimeError("Failed to bind loopback HTTP server")
        self.port = int(sockets[0].getsockname()[1])
        logger.info("Loopback MJPEG server listening on %s", self.origin)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._server.wait_closed(), timeout=2.0)
            self._server = None
        for task in list(self._active_clients):
            task.cancel()
        for task in list(self._active_clients):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(task, timeout=1.0)
        self._active_clients.clear()

    async def _handle_connection_wrapper(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._active_clients.add(task)
        try:
            await self._handle_connection(reader, writer)
        except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
            pass
        except Exception as exc:
            logger.debug("HTTP client handler error: %s", exc)
        finally:
            if task is not None:
                self._active_clients.discard(task)
            with contextlib.suppress(Exception):
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), timeout=1.0)

    async def _send_response(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        reason: str,
        body: bytes,
        content_type: str = "application/json; charset=utf-8",
        *,
        head_only: bool = False,
    ) -> None:
        headers = (
            f"HTTP/1.1 {status} {reason}\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
            "X-Content-Type-Options: nosniff\r\n"
            "Connection: close\r\n"
            "\r\n"
        ).encode("ascii")
        writer.write(headers)
        if not head_only and body:
            writer.write(body)
        await asyncio.wait_for(writer.drain(), timeout=5.0)

    async def _send_json(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        reason: str,
        payload: dict[str, Any],
        *,
        head_only: bool = False,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        await self._send_response(writer, status, reason, body, head_only=head_only)

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            raw_head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            return

        lines = raw_head.decode("latin-1", errors="replace").split("\r\n")
        if not lines or not lines[0]:
            return
        parts = lines[0].split(" ", 2)
        if len(parts) < 2:
            await self._send_json(writer, 400, "Bad Request", {"ok": False, "error": "bad request"})
            return

        method = parts[0].upper()
        target = parts[1]

        if method == "OPTIONS":
            await self._send_response(writer, 204, "No Content", b"", content_type="text/plain")
            return

        if method not in ("GET", "HEAD"):
            await self._send_json(
                writer, 405, "Method Not Allowed", {"ok": False, "error": "method not allowed"}
            )
            return

        head_only = method == "HEAD"
        split = urlsplit(target)
        path = split.path
        qs = parse_qs(split.query, keep_blank_values=False)

        provided_token = (qs.get("token") or [""])[0]
        if not provided_token or not hmac.compare_digest(provided_token, self.token):
            await self._send_json(
                writer, 403, "Forbidden", {"ok": False, "error": "invalid token"}, head_only=head_only
            )
            return

        if path == "/health":
            await self._send_json(writer, 200, "OK", {"ok": True}, head_only=head_only)
            return

        if path == "/snapshot":
            phone_param = (qs.get("phone") or [""])[0] or None
            try:
                jpeg_bytes, _, _ = await self.bridge.capture_jpeg(
                    phone_param, max_width=640, quality=0.82
                )
            except Exception as exc:
                await self._send_json(
                    writer,
                    503,
                    "Service Unavailable",
                    {"ok": False, "error": str(exc)},
                    head_only=head_only,
                )
                return
            await self._send_response(
                writer,
                200,
                "OK",
                jpeg_bytes,
                content_type="image/jpeg",
                head_only=head_only,
            )
            return

        if path == "/stream":
            phone_param = (qs.get("phone") or [""])[0] or None
            try:
                fps = int((qs.get("fps") or ["24"])[0])
            except ValueError:
                fps = 24
            try:
                scale = float((qs.get("scale") or ["0.5"])[0])
            except ValueError:
                scale = 0.5
            fps = max(1, min(30, fps))
            scale = max(0.2, min(1.0, scale))

            phone = await self.bridge.get_phone(phone_param)
            if phone is None:
                await self._send_json(
                    writer,
                    404,
                    "Not Found",
                    {"ok": False, "error": f"phone not found: {phone_param or '(default)'}"},
                    head_only=head_only,
                )
                return
            if phone.state != "Booted":
                await self._send_json(
                    writer,
                    503,
                    "Service Unavailable",
                    {"ok": False, "error": f"phone {phone.name} is {phone.state}"},
                    head_only=head_only,
                )
                return

            try:
                await self.bridge.ensure_companion(phone.udid, phone.name)
            except Exception as exc:
                await self._send_json(
                    writer,
                    503,
                    "Service Unavailable",
                    {"ok": False, "error": str(exc)},
                    head_only=head_only,
                )
                return

            header = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
                "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
                "Pragma: no-cache\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "X-Content-Type-Options: nosniff\r\n"
                "Connection: close\r\n"
                "\r\n"
            ).encode("ascii")
            writer.write(header)
            await asyncio.wait_for(writer.drain(), timeout=5.0)
            if head_only:
                return

            hub = self.bridge.get_stream_hub(phone)
            queue = hub.subscribe(fps=fps, scale=scale)
            try:
                while True:
                    try:
                        frame = await asyncio.wait_for(queue.get(), timeout=20.0)
                    except TimeoutError:
                        # No frames for 20s -> verify connection / bail cleanly.
                        break
                    if frame is None:
                        break
                    part = (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii")
                        + frame
                        + b"\r\n"
                    )
                    writer.write(part)
                    await asyncio.wait_for(writer.drain(), timeout=5.0)
            except (ConnectionResetError, BrokenPipeError, TimeoutError, asyncio.CancelledError):
                pass
            finally:
                hub.unsubscribe(queue)
            return

        await self._send_json(
            writer, 404, "Not Found", {"ok": False, "error": "not found"}, head_only=head_only
        )


class MCPPhonePaneServer:
    """JSON-RPC 2.0 MCP App server over stdio."""

    def __init__(self) -> None:
        self.bridge = IDBBridge()
        self.http_server = LoopbackMediaServer(self.bridge)
        self._stdout_lock = asyncio.Lock()
        self._inflight: dict[Any, asyncio.Task[None]] = {}

    def _ui_resource_meta(self) -> dict[str, Any]:
        return {
            "ui": {
                "prefersBorder": False,
                "csp": {
                    "resourceDomains": [self.http_server.origin],
                    "connectDomains": [self.http_server.origin],
                },
            }
        }

    def _read_app_html(self) -> str:
        html_path_str = os.environ.get("IOS_PHONE_PANE_HTML") or str(
            PLUGIN_ROOT / "dist" / "app.html"
        )
        html_path = Path(html_path_str)
        if html_path.is_file():
            try:
                text = html_path.read_text(encoding="utf-8")
                if text.strip():
                    return text
            except Exception as exc:
                logger.warning("Failed reading %s: %s", html_path, exc)
        return PLACEHOLDER_HTML

    async def _send_message(self, msg: dict[str, Any]) -> None:
        line = (json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        async with self._stdout_lock:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()

    async def _send_result(self, req_id: Any, result: Any) -> None:
        await self._send_message({"jsonrpc": "2.0", "id": req_id, "result": result})

    async def _send_error(
        self, req_id: Any, code: int, message: str, data: Any = None
    ) -> None:
        err: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            err["data"] = data
        await self._send_message({"jsonrpc": "2.0", "id": req_id, "error": err})

    async def _build_pane_state(
        self,
        phone: PhoneInfo | None,
        phones: list[PhoneInfo],
    ) -> tuple[str, dict[str, Any]]:
        phones_list = [p.to_dict() for p in phones]
        if phone is None:
            structured = {
                "ok": False,
                "phone": "",
                "udid": "",
                "state": "Unavailable",
                "width": 402,
                "height": 874,
                "scale": 3.0,
                "streamUrl": "",
                "snapshotUrl": "",
                "phones": phones_list,
                "sessionControlsInput": False,
            }
            return "目前尚未偵測到任何已註冊的 terminal-phone 模擬器。", structured

        self.bridge.active_phone = phone.name
        dims_task = asyncio.create_task(self.bridge.get_screen_dimensions(phone))
        session_task = asyncio.create_task(
            self.bridge.get_session_controls_input(phone.name)
        )
        (width, height, scale), controls_input = await asyncio.gather(
            dims_task, session_task
        )

        # Keep stream/snapshot URLs ready for the UI; never print tokens in text content.
        structured = {
            "ok": True,
            "phone": phone.name,
            "udid": phone.udid,
            "state": phone.state,
            "width": width,
            "height": height,
            "scale": scale,
            "streamUrl": self.http_server.stream_url(phone.name, fps=24, scale=0.5),
            "snapshotUrl": self.http_server.snapshot_url(phone.name),
            "phones": phones_list,
            "sessionControlsInput": controls_input,
        }
        scale_str = f"{scale:g}x"
        text = (
            f"已開啟 iPhone 互動預覽面板：{phone.name}"
            f"（狀態：{phone.state}，{width}×{height} pt @{scale_str}）。"
        )
        return text, structured

    async def _call_tool(
        self, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        args = arguments if isinstance(arguments, dict) else {}

        try:
            if name == "open_phone_pane":
                phone_arg = args.get("phone")
                phones = await self.bridge.list_phones()
                phone = await self.bridge.get_phone(
                    str(phone_arg) if phone_arg else None
                )
                if phone_arg and phone is None:
                    structured = {
                        "ok": False,
                        "phone": str(phone_arg),
                        "udid": "",
                        "state": "NotFound",
                        "width": 402,
                        "height": 874,
                        "scale": 3.0,
                        "streamUrl": "",
                        "snapshotUrl": "",
                        "phones": [p.to_dict() for p in phones],
                        "sessionControlsInput": False,
                    }
                    return {
                        "content": [
                            {"type": "text", "text": f"找不到指定的模擬器：{phone_arg}"}
                        ],
                        "structuredContent": structured,
                        "isError": True,
                    }
                text, structured = await self._build_pane_state(phone, phones)
                return {
                    "content": [{"type": "text", "text": text}],
                    "structuredContent": structured,
                    "isError": not structured["ok"],
                }

            if name == "app_list_phones":
                phones = await self.bridge.list_phones()
                if not self.bridge.active_phone and phones:
                    self.bridge.active_phone = phones[0].name
                structured = {
                    "ok": True,
                    "phones": [p.to_dict() for p in phones],
                    "activePhone": self.bridge.active_phone,
                }
                return {
                    "content": [
                        {"type": "text", "text": f"共 {len(phones)} 台裝置"}
                    ],
                    "structuredContent": structured,
                    "isError": False,
                }

            if name == "app_select_phone":
                target = str(args.get("phone") or "").strip()
                if not target:
                    raise ValueError("缺少必要參數 phone")
                should_boot = bool(args.get("boot", False))
                if should_boot:
                    phone = await self.bridge.boot_phone(target)
                else:
                    phone = await self.bridge.resolve_phone_or_raise(target)
                phones = await self.bridge.list_phones()
                # Refresh selected phone info from latest list.
                refreshed = next((p for p in phones if p.name == phone.name), phone)
                text, structured = await self._build_pane_state(refreshed, phones)
                return {
                    "content": [{"type": "text", "text": text}],
                    "structuredContent": structured,
                    "isError": not structured["ok"],
                }

            if name == "app_frame":
                phone_arg = args.get("phone")
                max_width = int(args.get("maxWidth", 480))
                quality = float(args.get("quality", 0.78))
                jpeg_bytes, width, height = await self.bridge.capture_jpeg(
                    str(phone_arg) if phone_arg else None,
                    max_width=max_width,
                    quality=quality,
                )
                b64 = base64.b64encode(jpeg_bytes).decode("ascii")
                captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                structured = {
                    "ok": True,
                    "mimeType": "image/jpeg",
                    "base64": b64,
                    "width": width,
                    "height": height,
                    "capturedAt": captured_at,
                }
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": f"frame {width}x{height} ({len(jpeg_bytes)} bytes)",
                        }
                    ],
                    "structuredContent": structured,
                    "isError": False,
                }

            if name == "app_tap":
                elapsed = await self.bridge.tap(
                    str(args["phone"]) if args.get("phone") else None,
                    float(args["x"]),
                    float(args["y"]),
                )
                structured = {"ok": True, "elapsedMs": elapsed}
                return {
                    "content": [{"type": "text", "text": f"tap ok ({elapsed} ms)"}],
                    "structuredContent": structured,
                    "isError": False,
                }

            if name == "app_swipe":
                elapsed = await self.bridge.swipe(
                    str(args["phone"]) if args.get("phone") else None,
                    float(args["x1"]),
                    float(args["y1"]),
                    float(args["x2"]),
                    float(args["y2"]),
                    float(args.get("duration", 0.25)),
                )
                structured = {"ok": True, "elapsedMs": elapsed}
                return {
                    "content": [{"type": "text", "text": f"swipe ok ({elapsed} ms)"}],
                    "structuredContent": structured,
                    "isError": False,
                }

            if name == "app_type":
                await self.bridge.type_text(
                    str(args["phone"]) if args.get("phone") else None,
                    str(args.get("text", "")),
                )
                return {
                    "content": [{"type": "text", "text": "type ok"}],
                    "structuredContent": {"ok": True},
                    "isError": False,
                }

            if name == "app_key":
                await self.bridge.press_key(
                    str(args["phone"]) if args.get("phone") else None,
                    str(args["key"]),
                )
                return {
                    "content": [{"type": "text", "text": "key ok"}],
                    "structuredContent": {"ok": True},
                    "isError": False,
                }

            if name == "app_button":
                await self.bridge.press_button(
                    str(args["phone"]) if args.get("phone") else None,
                    str(args["button"]),
                )
                return {
                    "content": [{"type": "text", "text": "button ok"}],
                    "structuredContent": {"ok": True},
                    "isError": False,
                }

            if name == "app_device_action":
                res = await self.bridge.device_action(
                    str(args["phone"]) if args.get("phone") else None,
                    str(args["action"]),
                )
                return {
                    "content": [
                        {"type": "text", "text": str(res.get("message") or "ok")}
                    ],
                    "structuredContent": res,
                    "isError": not bool(res.get("ok", True)),
                }

            return {
                "content": [{"type": "text", "text": f"未知的工具：{name}"}],
                "structuredContent": {"ok": False, "error": f"unknown tool: {name}"},
                "isError": True,
            }
        except KeyError as exc:
            msg = f"缺少必要參數：{exc}"
            return {
                "content": [{"type": "text", "text": msg}],
                "structuredContent": {"ok": False, "error": msg},
                "isError": True,
            }
        except Exception as exc:
            msg = str(exc)
            logger.warning("Tool %s error: %s", name, msg)
            return {
                "content": [{"type": "text", "text": msg}],
                "structuredContent": {"ok": False, "error": msg},
                "isError": True,
            }

    async def _handle_request(self, req: dict[str, Any]) -> None:
        req_id = req.get("id")
        has_id = "id" in req
        method = req.get("method")
        params = req.get("params") or {}

        if not isinstance(method, str):
            if has_id:
                await self._send_error(req_id, -32600, "Invalid Request")
            return

        # Notifications (no id) never get responses.
        if not has_id:
            if method == "notifications/initialized":
                logger.debug("MCP client initialized")
            elif method == "notifications/cancelled":
                target_id = params.get("requestId")
                task = self._inflight.get(target_id)
                if task is not None and not task.done():
                    task.cancel()
            return

        try:
            if method == "initialize":
                client_proto = params.get("protocolVersion")
                protocol_version = (
                    client_proto
                    if isinstance(client_proto, str) and client_proto
                    else "2025-03-26"
                )
                await self._send_result(
                    req_id,
                    {
                        "protocolVersion": protocol_version,
                        "capabilities": {
                            "tools": {},
                            "resources": {},
                        },
                        "serverInfo": {
                            "name": SERVER_NAME,
                            "version": SERVER_VERSION,
                        },
                    },
                )
                return

            if method == "ping":
                await self._send_result(req_id, {})
                return

            if method == "tools/list":
                await self._send_result(req_id, {"tools": TOOLS_SCHEMA})
                return

            if method == "tools/call":
                tool_name = params.get("name")
                tool_args = params.get("arguments") or {}
                if not isinstance(tool_name, str):
                    await self._send_error(req_id, -32602, "Invalid params: missing tool name")
                    return
                result = await self._call_tool(tool_name, tool_args)
                await self._send_result(req_id, result)
                return

            if method == "resources/list":
                resources: list[dict[str, Any]] = [
                    {
                        "uri": APP_RESOURCE_URI,
                        "name": "iPhone 互動預覽面板",
                        "description": "Antigravity iOS Simulator interactive preview UI",
                        "mimeType": APP_MIME_TYPE,
                        "_meta": self._ui_resource_meta(),
                    }
                ]
                for sid in self.bridge.list_screenshot_ids():
                    resources.append(
                        {
                            "uri": f"{SCREENSHOT_URI_PREFIX}{sid}",
                            "name": f"{sid}.png",
                            "description": "Saved iPhone simulator PNG screenshot",
                            "mimeType": "image/png",
                        }
                    )
                await self._send_result(req_id, {"resources": resources})
                return

            if method == "resources/templates/list":
                await self._send_result(
                    req_id,
                    {
                        "resourceTemplates": [
                            {
                                "uriTemplate": f"{SCREENSHOT_URI_PREFIX}{{id}}",
                                "name": "iPhone 模擬器截圖",
                                "description": "透過預覽面板儲存的高解析度 PNG 截圖",
                                "mimeType": "image/png",
                            }
                        ]
                    },
                )
                return

            if method == "resources/read":
                uri = params.get("uri")
                if not isinstance(uri, str) or not uri:
                    await self._send_error(req_id, -32602, "Invalid params: missing uri")
                    return

                if uri == APP_RESOURCE_URI:
                    html = await asyncio.to_thread(self._read_app_html)
                    await self._send_result(
                        req_id,
                        {
                            "contents": [
                                {
                                    "uri": APP_RESOURCE_URI,
                                    "mimeType": APP_MIME_TYPE,
                                    "text": html,
                                    "_meta": self._ui_resource_meta(),
                                }
                            ]
                        },
                    )
                    return

                if uri.startswith(SCREENSHOT_URI_PREFIX):
                    sid = uri[len(SCREENSHOT_URI_PREFIX) :]
                    png_bytes = await asyncio.to_thread(
                        self.bridge.read_screenshot_bytes, sid
                    )
                    if png_bytes is None:
                        await self._send_error(req_id, -32002, f"Resource not found: {uri}")
                        return
                    await self._send_result(
                        req_id,
                        {
                            "contents": [
                                {
                                    "uri": uri,
                                    "mimeType": "image/png",
                                    "blob": base64.b64encode(png_bytes).decode("ascii"),
                                }
                            ]
                        },
                    )
                    return

                await self._send_error(req_id, -32002, f"Resource not found: {uri}")
                return

            await self._send_error(req_id, -32601, f"Method not found: {method}")
        except asyncio.CancelledError:
            # Cancelled by notifications/cancelled or shutdown.
            raise
        except Exception as exc:
            logger.exception("Unhandled error for method %s", method)
            await self._send_error(req_id, -32603, f"Internal error: {exc}")

    async def run(self) -> None:
        await self.http_server.start()

        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, stop_event.set)

        reader = asyncio.StreamReader(limit=4 * 1024 * 1024)
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)

        async def read_loop() -> None:
            while not stop_event.is_set():
                line = await reader.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError as exc:
                    await self._send_error(None, -32700, f"Parse error: {exc}")
                    continue

                if not isinstance(msg, dict):
                    await self._send_error(None, -32600, "Invalid Request")
                    continue

                req_id = msg.get("id")
                has_id = "id" in msg

                if has_id:
                    task = asyncio.create_task(self._handle_request(msg))
                    self._inflight[req_id] = task

                    def _cleanup(t: asyncio.Task[None], rid: Any = req_id) -> None:
                        if self._inflight.get(rid) is t:
                            self._inflight.pop(rid, None)
                        with contextlib.suppress(asyncio.CancelledError):
                            exc = t.exception()
                            if exc is not None:
                                logger.error("Request task failed: %s", exc)

                    task.add_done_callback(_cleanup)
                else:
                    await self._handle_request(msg)

        read_task = asyncio.create_task(read_loop(), name="mcp-stdin-reader")
        stop_task = asyncio.create_task(stop_event.wait(), name="mcp-stop-signal")
        try:
            await asyncio.wait(
                [read_task, stop_task], return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for t in (read_task, stop_task):
                if not t.done():
                    t.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await t
            for task in list(self._inflight.values()):
                task.cancel()
            for task in list(self._inflight.values()):
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await asyncio.wait_for(task, timeout=2.0)
            self._inflight.clear()
            await self.http_server.stop()
            await self.bridge.shutdown()


def main() -> None:
    server = MCPPhonePaneServer()
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
