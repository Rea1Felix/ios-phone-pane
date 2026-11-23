"""Async bridge to terminal-phone simulators and Facebook idb_companion.

Reuses the existing idb_companion Unix domain sockets managed by terminal-phone
without disturbing running viewers, provides per-phone MJPEG fan-out streaming,
auto-reconnecting gRPC control sessions with strict timeouts, and simulator
lifecycle / screenshot helpers.

All diagnostics go strictly to stderr (never stdout, which carries MCP stdio).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import re
import secrets
import shutil
import socket
import stat
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, TypeVar

from idb.common import hid
from idb.common.types import (
    DomainSocketAddress,
    HIDButtonType,
    ScreenshotFormat,
    ScreenshotOptions,
    VideoFormat,
)
from idb.grpc.client import Client

logger = logging.getLogger("ios-phone-pane.bridge")

T = TypeVar("T")

TERMINAL_PHONE_BIN = (
    os.environ.get("TERMINAL_PHONE_BIN")
    or shutil.which("terminal-phone")
    or str(Path.home() / ".local" / "bin" / "terminal-phone")
)
TERMINAL_PHONE_HOME = Path(
    os.environ.get(
        "TERMINAL_PHONE_HOME",
        str(Path.home() / "Library" / "Application Support" / "terminal-phone"),
    )
)
IDB_COMPANION_BIN = (
    TERMINAL_PHONE_HOME / "dependencies" / "companion" / "idb_companion"
)
SOCK_DIR = Path(f"/tmp/terminal-phone-{os.getuid()}")
SCREENSHOTS_DIR = Path(f"/tmp/ios-phone-pane-{os.getuid()}") / "screenshots"
MAX_SAVED_SCREENSHOTS = 50

# USB HID usage IDs matching idb / Apple Simulator keyboard layout.
HID_KEYCODES: dict[str, int] = {
    "return": 40,
    "escape": 41,
    "backspace": 42,
    "tab": 43,
}

VALID_BUTTONS = frozenset({"HOME", "LOCK", "SIRI", "SIDE_BUTTON"})
SCREENSHOT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

# Keep app_frame / save_screenshot payloads well below Antigravity's 1 MiB
# CallToolResult cap (base64 expands raw bytes by ~4/3).
MAX_JPEG_RAW_BYTES = 580_000
MAX_INLINE_PNG_RAW_BYTES = 600_000


@dataclass(frozen=True)
class PhoneInfo:
    name: str
    udid: str
    state: str
    kind: str
    device_type: str
    runtime: str

    def to_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "udid": self.udid,
            "state": self.state,
            "kind": self.kind,
            "deviceType": self.device_type,
            "runtime": self.runtime,
        }


def _default_dimensions_for_device(device_type: str) -> tuple[int, int, float]:
    dt = (device_type or "").lower()
    if "pro-max" in dt or "plus" in dt:
        return (440, 956, 3.0)
    if "se" in dt:
        return (375, 667, 2.0)
    if "mini" in dt:
        return (375, 812, 3.0)
    if "ipad" in dt:
        return (820, 1180, 2.0)
    # Modern iPhone Pro (16/17/18 Pro) default
    return (402, 874, 3.0)


def _is_unix_socket_alive(sock_path: Path, timeout: float = 0.6) -> bool:
    if not sock_path.exists():
        return False
    try:
        st = sock_path.stat()
        if not stat.S_ISSOCK(st.st_mode):
            return False
    except OSError:
        return False

    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(str(sock_path))
        return True
    except OSError:
        return False
    finally:
        with contextlib.suppress(OSError):
            s.close()


async def _run_subprocess(
    args: list[str],
    *,
    timeout: float = 15.0,
    stdin_bytes: bytes | None = None,
) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE if stdin_bytes is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=stdin_bytes), timeout=timeout
        )
        return proc.returncode or 0, stdout, stderr
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        raise TimeoutError(f"Command timed out after {timeout}s: {' '.join(args)}")


class _ControlClient:
    """Persistent, serialized, auto-reconnecting idb gRPC client for one UDID."""

    def __init__(self, bridge: "IDBBridge", udid: str, phone_name: str) -> None:
        self._bridge = bridge
        self.udid = udid
        self.phone_name = phone_name
        self._lock = asyncio.Lock()
        self._cm: Any = None
        self._client: Client | None = None

    async def _close_unlocked(self) -> None:
        cm = self._cm
        self._cm = None
        self._client = None
        if cm is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(cm.__aexit__(None, None, None), timeout=2.5)

    async def close(self) -> None:
        async with self._lock:
            await self._close_unlocked()

    async def _ensure_connected_unlocked(self) -> Client:
        if self._client is not None:
            return self._client
        sock_path = await self._bridge.ensure_companion(self.udid, self.phone_name)
        idb_logger = logging.getLogger(f"ios-phone-pane.idb.{self.phone_name}")
        idb_logger.setLevel(logging.ERROR)
        cm = Client.build(
            address=DomainSocketAddress(path=str(sock_path)),
            logger=idb_logger,
        )
        client = await asyncio.wait_for(cm.__aenter__(), timeout=10.0)
        if client.companion.udid.upper() != self.udid.upper():
            with contextlib.suppress(Exception):
                await cm.__aexit__(None, None, None)
            raise RuntimeError(
                f"Companion UDID mismatch: expected {self.udid}, got {client.companion.udid}"
            )
        self._cm = cm
        self._client = client
        return client

    async def run(
        self,
        fn: Callable[[Client], Awaitable[T]],
        *,
        timeout: float = 12.0,
        retry_on_disconnect: bool = False,
    ) -> T:
        async with self._lock:
            attempts = 2 if retry_on_disconnect else 1
            last_exc: Exception | None = None
            for attempt in range(attempts):
                try:
                    client = await self._ensure_connected_unlocked()
                    return await asyncio.wait_for(fn(client), timeout=timeout)
                except asyncio.CancelledError:
                    await self._close_unlocked()
                    raise
                except Exception as exc:
                    last_exc = exc
                    logger.warning(
                        "idb RPC failed for %s (attempt %d/%d): %s",
                        self.phone_name,
                        attempt + 1,
                        attempts,
                        exc,
                    )
                    await self._close_unlocked()
                    if attempt + 1 < attempts:
                        await asyncio.sleep(0.15)
                        continue
                    raise
            assert last_exc is not None
            raise last_exc


class _StreamHub:
    """Single upstream idb MJPEG stream per UDID fanning out to N HTTP clients."""

    IDLE_GRACE_SECONDS = 3.0

    def __init__(self, bridge: "IDBBridge", udid: str, phone_name: str) -> None:
        self._bridge = bridge
        self.udid = udid
        self.phone_name = phone_name
        self._subscribers: set[asyncio.Queue[bytes | None]] = set()
        self._pump_task: asyncio.Task[None] | None = None
        self._idle_timer: asyncio.TimerHandle | None = None
        self._stopping = False
        self._fps: int = 24
        self._scale: float = 0.5
        self.latest_frame: bytes | None = None
        self.latest_frame_at: float = 0.0

    def subscribe(self, fps: int = 24, scale: float = 0.5) -> asyncio.Queue[bytes | None]:
        self._stopping = False
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

        q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=2)
        if not self._subscribers and (self._pump_task is None or self._pump_task.done()):
            self._fps = max(1, min(30, int(fps)))
            self._scale = max(0.2, min(1.0, float(scale)))

        self._subscribers.add(q)

        # Immediately seed a fresh cached frame (<2s old) so UI paints instantaneously.
        if self.latest_frame is not None and (time.monotonic() - self.latest_frame_at) < 2.0:
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(self.latest_frame)

        if self._pump_task is None or self._pump_task.done():
            self._pump_task = asyncio.create_task(
                self._pump_loop(), name=f"mjpeg-pump-{self.phone_name}"
            )
        return q

    def unsubscribe(self, q: asyncio.Queue[bytes | None]) -> None:
        self._subscribers.discard(q)
        if not self._subscribers and not self._stopping:
            loop = asyncio.get_running_loop()
            if self._idle_timer is not None:
                self._idle_timer.cancel()
            self._idle_timer = loop.call_later(
                self.IDLE_GRACE_SECONDS, self._on_idle_timeout
            )

    def _on_idle_timeout(self) -> None:
        self._idle_timer = None
        if not self._subscribers and self._pump_task is not None and not self._pump_task.done():
            logger.info("Stopping idle MJPEG upstream for %s", self.phone_name)
            self._pump_task.cancel()

    def _broadcast(self, frame: bytes | None) -> None:
        if frame is not None:
            self.latest_frame = frame
            self.latest_frame_at = time.monotonic()
        for q in list(self._subscribers):
            if frame is None:
                # Signal EOF cleanly to all subscribers.
                while not q.empty():
                    with contextlib.suppress(asyncio.QueueEmpty):
                        q.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    q.put_nowait(None)
            else:
                if q.full():
                    with contextlib.suppress(asyncio.QueueEmpty):
                        q.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    q.put_nowait(frame)

    async def stop(self) -> None:
        self._stopping = True
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None
        self._broadcast(None)
        self._subscribers.clear()
        task = self._pump_task
        self._pump_task = None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(task, timeout=3.0)

    async def _pump_loop(self) -> None:
        backoff = 0.5
        try:
            while not self._stopping:
                if not self._subscribers and self._idle_timer is None:
                    break
                try:
                    sock_path = await self._bridge.ensure_companion(
                        self.udid, self.phone_name
                    )
                    idb_logger = logging.getLogger(
                        f"ios-phone-pane.stream.{self.phone_name}"
                    )
                    idb_logger.setLevel(logging.ERROR)
                    async with Client.build(
                        address=DomainSocketAddress(path=str(sock_path)),
                        logger=idb_logger,
                    ) as client:
                        if client.companion.udid.upper() != self.udid.upper():
                            raise RuntimeError("Companion UDID mismatch during stream")

                        gen = client.stream_video(
                            output_file=None,
                            fps=self._fps,
                            format=VideoFormat.MJPEG,
                            compression_quality=0.82,
                            scale_factor=self._scale,
                        )
                        pending = bytearray()
                        backoff = 0.5
                        try:
                            async for chunk in gen:
                                if self._stopping:
                                    break
                                if not self._subscribers and self._idle_timer is None:
                                    break
                                pending.extend(chunk)
                                while True:
                                    start = pending.find(b"\xff\xd8")
                                    if start < 0:
                                        if len(pending) > 1:
                                            del pending[:-1]
                                        break
                                    end = pending.find(b"\xff\xd9", start + 2)
                                    if end < 0:
                                        if len(pending) > 16 * 1024 * 1024:
                                            raise RuntimeError("Oversized MJPEG frame")
                                        break
                                    frame = bytes(pending[start : end + 2])
                                    del pending[: end + 2]
                                    self._broadcast(frame)
                        finally:
                            # Explicitly close stream_video generator BEFORE the
                            # Client context manager tears down the gRPC channel,
                            # avoiding unretrieved StreamTerminatedError exceptions.
                            with contextlib.suppress(Exception):
                                await asyncio.wait_for(gen.aclose(), timeout=1.5)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning(
                        "MJPEG stream error for %s: %s (retrying in %.1fs)",
                        self.phone_name,
                        exc,
                        backoff,
                    )
                    if not self._subscribers:
                        break
                    # Check whether simulator is still Booted; if not, end client streams.
                    try:
                        info = await self._bridge.get_phone(self.phone_name)
                        if info is None or info.state != "Booted":
                            logger.info(
                                "Simulator %s is no longer Booted; closing MJPEG stream",
                                self.phone_name,
                            )
                            self._broadcast(None)
                            break
                    except Exception:
                        pass
                    await asyncio.sleep(backoff)
                    backoff = min(2.0, backoff * 1.5)
        except asyncio.CancelledError:
            pass
        finally:
            logger.debug("MJPEG pump exited for %s", self.phone_name)


class IDBBridge:
    """Coordinates phone discovery, companion sockets, streams, and actions."""

    def __init__(self) -> None:
        self.active_phone: str | None = None
        self._controls: dict[str, _ControlClient] = {}
        self._streams: dict[str, _StreamHub] = {}
        self._companion_locks: dict[str, asyncio.Lock] = {}
        self._dimensions_cache: dict[str, tuple[int, int, float]] = {}
        self._screenshots: dict[str, Path] = {}
        self._ensure_screenshots_dir()

    def _ensure_screenshots_dir(self) -> None:
        SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(SCREENSHOTS_DIR.parent, 0o700)
            os.chmod(SCREENSHOTS_DIR, 0o700)
        # Re-index any existing screenshots in temp dir across restarts.
        for path in sorted(SCREENSHOTS_DIR.glob("*.png"), key=lambda p: p.stat().st_mtime):
            sid = path.stem
            if SCREENSHOT_ID_RE.match(sid):
                self._screenshots[sid] = path

    async def shutdown(self) -> None:
        for hub in list(self._streams.values()):
            await hub.stop()
        self._streams.clear()
        for ctrl in list(self._controls.values()):
            await ctrl.close()
        self._controls.clear()

    def _get_companion_lock(self, udid: str) -> asyncio.Lock:
        key = udid.upper()
        lock = self._companion_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._companion_locks[key] = lock
        return lock

    def _get_control(self, phone: PhoneInfo) -> _ControlClient:
        key = phone.udid.upper()
        ctrl = self._controls.get(key)
        if ctrl is None:
            ctrl = _ControlClient(self, phone.udid, phone.name)
            self._controls[key] = ctrl
        else:
            ctrl.phone_name = phone.name
        return ctrl

    def get_stream_hub(self, phone: PhoneInfo) -> _StreamHub:
        key = phone.udid.upper()
        hub = self._streams.get(key)
        if hub is None:
            hub = _StreamHub(self, phone.udid, phone.name)
            self._streams[key] = hub
        else:
            hub.phone_name = phone.name
        return hub

    async def _close_udid_handles(self, udid: str) -> None:
        key = udid.upper()
        hub = self._streams.pop(key, None)
        if hub is not None:
            await hub.stop()
        ctrl = self._controls.pop(key, None)
        if ctrl is not None:
            await ctrl.close()

    async def _get_simctl_devices(self) -> dict[str, dict[str, Any]]:
        """Map UDID (upper) -> {state, deviceType, runtime, name}."""
        try:
            rc, stdout, _ = await _run_subprocess(
                ["xcrun", "simctl", "list", "devices", "-j"], timeout=8.0
            )
            if rc != 0:
                return {}
            data = json.loads(stdout.decode("utf-8", errors="replace"))
        except Exception as exc:
            logger.warning("simctl list devices failed: %s", exc)
            return {}

        devices_by_udid: dict[str, dict[str, Any]] = {}
        for runtime_id, dev_list in (data.get("devices") or {}).items():
            for dev in dev_list or []:
                udid = str(dev.get("udid") or "").upper()
                if not udid:
                    continue
                devices_by_udid[udid] = {
                    "state": str(dev.get("state") or "Unknown"),
                    "deviceType": str(dev.get("deviceTypeIdentifier") or ""),
                    "runtime": str(runtime_id or ""),
                    "name": str(dev.get("name") or ""),
                    "isAvailable": bool(dev.get("isAvailable", True)),
                }
        return devices_by_udid

    async def list_phones(self) -> list[PhoneInfo]:
        sim_map = await self._get_simctl_devices()
        phones_dir = TERMINAL_PHONE_HOME / "phones"
        records: list[PhoneInfo] = []
        seen_names: set[str] = set()

        if phones_dir.is_dir():
            for child in sorted(phones_dir.iterdir()):
                pj = child / "phone.json"
                if not pj.is_file():
                    continue
                try:
                    raw = json.loads(pj.read_text(encoding="utf-8"))
                except Exception as exc:
                    logger.warning("Failed to parse %s: %s", pj, exc)
                    continue

                name = str(raw.get("name") or child.name)
                udid = str(raw.get("udid") or "")
                kind = str(raw.get("kind") or ("device" if raw.get("deviceId") else "simulator"))
                sim_info = sim_map.get(udid.upper())
                state = sim_info["state"] if sim_info else str(raw.get("state") or "Shutdown")
                device_type = str(
                    raw.get("deviceType")
                    or (sim_info["deviceType"] if sim_info else "")
                )
                runtime = str(
                    raw.get("runtime")
                    or (sim_info["runtime"] if sim_info else "")
                )
                records.append(
                    PhoneInfo(
                        name=name,
                        udid=udid,
                        state=state,
                        kind=kind,
                        device_type=device_type,
                        runtime=runtime,
                    )
                )
                seen_names.add(name)

        # Fallback to `terminal-phone list` if phone.json directory had nothing.
        if not records and os.path.exists(TERMINAL_PHONE_BIN):
            try:
                rc, stdout, _ = await _run_subprocess(
                    [TERMINAL_PHONE_BIN, "list"], timeout=8.0
                )
                if rc == 0 and stdout.strip():
                    parsed = json.loads(stdout.decode("utf-8", errors="replace"))
                    if isinstance(parsed, list):
                        for item in parsed:
                            name = str(item.get("name") or "")
                            if not name or name in seen_names:
                                continue
                            udid = str(item.get("udid") or "")
                            sim_info = sim_map.get(udid.upper())
                            records.append(
                                PhoneInfo(
                                    name=name,
                                    udid=udid,
                                    state=sim_info["state"]
                                    if sim_info
                                    else str(item.get("state") or "Unknown"),
                                    kind=str(item.get("kind") or "simulator"),
                                    device_type=str(
                                        item.get("deviceType")
                                        or (sim_info["deviceType"] if sim_info else "")
                                    ),
                                    runtime=str(
                                        item.get("runtime")
                                        or (sim_info["runtime"] if sim_info else "")
                                    ),
                                )
                            )
                            seen_names.add(name)
            except Exception as exc:
                logger.warning("terminal-phone list fallback failed: %s", exc)

        # Sort Booted phones first, then alphabetical by name.
        records.sort(key=lambda p: (0 if p.state == "Booted" else 1, p.name.lower()))
        return records

    async def get_phone(self, name: str | None = None) -> PhoneInfo | None:
        phones = await self.list_phones()
        if not phones:
            return None
        target = (name or "").strip()
        if target:
            for p in phones:
                if p.name == target or p.udid.upper() == target.upper():
                    return p
            return None

        # Auto-select: prefer previously active phone if Booted, then first Booted
        # simulator, then previously active phone, else first registered phone.
        if self.active_phone:
            for p in phones:
                if p.name == self.active_phone and p.state == "Booted":
                    return p
        for p in phones:
            if p.state == "Booted" and p.kind == "simulator":
                return p
        for p in phones:
            if p.state == "Booted":
                return p
        if self.active_phone:
            for p in phones:
                if p.name == self.active_phone:
                    return p
        return phones[0]

    async def resolve_phone_or_raise(self, name: str | None = None) -> PhoneInfo:
        phone = await self.get_phone(name)
        if phone is None:
            if name:
                raise RuntimeError(f"找不到指定的模擬器或裝置：{name}")
            raise RuntimeError("目前尚未註冊任何 terminal-phone 裝置。")
        return phone

    async def get_session_controls_input(self, phone_name: str) -> bool:
        if not os.path.exists(TERMINAL_PHONE_BIN):
            return False
        try:
            rc, stdout, _ = await _run_subprocess(
                [TERMINAL_PHONE_BIN, "session", "status", phone_name],
                timeout=3.5,
            )
            if rc != 0 or not stdout.strip():
                return False
            data = json.loads(stdout.decode("utf-8", errors="replace"))
            session = data.get("session")
            if isinstance(session, dict):
                return bool(session.get("controlsInput", False))
        except Exception as exc:
            logger.debug("session status check failed for %s: %s", phone_name, exc)
        return False

    async def ensure_companion(self, udid: str, phone_name: str) -> Path:
        sock_path = SOCK_DIR / f"{udid}.sock"
        # Fast path: reuse already-running idb_companion socket untouched!
        if await asyncio.to_thread(_is_unix_socket_alive, sock_path):
            return sock_path

        async with self._get_companion_lock(udid):
            if await asyncio.to_thread(_is_unix_socket_alive, sock_path):
                return sock_path

            # Verify simulator is actually Booted before spawning companion.
            sim_map = await self._get_simctl_devices()
            sim_info = sim_map.get(udid.upper())
            if sim_info is not None and sim_info.get("state") != "Booted":
                raise RuntimeError(
                    f"模擬器 {phone_name} 尚未啟動（目前狀態：{sim_info.get('state')}）。"
                )

            SOCK_DIR.mkdir(parents=True, exist_ok=True)
            with contextlib.suppress(OSError):
                os.chmod(SOCK_DIR, 0o700)

            # Remove dead/stale socket file if present and refused connections.
            if sock_path.exists():
                try:
                    st = sock_path.stat()
                    if stat.S_ISSOCK(st.st_mode) and not _is_unix_socket_alive(sock_path):
                        sock_path.unlink(missing_ok=True)
                except OSError:
                    pass

            if IDB_COMPANION_BIN.is_file():
                logger.info(
                    "Starting idb_companion for %s (%s) at %s",
                    phone_name,
                    udid,
                    sock_path,
                )
                subprocess.Popen(
                    [
                        str(IDB_COMPANION_BIN),
                        "--udid",
                        udid,
                        "--grpc-domain-sock",
                        str(sock_path),
                        "--terminate-offline",
                        "1",
                        "--idle-shutdown-time",
                        "600",
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                deadline = time.monotonic() + 10.0
                while time.monotonic() < deadline:
                    if await asyncio.to_thread(_is_unix_socket_alive, sock_path):
                        return sock_path
                    await asyncio.sleep(0.15)

            # Fallback: let terminal-phone bring up companion via capabilities.
            if os.path.exists(TERMINAL_PHONE_BIN):
                logger.info(
                    "Falling back to terminal-phone capabilities %s to ensure companion",
                    phone_name,
                )
                with contextlib.suppress(Exception):
                    await _run_subprocess(
                        [TERMINAL_PHONE_BIN, "capabilities", phone_name], timeout=12.0
                    )
                if await asyncio.to_thread(_is_unix_socket_alive, sock_path):
                    return sock_path

            raise RuntimeError(
                f"無法連線至 idb_companion（{phone_name} / {sock_path}）。"
            )

    async def get_screen_dimensions(self, phone: PhoneInfo) -> tuple[int, int, float]:
        key = phone.udid.upper()
        if phone.state == "Booted":
            try:
                ctrl = self._get_control(phone)
                desc = await ctrl.run(
                    lambda c: c.describe(),
                    timeout=10.0,
                    retry_on_disconnect=True,
                )
                sd = desc.screen_dimensions
                if sd is not None:
                    scale = float(sd.density or 3.0)
                    w_pt = int(sd.width_points or round((sd.width or 1206) / scale))
                    h_pt = int(sd.height_points or round((sd.height or 2622) / scale))
                    if w_pt > 0 and h_pt > 0:
                        self._dimensions_cache[key] = (w_pt, h_pt, scale)
                        return (w_pt, h_pt, scale)
            except Exception as exc:
                logger.warning("describe() failed for %s: %s", phone.name, exc)

        if key in self._dimensions_cache:
            return self._dimensions_cache[key]
        return _default_dimensions_for_device(phone.device_type)

    async def capture_jpeg(
        self,
        phone_name: str | None = None,
        *,
        max_width: int = 480,
        quality: float = 0.78,
    ) -> tuple[bytes, int, int]:
        phone = await self.resolve_phone_or_raise(phone_name)
        if phone.state != "Booted":
            raise RuntimeError(f"模擬器 {phone.name} 尚未啟動（目前狀態：{phone.state}）。")

        clamped_w = max(120, min(900, int(max_width)))
        q = float(quality)
        if q > 1.0:
            q = q / 100.0
        clamped_q = max(0.2, min(0.95, q))

        ctrl = self._get_control(phone)
        shot = await ctrl.run(
            lambda c: c.screenshot(
                ScreenshotOptions(
                    format=ScreenshotFormat.JPEG,
                    compression_quality=clamped_q,
                    max_width=clamped_w,
                )
            ),
            timeout=12.0,
            retry_on_disconnect=True,
        )
        raw = bytes(shot)
        width = int(shot.width or clamped_w)
        height = int(shot.height or 0)

        # Ensure payload stays well below Antigravity's 1 MiB CallToolResult limit.
        if len(raw) > MAX_JPEG_RAW_BYTES:
            retry_w = min(clamped_w, 390)
            retry_q = min(clamped_q, 0.58)
            shot = await ctrl.run(
                lambda c: c.screenshot(
                    ScreenshotOptions(
                        format=ScreenshotFormat.JPEG,
                        compression_quality=retry_q,
                        max_width=retry_w,
                    )
                ),
                timeout=12.0,
                retry_on_disconnect=True,
            )
            raw = bytes(shot)
            width = int(shot.width or retry_w)
            height = int(shot.height or 0)

        return raw, width, height

    async def capture_png_and_save(
        self, phone_name: str | None = None
    ) -> tuple[str, Path, bytes]:
        phone = await self.resolve_phone_or_raise(phone_name)
        if phone.state != "Booted":
            raise RuntimeError(f"模擬器 {phone.name} 尚未啟動（目前狀態：{phone.state}）。")

        self._ensure_screenshots_dir()
        safe_name = re.sub(r"[^A-Za-z0-9_-]+", "-", phone.name).strip("-") or "phone"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        screenshot_id = f"{safe_name}-{stamp}-{secrets.token_hex(3)}"
        out_path = SCREENSHOTS_DIR / f"{screenshot_id}.png"

        png_bytes: bytes | None = None
        try:
            ctrl = self._get_control(phone)
            shot = await ctrl.run(
                lambda c: c.screenshot(ScreenshotOptions(format=ScreenshotFormat.PNG)),
                timeout=12.0,
                retry_on_disconnect=True,
            )
            png_bytes = bytes(shot)
            await asyncio.to_thread(out_path.write_bytes, png_bytes)
        except Exception as exc:
            logger.warning(
                "idb PNG screenshot failed for %s (%s); falling back to simctl io",
                phone.name,
                exc,
            )
            rc, _, stderr = await _run_subprocess(
                ["xcrun", "simctl", "io", phone.udid, "screenshot", "--type=png", str(out_path)],
                timeout=15.0,
            )
            if rc != 0 or not out_path.is_file():
                raise RuntimeError(
                    f"截圖失敗：{stderr.decode('utf-8', errors='replace').strip() or exc}"
                )
            png_bytes = await asyncio.to_thread(out_path.read_bytes)

        self._screenshots[screenshot_id] = out_path
        self._prune_old_screenshots()
        return screenshot_id, out_path, png_bytes

    def _prune_old_screenshots(self) -> None:
        if len(self._screenshots) <= MAX_SAVED_SCREENSHOTS:
            return
        items = list(self._screenshots.items())
        for sid, path in items[:-MAX_SAVED_SCREENSHOTS]:
            self._screenshots.pop(sid, None)
            with contextlib.suppress(OSError):
                path.unlink(missing_ok=True)

    def list_screenshot_ids(self) -> list[str]:
        return list(self._screenshots.keys())

    def read_screenshot_bytes(self, screenshot_id: str) -> bytes | None:
        if not SCREENSHOT_ID_RE.match(screenshot_id):
            return None
        path = self._screenshots.get(screenshot_id)
        if path is None:
            candidate = SCREENSHOTS_DIR / f"{screenshot_id}.png"
            if candidate.is_file():
                path = candidate
                self._screenshots[screenshot_id] = candidate
        if path is None or not path.is_file():
            return None
        return path.read_bytes()

    async def tap(self, phone_name: str | None, x: float, y: float) -> float:
        phone = await self.resolve_phone_or_raise(phone_name)
        if phone.state != "Booted":
            raise RuntimeError(f"模擬器 {phone.name} 尚未啟動。")
        ctrl = self._get_control(phone)
        started = time.monotonic()
        await ctrl.run(
            lambda c: c.tap(float(x), float(y)),
            timeout=12.0,
            retry_on_disconnect=False,
        )
        return round((time.monotonic() - started) * 1000.0, 1)

    async def swipe(
        self,
        phone_name: str | None,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.25,
    ) -> float:
        phone = await self.resolve_phone_or_raise(phone_name)
        if phone.state != "Booted":
            raise RuntimeError(f"模擬器 {phone.name} 尚未啟動。")
        clamped_dur = max(0.05, min(3.0, float(duration)))
        p_start = (int(round(x1)), int(round(y1)))
        p_end = (int(round(x2)), int(round(y2)))
        ctrl = self._get_control(phone)
        started = time.monotonic()
        await ctrl.run(
            lambda c: c.swipe(p_start, p_end, duration=clamped_dur),
            timeout=12.0,
            retry_on_disconnect=False,
        )
        return round((time.monotonic() - started) * 1000.0, 1)

    async def type_text(self, phone_name: str | None, text: str) -> None:
        if not text:
            return
        phone = await self.resolve_phone_or_raise(phone_name)
        if phone.state != "Booted":
            raise RuntimeError(f"模擬器 {phone.name} 尚未啟動。")
        ctrl = self._get_control(phone)

        if all(ch in hid.KEY_MAP for ch in text):
            await ctrl.run(
                lambda c: c.text(text),
                timeout=12.0,
                retry_on_disconnect=False,
            )
            return

        # Unicode / CJK fallback: copy to simulator pasteboard and send Cmd+V.
        rc, _, stderr = await _run_subprocess(
            ["xcrun", "simctl", "pbcopy", phone.udid],
            timeout=8.0,
            stdin_bytes=text.encode("utf-8"),
        )
        if rc != 0:
            raise RuntimeError(
                f"寫入模擬器剪貼簿失敗：{stderr.decode('utf-8', errors='replace').strip()}"
            )
        await asyncio.sleep(0.06)
        paste_events = hid.key_press_with_modifiers_to_events(25, ["command"])
        await ctrl.run(
            lambda c: c.send_events(paste_events),
            timeout=12.0,
            retry_on_disconnect=False,
        )

    async def press_key(self, phone_name: str | None, key: str) -> None:
        key_norm = (key or "").strip().lower()
        keycode = HID_KEYCODES.get(key_norm)
        if keycode is None:
            raise ValueError(
                f"不支援的按鍵：{key!r}（僅支援 {', '.join(sorted(HID_KEYCODES))}）"
            )
        phone = await self.resolve_phone_or_raise(phone_name)
        if phone.state != "Booted":
            raise RuntimeError(f"模擬器 {phone.name} 尚未啟動。")
        ctrl = self._get_control(phone)
        await ctrl.run(
            lambda c: c.key(keycode),
            timeout=12.0,
            retry_on_disconnect=False,
        )

    async def press_button(self, phone_name: str | None, button: str) -> None:
        btn_norm = (button or "").strip().upper()
        if btn_norm not in VALID_BUTTONS:
            raise ValueError(
                f"不支援的實體按鍵：{button!r}（僅支援 {', '.join(sorted(VALID_BUTTONS))}）"
            )
        phone = await self.resolve_phone_or_raise(phone_name)
        if phone.state != "Booted":
            raise RuntimeError(f"模擬器 {phone.name} 尚未啟動。")
        ctrl = self._get_control(phone)
        btn_enum = HIDButtonType[btn_norm]
        await ctrl.run(
            lambda c: c.button(btn_enum),
            timeout=12.0,
            retry_on_disconnect=False,
        )

    async def boot_phone(self, phone_name: str) -> PhoneInfo:
        phone = await self.resolve_phone_or_raise(phone_name)
        if phone.state != "Booted":
            rc, stdout, stderr = await _run_subprocess(
                [TERMINAL_PHONE_BIN, "up", phone.name, "--no-view"],
                timeout=90.0,
            )
            if rc != 0:
                msg = (
                    stderr.decode("utf-8", errors="replace").strip()
                    or stdout.decode("utf-8", errors="replace").strip()
                    or f"exit code {rc}"
                )
                raise RuntimeError(f"啟動模擬器 {phone.name} 失敗：{msg}")
        refreshed = await self.resolve_phone_or_raise(phone.name)
        if refreshed.state == "Booted":
            with contextlib.suppress(Exception):
                await self.ensure_companion(refreshed.udid, refreshed.name)
        return refreshed

    async def stop_phone(self, phone_name: str) -> PhoneInfo:
        phone = await self.resolve_phone_or_raise(phone_name)
        await self._close_udid_handles(phone.udid)
        rc, stdout, stderr = await _run_subprocess(
            [TERMINAL_PHONE_BIN, "stop", phone.name],
            timeout=30.0,
        )
        if rc != 0:
            msg = (
                stderr.decode("utf-8", errors="replace").strip()
                or stdout.decode("utf-8", errors="replace").strip()
                or f"exit code {rc}"
            )
            raise RuntimeError(f"停止模擬器 {phone.name} 失敗：{msg}")
        return await self.resolve_phone_or_raise(phone.name)

    async def device_action(
        self, phone_name: str | None, action: str
    ) -> dict[str, Any]:
        act = (action or "").strip().lower()
        phone = await self.resolve_phone_or_raise(phone_name)

        if act == "boot":
            refreshed = await self.boot_phone(phone.name)
            self.active_phone = refreshed.name
            return {
                "ok": True,
                "state": refreshed.state,
                "message": f"模擬器 {refreshed.name} 已啟動。",
            }

        if act == "stop":
            refreshed = await self.stop_phone(phone.name)
            return {
                "ok": True,
                "state": refreshed.state,
                "message": f"模擬器 {refreshed.name} 已停止。",
            }

        if act == "release_session":
            rc, stdout, stderr = await _run_subprocess(
                [TERMINAL_PHONE_BIN, "session", "release", phone.name],
                timeout=10.0,
            )
            if rc != 0:
                msg = (
                    stderr.decode("utf-8", errors="replace").strip()
                    or stdout.decode("utf-8", errors="replace").strip()
                    or f"exit code {rc}"
                )
                return {
                    "ok": False,
                    "state": phone.state,
                    "message": f"釋放控制權失敗：{msg}",
                }
            return {
                "ok": True,
                "state": phone.state,
                "message": f"已釋放 {phone.name} 的 Agent 輸入控制權。",
            }

        if act in ("dark", "light"):
            if phone.state != "Booted":
                raise RuntimeError(f"模擬器 {phone.name} 尚未啟動，無法切換外觀。")
            rc, _, stderr = await _run_subprocess(
                ["xcrun", "simctl", "ui", phone.udid, "appearance", act],
                timeout=8.0,
            )
            if rc != 0 and os.path.exists(TERMINAL_PHONE_BIN):
                rc, _, stderr = await _run_subprocess(
                    [TERMINAL_PHONE_BIN, "sim", phone.name, "appearance", act],
                    timeout=10.0,
                )
            if rc != 0:
                raise RuntimeError(
                    f"切換外觀失敗：{stderr.decode('utf-8', errors='replace').strip()}"
                )
            label = "深色" if act == "dark" else "淺色"
            return {
                "ok": True,
                "state": phone.state,
                "message": f"已將 {phone.name} 切換為{label}外觀。",
            }

        if act == "save_screenshot":
            sid, out_path, png_bytes = await self.capture_png_and_save(phone.name)
            result: dict[str, Any] = {
                "ok": True,
                "state": phone.state,
                "message": f"已儲存截圖至 {out_path}",
                "screenshotId": sid,
                "screenshotUri": f"ios-phone://screenshot/{sid}",
                "screenshotPath": str(out_path),
            }
            if len(png_bytes) <= MAX_INLINE_PNG_RAW_BYTES:
                result["base64"] = base64.b64encode(png_bytes).decode("ascii")
            return result

        raise ValueError(
            f"不支援的裝置動作：{action!r}（支援 boot, stop, release_session, dark, light, save_screenshot）"
        )
