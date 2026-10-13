"""Screenshot Gallery - browse, favorite, sort, filter, edit and share your Steam screenshots from Gaming Mode.

Steam keeps screenshots in  <Steam>/userdata/<account id>/760/remote/<app id>/screenshots/  (with a
`thumbnails` folder next to them). This plugin reads that folder; it never edits Steam's own index
(screenshots.vdf) and, since 1.7.0, it can no longer delete or move any screenshot: there is no delete,
clean-up or empty-the-trash code left in it. (Screenshots that an older version moved to the trash can still be restored.)

Only os, re, json, time, asyncio and typing are imported at the top (and `socket`, only when 'Send to phone' needs the network address): Decky's bundled Python may lack other standard
modules, and a missing one would stop the whole backend from starting.
"""
import asyncio
import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import decky

log = decky.logger

IMG_EXT = (".jpg", ".jpeg", ".png")
TAKEN_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(\d+)\.")
THUMB_MAX = 250_000             # bytes: larger thumbnails are not sent
FULL_MAX = 5_000_000            # bytes: larger screenshots are shown as their thumbnail
EDIT_MAX = 12_000_000           # bytes: the largest screenshot the editor will open
SAVE_MAX = 40_000_000           # characters of base64: the largest edited picture that is accepted
ART_MAX = 5_000_000             # bytes: Steam's limit for an artwork file ("File size cannot exceed 5 MB")
CEF_PORT = 8080                 # Steam's browser debugging port (Decky needs it too)
ART_URL = "steamcommunity.com/sharedfiles/edititem/"
PAGE = 30
THUMB_PX = 480                  # width of the grid thumbnails we make ourselves (Steam's own are only ~200 px wide)
THUMB_FALLBACK_MAX = 900_000    # bytes: without an image library, a screenshot up to this size is sent as is
CHUNK = 1 << 20
FAV_MAX = 5000
ALBUM_MAX = 60                  # albums
ALBUM_SHOTS_MAX = 3000          # screenshots per album
PHONE_SECONDS = 600             # how long 'send to phone' stays open
PHONE_MAX = 300                 # screenshots in one send-to-phone session
EDITED_APP = -1                 # pictures saved by the editor whose game isn't known

_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def b64(data: bytes) -> str:
    """Base64 without importing base64 (one less module Decky's Python might not have)."""
    out = []
    n = len(data)
    i = 0
    tbl = _B64
    while i + 2 < n:
        v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
        out.append(tbl[v >> 18] + tbl[(v >> 12) & 63] + tbl[(v >> 6) & 63] + tbl[v & 63])
        i += 3
    rest = n - i
    if rest == 1:
        v = data[i] << 16
        out.append(tbl[v >> 18] + tbl[(v >> 12) & 63] + "==")
    elif rest == 2:
        v = (data[i] << 16) | (data[i + 1] << 8)
        out.append(tbl[v >> 18] + tbl[(v >> 12) & 63] + tbl[(v >> 6) & 63] + "=")
    return "".join(out)


_B64_REV = {c: i for i, c in enumerate(_B64)}


def b64decode(s: str) -> bytes:
    """Base64 decoding without the base64 module (same reason as b64 above). Ignores anything that isn't base64."""
    out = bytearray()
    acc = bits = 0
    for ch in s:
        v = _B64_REV.get(ch)
        if v is None:
            continue
        acc = (acc << 6) | v
        bits += 6
        if bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 255)
            acc &= (1 << bits) - 1
    return bytes(out)


def _dechunk(body: bytes) -> bytes:
    """Decode an HTTP 'chunked' body (some servers use it even when asked for HTTP/1.0)."""
    out, i = bytearray(), 0
    while i < len(body):
        j = body.find(b"\r\n", i)
        if j < 0:
            break
        try:
            n = int(body[i:j].split(b";")[0].strip() or b"0", 16)
        except ValueError:
            return bytes(body)
        if n == 0:
            break
        out += body[j + 2:j + 2 + n]
        i = j + 2 + n + 2
    return bytes(out)


async def _http_get(host: str, port: int, path: str, timeout: float = 4.0) -> bytes:
    """A tiny HTTP GET with asyncio only (no extra modules). Handles chunked bodies; raises with the status/body start if the answer isn't 200."""
    async def go() -> bytes:
        reader, writer = await asyncio.open_connection(host, port)
        try:
            writer.write(f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n".encode())
            await writer.drain()
            # Steam's browser (Chromium) keeps the connection open after it answers, so never wait for it to close:
            # read the headers, then exactly Content-Length bytes (or the chunked body; only if neither is given, until close).
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head[:-4].decode("latin-1", "replace").split("\r\n")
            status = lines[0] if lines else ""
            hdrs = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:])}
            if "chunked" in hdrs.get("transfer-encoding", "").lower():
                body = bytearray()
                while True:
                    n = int((await reader.readuntil(b"\r\n")).split(b";")[0].strip() or b"0", 16)
                    if n == 0:
                        break
                    body += await reader.readexactly(n)
                    await reader.readexactly(2)
                body = bytes(body)
            elif "content-length" in hdrs:
                body = await reader.readexactly(int(hdrs["content-length"]))
            else:
                body = await reader.read(-1)
        finally:
            writer.close()
        if " 200 " not in status + " ":
            raise RuntimeError(f"HTTP {status[9:12] or '?'}: {body[:60].decode('utf-8', 'replace')}")
        return body
    return await asyncio.wait_for(go(), timeout)


async def _cef_targets() -> List[Dict[str, Any]]:
    """The browser pages Steam's CEF lists on its debugging port, trying the usual addresses until one answers with JSON."""
    last: Exception = RuntimeError("no answer")
    for host in ("127.0.0.1", "localhost"):
        for path in ("/json", "/json/list"):
            try:
                raw = await _http_get(host, CEF_PORT, path)
                text = raw.decode("utf-8", "replace")
                k = text.find("[")
                data = json.loads(text[k:] if k >= 0 else text)
                if isinstance(data, list):
                    return [x for x in data if isinstance(x, dict)]
            except Exception as e:                           # noqa: BLE001
                last = e
    raise RuntimeError(f"{type(last).__name__}: {str(last)[:80]}")


async def cdp_eval(ws_url: str, expression: str, timeout: float = 30.0) -> str:
    """Run JavaScript in one browser page through the Chrome DevTools protocol (a minimal WebSocket client, no extra modules).
    Returns the string the script returned, or 'err:...'."""
    m = re.match(r"^ws://([^/:]+):(\d+)(/.*)$", ws_url)
    if not m:
        return "err:bad address"
    host, port, path = m.group(1), int(m.group(2)), m.group(3)

    async def go() -> str:
        reader, writer = await asyncio.open_connection(host, port)
        try:
            key = b64(os.urandom(16))
            writer.write((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            await writer.drain()
            head = await reader.readuntil(b"\r\n\r\n")
            if b" 101 " not in head.split(b"\r\n", 1)[0]:
                return "err:the browser refused the connection"
            body = json.dumps({"id": 1, "method": "Runtime.evaluate",
                               "params": {"expression": expression, "returnByValue": True, "awaitPromise": False}}).encode()
            n = len(body)
            mask = os.urandom(4)
            masked = (int.from_bytes(body, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big")
            if n < 126:
                hdr = bytes([0x81, 0x80 | n])
            elif n < 65536:
                hdr = bytes([0x81, 0x80 | 126]) + n.to_bytes(2, "big")
            else:
                hdr = bytes([0x81, 0x80 | 127]) + n.to_bytes(8, "big")
            writer.write(hdr + mask + masked)
            await writer.drain()
            parts = bytearray()
            while True:
                b0, b1 = await reader.readexactly(2)
                ln = b1 & 0x7F
                if ln == 126:
                    ln = int.from_bytes(await reader.readexactly(2), "big")
                elif ln == 127:
                    ln = int.from_bytes(await reader.readexactly(8), "big")
                payload = await reader.readexactly(ln)
                op = b0 & 0x0F
                if op == 0x8:
                    return "err:the browser closed the connection"
                if op in (0x9, 0xA):
                    continue
                parts += payload
                if not (b0 & 0x80):
                    continue
                msg = json.loads(bytes(parts).decode("utf-8", "replace"))
                parts = bytearray()
                if msg.get("id") != 1:
                    continue
                res = msg.get("result", {})
                if "exceptionDetails" in res or "error" in msg:
                    return "err:the page refused the script"
                return str(res.get("result", {}).get("value", ""))
        finally:
            writer.close()
    try:
        return await asyncio.wait_for(go(), timeout)
    except Exception as e:                                  # noqa: BLE001 - any failure is reported, never raised
        return f"err:{type(e).__name__}"


async def cdp_session(ws_url: str, work, timeout: float = 40.0):
    """Open one Chrome DevTools connection to a browser page and run `await work(send)`, where
    `await send(method, params)` returns that command's result dict (or raises RuntimeError). Minimal WebSocket client, no extra modules."""
    m = re.match(r"^ws://([^/:]+):(\d+)(/.*)$", ws_url)
    if not m:
        raise RuntimeError("bad address")
    host, port, path = m.group(1), int(m.group(2)), m.group(3)

    async def go():
        reader, writer = await asyncio.open_connection(host, port)
        try:
            key = b64(os.urandom(16))
            writer.write((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            await writer.drain()
            head = await reader.readuntil(b"\r\n\r\n")
            if b" 101 " not in head.split(b"\r\n", 1)[0]:
                raise RuntimeError("the browser refused the connection")
            counter = [0]

            async def send(method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
                counter[0] += 1
                mid = counter[0]
                body = json.dumps({"id": mid, "method": method, "params": params or {}}).encode()
                n = len(body)
                mask = os.urandom(4)
                masked = (int.from_bytes(body, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big")
                if n < 126:
                    hdr = bytes([0x81, 0x80 | n])
                elif n < 65536:
                    hdr = bytes([0x81, 0x80 | 126]) + n.to_bytes(2, "big")
                else:
                    hdr = bytes([0x81, 0x80 | 127]) + n.to_bytes(8, "big")
                writer.write(hdr + mask + masked)
                await writer.drain()
                parts = bytearray()
                while True:
                    b0, b1 = await reader.readexactly(2)
                    ln = b1 & 0x7F
                    if ln == 126:
                        ln = int.from_bytes(await reader.readexactly(2), "big")
                    elif ln == 127:
                        ln = int.from_bytes(await reader.readexactly(8), "big")
                    payload = await reader.readexactly(ln)
                    op = b0 & 0x0F
                    if op == 0x8:
                        raise RuntimeError("the browser closed the connection")
                    if op in (0x9, 0xA):
                        continue
                    parts += payload
                    if not (b0 & 0x80):
                        continue
                    msg = json.loads(bytes(parts).decode("utf-8", "replace"))
                    parts = bytearray()
                    if msg.get("id") != mid:
                        continue
                    if "error" in msg:
                        raise RuntimeError(str((msg["error"] or {}).get("message", "error")))
                    return msg.get("result", {}) or {}
            return await work(send)
        finally:
            writer.close()
    return await asyncio.wait_for(go(), timeout)


async def attach_file_to_page(ws_url: str, file_path: str, filename: str, mime: str, data: bytes) -> str:
    """Put a picture into the artwork page's file box. Returns 'ok', 'loading', 'no-input' or 'err:...'.
    First choice is the DevTools 'set file input files' command (hands the browser the file's path: nothing is copied through the
    connection, any size works); second choice is building the file inside the page with JavaScript."""
    async def work(send) -> str:
        ready = await send("Runtime.evaluate", {"expression": "document.readyState+'|'+(document.querySelector('input[type=file]')?'in':'no')", "returnByValue": True})
        state = str(ready.get("result", {}).get("value", ""))
        if not state.startswith("complete"):
            return "loading"
        if not state.endswith("|in"):
            return "no-input"
        # 1) by path
        try:
            doc = await send("DOM.getDocument", {"depth": 0})
            q = await send("DOM.querySelector", {"nodeId": doc["root"]["nodeId"], "selector": "input[type=file]"})
            if q.get("nodeId"):
                await send("DOM.setFileInputFiles", {"files": [file_path], "nodeId": q["nodeId"]})
                chk = await send("Runtime.evaluate", {"expression": "(function(){var i=document.querySelector('input[type=file]');return i&&i.files&&i.files.length===1?'ok':'no'})()", "returnByValue": True})
                if chk.get("result", {}).get("value") == "ok":
                    return "ok"
        except Exception as e:                                  # noqa: BLE001 - fall through to the JavaScript way
            log.warning(f"setFileInputFiles failed: {e}")
        # 2) by JavaScript inside the page
        r = await send("Runtime.evaluate", {"expression": artwork_script(filename, mime, b64(data)), "returnByValue": True})
        if "exceptionDetails" in r:
            return "err:the page refused the script"
        return str(r.get("result", {}).get("value", ""))
    try:
        return await cdp_session(ws_url, work)
    except Exception as e:                                      # noqa: BLE001
        return f"err:{type(e).__name__} {e}"


def artwork_script(filename: str, mime: str, data_b64: str) -> str:
    """JavaScript that puts the picture into the artwork page's file box, as if it had been chosen (Gaming Mode can't open a file picker)."""
    return ("(function(){try{"
            "if(document.readyState!=='complete')return 'loading';"
            "var inp=document.querySelector('input[type=file]');if(!inp)return 'no-input';"
            f"var b=atob({json.dumps(data_b64)});var n=b.length,a=new Uint8Array(n);for(var i=0;i<n;i++)a[i]=b.charCodeAt(i);"
            f"var f=new File([a],{json.dumps(filename)},{{type:{json.dumps(mime)}}});var dt=new DataTransfer();dt.items.add(f);inp.files=dt.files;"
            "inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));"
            "return inp.files.length===1?'ok':'not-set';"
            "}catch(e){return 'err:'+e;}})()")


def taken_from_name(name: str, mtime: float) -> int:
    """When the screenshot was taken: from Steam's file name (20240131205811_1.jpg), else the file's time."""
    m = TAKEN_RE.match(name)
    if m:
        try:
            y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
            return int(time.mktime((y, mo, d, h, mi, s, 0, 0, -1)))
        except (ValueError, OverflowError):
            pass
    return int(mtime)


def safe_name(s: str, fallback: str = "Unknown game") -> str:
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(s)).strip(" .")
    return s[:80] or fallback


def userdata_dirs(home: str) -> List[Dict[str, str]]:
    """Every <Steam>/userdata/<id> that has screenshots (760/remote), each folder once."""
    seen, out = set(), []
    for base in (".local/share/Steam/userdata", ".steam/steam/userdata", ".steam/root/userdata"):
        root = os.path.join(home, base)
        try:
            names = sorted(os.listdir(root))
        except OSError:
            continue
        for n in names:
            if not n.isdigit():
                continue
            base760 = os.path.join(root, n, "760")
            remote = os.path.join(base760, "remote")
            real = os.path.realpath(remote)
            if os.path.isdir(remote) and real not in seen:
                seen.add(real)
                out.append({"user": n, "remote": remote, "base760": base760})
    return out


def shortcut_names(base760: str) -> Dict[int, str]:
    """Names of non-Steam games, from the 'shortcutnames' block of screenshots.vdf (read only, best effort)."""
    try:
        with open(os.path.join(base760, "screenshots.vdf"), "r", encoding="utf-8", errors="replace") as f:
            text = f.read(2_000_000)
    except OSError:
        return {}
    i = text.find('"shortcutnames"')
    if i < 0:
        return {}
    j = text.find("{", i)
    k = text.find("}", j) if j >= 0 else -1
    if j < 0 or k < 0:
        return {}
    return {int(a): b for a, b in re.findall(r'"(\d+)"\s+"([^"]*)"', text[j:k])}


def scan_shots(home: str) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]], Dict[int, str]]:
    """-> (shots by id, folders report, names of non-Steam games). Only lists folders and stats files."""
    shots: Dict[str, Dict[str, Any]] = {}
    report: List[Dict[str, Any]] = []
    names: Dict[int, str] = {}
    for ud in userdata_dirs(home):
        names.update(shortcut_names(ud["base760"]))
        found = 0
        try:
            apps = sorted(a for a in os.listdir(ud["remote"]) if a.isdigit())
        except OSError:
            apps = []
        for app in apps:
            folder = os.path.join(ud["remote"], app, "screenshots")
            try:
                entries = list(os.scandir(folder))
            except OSError:
                continue
            for e in entries:
                low = e.name.lower()
                if not e.is_file() or not low.endswith(IMG_EXT):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                thumb = os.path.join(folder, "thumbnails", e.name)
                sid = f"{ud['user']}/{app}/{e.name}"
                shots[sid] = {"id": sid, "user": ud["user"], "appid": int(app), "name": e.name, "path": e.path,
                              "thumb": thumb if os.path.isfile(thumb) else "", "size": st.st_size,
                              "taken": taken_from_name(e.name, st.st_mtime)}
                found += 1
        report.append({"user": ud["user"], "folder": ud["remote"], "apps": len(apps), "shots": found})
    return shots, report, names


def scan_edited(home: str, known: Dict[str, int], names: Dict[int, str]) -> Dict[str, Dict[str, Any]]:
    """Pictures made in the editor: ~/Pictures/Steam Screenshots/<game>/Edited/*.jpg, so they show up in the gallery too.
    `known` says which game a file belongs to (written when it was saved); other files are matched by folder name."""
    root = os.path.join(home, "Pictures", "Steam Screenshots")
    by_folder = {safe_name(n): a for a, n in names.items()}
    out: Dict[str, Dict[str, Any]] = {}
    try:
        games = sorted(os.listdir(root))
    except OSError:
        return out
    for g in games:
        folder = os.path.join(root, g, "Edited")
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for e in entries:
            if not e.is_file() or not e.name.lower().endswith(IMG_EXT):
                continue
            try:
                st = e.stat()
            except OSError:
                continue
            appid = known.get(e.path, by_folder.get(g, EDITED_APP))
            sid = f"edit/{g}/{e.name}"
            out[sid] = {"id": sid, "user": "", "appid": int(appid), "name": e.name, "path": e.path, "thumb": "", "size": st.st_size,
                        "taken": int(st.st_mtime), "edited": True}
    return out


def _read(path: str, limit: int) -> Optional[bytes]:
    try:
        if os.path.getsize(path) > limit:
            return None
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def _move(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.rename(src, dst)
    except OSError:                                   # another file system: copy, then remove
        _copy(src, dst)
        os.remove(src)


def _copy(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    with open(src, "rb") as a, open(tmp, "wb") as b:
        while True:
            chunk = a.read(CHUNK)
            if not chunk:
                break
            b.write(chunk)
    os.replace(tmp, dst)


# ---------------------------------------------------------------------------
# Plugin
# ---------------------------------------------------------------------------
class Plugin:
    async def _main(self):
        self.settings_path = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")
        runtime = getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", "") or decky.DECKY_PLUGIN_SETTINGS_DIR
        self.trash_dir = os.path.join(runtime, "trash")
        self.thumb_dir = os.path.join(runtime, "thumbs")
        self.trash_path = os.path.join(runtime, "trash.json")
        self.home = getattr(decky, "DECKY_USER_HOME", "") or os.path.expanduser("~")
        s = self._load(self.settings_path, {})
        self.favorites = set(x for x in s.get("favorites", []) if isinstance(x, str))
        # which screenshots were shared: id -> {"hub": bool, "art": bool}  ("art" = sent to Steam's artwork upload page)
        raw_shared = s.get("shared", {})
        self.shared: Dict[str, Dict[str, bool]] = {
            k: {"hub": bool(v.get("hub")), "art": bool(v.get("art")), "off": bool(v.get("off"))}
            for k, v in (raw_shared.items() if isinstance(raw_shared, dict) else [])
            if isinstance(k, str) and isinstance(v, dict)
        }
        raw_albums = s.get("albums", {})
        self.albums: Dict[str, List[str]] = {
            str(k)[:40]: [x for x in v if isinstance(x, str)][:ALBUM_SHOTS_MAX]
            for k, v in (raw_albums.items() if isinstance(raw_albums, dict) else []) if isinstance(v, list)
        }
        self.edited_path = os.path.join(runtime, "edited.json")
        raw_edited = self._load(self.edited_path, {})
        self.edited_map: Dict[str, int] = {k: int(v) for k, v in raw_edited.items() if isinstance(k, str) and isinstance(v, int)}
        self.phone: Optional[Dict[str, Any]] = None
        self.trash: List[Dict[str, Any]] = self._load(self.trash_path, {}).get("items", [])
        self.index: Dict[str, Dict[str, Any]] = {}
        self.report: List[Dict[str, Any]] = []
        self.names: Dict[int, str] = {}
        self.scanned_at = 0
        await self._rescan()
        log.info(f"Screenshot Gallery ready: {len(self.index)} screenshots, {len(self.trash)} left in the old trash")

    async def _unload(self):
        await self._phone_close()

    # -- files ---------------------------------------------------------------------
    @staticmethod
    def _load(path: str, default: Any) -> Any:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, type(default)) else default
        except (OSError, ValueError):
            return default

    @staticmethod
    def _save(path: str, data: Any) -> None:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp, path)
        except OSError as e:
            log.warning(f"couldn't save {path}: {e}")

    def _save_settings(self):
        self._save(self.settings_path, {"favorites": sorted(self.favorites)[:FAV_MAX], "shared": dict(list(self.shared.items())[-FAV_MAX:]),
                                        "albums": self.albums})

    def _save_trash(self):
        self._save(self.trash_path, {"items": self.trash})

    async def _rescan(self) -> None:
        self.index, self.report, self.names = await asyncio.to_thread(scan_shots, self.home)
        self.index.update(await asyncio.to_thread(scan_edited, self.home, self.edited_map, self.names))
        before = (len(self.favorites), sum(len(v) for v in self.albums.values()))
        self.favorites &= set(self.index)                 # forget favorites whose file is gone
        for k in self.albums:
            self.albums[k] = [i for i in self.albums[k] if i in self.index]
        if before != (len(self.favorites), sum(len(v) for v in self.albums.values())):
            self._save_settings()
        self.scanned_at = int(time.time())

    # -- API for the panel ----------------------------------------------------------------
    def _overview(self) -> Dict[str, Any]:
        games: Dict[int, Dict[str, Any]] = {}
        for s in self.index.values():
            g = games.setdefault(s["appid"], {"appid": s["appid"], "count": 0, "size": 0, "newest": 0, "favorites": 0, "hint": self.names.get(s["appid"], "")})
            g["count"] += 1
            g["size"] += s["size"]
            g["newest"] = max(g["newest"], s["taken"])
            g["favorites"] += 1 if s["id"] in self.favorites else 0
        return {"total": len(self.index), "size": sum(s["size"] for s in self.index.values()), "favorites": len(self.favorites),
                "games": sorted(games.values(), key=lambda g: -g["newest"]),
                "trash": {"count": len(self.trash), "size": sum(t.get("size", 0) for t in self.trash)},
                "scanned_at": self.scanned_at, "folders": self.report,
                "albums": [{"name": k, "count": len(v)} for k, v in sorted(self.albums.items(), key=lambda kv: kv[0].lower())],
                "edited": sum(1 for s in self.index.values() if s.get("edited"))}

    async def get_overview(self, rescan: bool = False) -> Dict[str, Any]:
        if rescan:
            await self._rescan()
        return self._overview()

    def _make_thumb(self, s: Dict[str, Any]) -> Optional[bytes]:
        """A sharp THUMB_PX-wide JPEG made from the original screenshot and cached on disk.
        Needs Pillow (optional: if Decky's Python doesn't have it this returns None and we fall back)."""
        try:
            from PIL import Image  # type: ignore
        except Exception:
            return None
        try:
            cache_dir = os.path.join(self.thumb_dir, str(s["appid"]))
            cache = os.path.join(cache_dir, os.path.splitext(s["name"])[0] + f"_{THUMB_PX}.jpg")
            try:
                if os.path.isfile(cache) and os.path.getmtime(cache) >= os.path.getmtime(s["path"]):
                    data = _read(cache, THUMB_MAX * 4)
                    if data:
                        return data
            except Exception:
                pass
            with Image.open(s["path"]) as im:
                im.draft("RGB", (THUMB_PX * 2, THUMB_PX * 2))   # fast JPEG decode at reduced size
                im = im.convert("RGB")
                im.thumbnail((THUMB_PX, THUMB_PX * 2), getattr(Image, "LANCZOS", 1))
                os.makedirs(cache_dir, exist_ok=True)
                im.save(cache, "JPEG", quality=88, optimize=True)
            return _read(cache, THUMB_MAX * 4)
        except Exception as e:
            log.warning(f"thumbnail failed for {s.get('name')}: {e}")
            return None

    def _thumb_url(self, s: Dict[str, Any]) -> str:
        data = self._make_thumb(s)                                  # 1) a sharp thumbnail made from the original
        if data is None:
            data = _read(s["path"], THUMB_FALLBACK_MAX)             # 2) no image library: the screenshot itself, if it isn't big
        if data is None and s["thumb"]:
            data = _read(s["thumb"], THUMB_MAX)                     # 3) Steam's own small thumbnail
        if data is None:
            return ""
        mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
        return f"data:{mime};base64,{b64(data)}"

    def _select(self, appid: int, favorites_only: bool, opts: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """The screenshots of a view, filtered and sorted. opts: sort (new|old|big|small|game), days (only the last N days),
        min_mb / max_mb (size), appids (only these games: the panel turns a game-name search into ids), album (a name)."""
        o = opts if isinstance(opts, dict) else {}
        rows = [s for s in self.index.values() if (not appid or s["appid"] == appid) and (not favorites_only or s["id"] in self.favorites)]
        album = o.get("album")
        if isinstance(album, str) and album:
            keep = set(self.albums.get(album, []))
            rows = [s for s in rows if s["id"] in keep]
        ids = o.get("appids")
        if isinstance(ids, list):
            allow = set(int(x) for x in ids if isinstance(x, int))
            rows = [s for s in rows if s["appid"] in allow]
        days = o.get("days")
        if isinstance(days, (int, float)) and days > 0:
            cut = time.time() - days * 86400
            rows = [s for s in rows if s["taken"] >= cut]
        lo, hi = o.get("min_mb"), o.get("max_mb")
        if isinstance(lo, (int, float)) and lo > 0:
            rows = [s for s in rows if s["size"] >= lo * 1_000_000]
        if isinstance(hi, (int, float)) and hi > 0:
            rows = [s for s in rows if s["size"] <= hi * 1_000_000]
        order = o.get("sort")
        if order == "old":
            rows.sort(key=lambda s: (s["taken"], s["name"]))
        elif order == "big":
            rows.sort(key=lambda s: (-s["size"], -s["taken"]))
        elif order == "small":
            rows.sort(key=lambda s: (s["size"], -s["taken"]))
        elif order == "game":
            rows.sort(key=lambda s: (s["appid"], -s["taken"]))
        else:
            rows.sort(key=lambda s: (-s["taken"], s["name"]))
        return rows

    async def get_shots(self, appid: int, offset: int = 0, favorites_only: bool = False, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """One page of screenshots (newest first unless opts.sort says otherwise). appid 0 = all games."""
        rows = self._select(appid, favorites_only, opts)
        page = rows[max(0, int(offset)):max(0, int(offset)) + PAGE]
        thumbs = await asyncio.to_thread(lambda: [self._thumb_url(s) for s in page])
        items = [{"id": s["id"], "appid": s["appid"], "name": s["name"], "taken": s["taken"], "size": s["size"],
                  "favorite": s["id"] in self.favorites, "thumb": t, "edited": bool(s.get("edited")),
                  "hub": bool(self.shared.get(s["id"], {}).get("hub")), "art": bool(self.shared.get(s["id"], {}).get("art"))}
                 for s, t in zip(page, thumbs)]
        return {"total": len(rows), "offset": int(offset), "items": items}

    async def mark_shared(self, ids: List[str], kind: str, value: bool = True) -> Dict[str, Any]:
        """Remember that screenshots were shared: kind 'hub' (Steam Community Hub) or 'art' (sent to the artwork upload page).
        value=False on 'hub' clears the mark and remembers that the person says it is no longer there (Steam's own list can lag behind)."""
        if kind not in ("hub", "art"):
            return {"ok": False, "changed": 0}
        changed = 0
        for i in ids or []:
            i = str(i)
            if i not in self.index:
                continue
            e = self.shared.setdefault(i, {"hub": False, "art": False, "off": False})
            if bool(e.get(kind)) != bool(value):
                e[kind] = bool(value)
                changed += 1
            if kind == "hub":
                e["off"] = not value
        if changed or ids:
            self._save_settings()
        return {"ok": True, "changed": changed}

    async def get_image(self, shot_id: str) -> Dict[str, Any]:
        s = self.index.get(str(shot_id))
        if not s:
            return {"ok": False, "url": "", "note": "That screenshot is gone."}
        def read():
            data = _read(s["path"], FULL_MAX)
            return data, (None if data else self._thumb_url(s))
        data, fallback = await asyncio.to_thread(read)
        if data is None:
            return {"ok": bool(fallback), "url": fallback or "", "note": "Too large to preview: showing the thumbnail." if fallback else "Couldn't read it."}
        mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
        return {"ok": True, "url": f"data:{mime};base64,{b64(data)}", "note": ""}

    async def get_source(self, shot_id: str) -> Dict[str, Any]:
        """The full-quality screenshot for the editor (never the thumbnail: edits are made from the original)."""
        s = self.index.get(str(shot_id))
        if not s:
            return {"ok": False, "url": "", "note": "That screenshot is gone."}
        def read():
            data = _read(s["path"], EDIT_MAX)
            if data is None:
                return None
            mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
            return f"data:{mime};base64,{b64(data)}"
        url = await asyncio.to_thread(read)
        if not url:
            return {"ok": False, "url": "", "note": "This screenshot is too large to edit here."}
        return {"ok": True, "url": url, "note": ""}

    async def save_edit(self, data: str, appid: int, names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """Save an edited picture (a JPEG, sent as base64 by the editor) to ~/Pictures/Steam Screenshots/<game>/Edited/.
        The original screenshot is never touched."""
        if not isinstance(data, str) or not data or len(data) > SAVE_MAX:
            return {"ok": False, "path": "", "display": "", "note": "The picture is empty or too large to save."}
        raw = await asyncio.to_thread(b64decode, data)
        if raw[:2] != b"\xff\xd8":
            return {"ok": False, "path": "", "display": "", "note": "That wasn't a valid picture."}
        nm = names if isinstance(names, dict) else {}
        game = safe_name(nm.get(str(appid)) or self.names.get(int(appid)) or f"App {appid}", f"App {appid}")
        folder = os.path.join(self.home, "Pictures", "Steam Screenshots", game, "Edited")
        base = os.path.join(folder, "Edited " + time.strftime("%Y-%m-%d %H.%M.%S"))
        dst, n = base + ".jpg", 1
        while os.path.exists(dst):
            n += 1
            dst = f"{base}_{n}.jpg"
        def write():
            os.makedirs(folder, exist_ok=True)
            tmp = dst + ".part"
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, dst)
        try:
            await asyncio.to_thread(write)
        except OSError as e:
            log.warning(f"couldn't save {dst}: {e}")
            return {"ok": False, "path": "", "display": "", "note": "Couldn't write to the Pictures folder."}
        self.edited_map[dst] = int(appid)
        self._save(self.edited_path, dict(list(self.edited_map.items())[-5000:]))
        await self._rescan()                               # the new picture shows up in the gallery
        home = self.home.rstrip(os.sep) + os.sep
        return {"ok": True, "path": dst, "display": dst[len(home):] if dst.startswith(home) else dst, "note": ""}

    async def get_ids(self, appid: int = 0, favorites_only: bool = False, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Every id in a view (for 'select all', which can reach past the pages that are loaded)."""
        rows = self._select(appid, favorites_only, opts)
        return {"ids": [s["id"] for s in rows], "size": sum(s["size"] for s in rows)}

    async def summarize(self, ids: List[str]) -> Dict[str, Any]:
        """What a selection holds: how many, how big, and how many of them are favorites."""
        rows = [self.index[i] for i in (ids if isinstance(ids, list) else []) if i in self.index]
        return {"count": len(rows), "size": sum(s["size"] for s in rows), "favorites": sum(1 for s in rows if s["id"] in self.favorites)}

    async def set_favorites(self, ids: List[str], fav: bool) -> Dict[str, Any]:
        """Star or un-star many screenshots at once."""
        changed = 0
        for i in ids if isinstance(ids, list) else []:
            if str(i) in self.index and ((str(i) not in self.favorites) == bool(fav)):
                (self.favorites.add if fav else self.favorites.discard)(str(i))
                changed += 1
        if changed:
            self._save_settings()
        return {"ok": True, "changed": changed, "favorites": len(self.favorites)}

    async def set_favorite(self, shot_id: str, fav: bool) -> Dict[str, Any]:
        sid = str(shot_id)
        if sid not in self.index:
            return {"ok": False}
        (self.favorites.add if fav else self.favorites.discard)(sid)
        self._save_settings()
        return {"ok": True, "favorites": len(self.favorites)}

    async def get_trash(self) -> Dict[str, Any]:
        """Screenshots an older version moved to the trash (nothing is added to it any more)."""
        return {"items": [{"n": t["n"], "appid": t["appid"], "name": t["name"], "size": t.get("size", 0)} for t in self.trash]}

    async def restore(self, ns: Optional[List[int]] = None) -> Dict[str, Any]:
        """Put trashed screenshots back where Steam keeps them (all of them if ns is empty)."""
        want = set(ns) if ns else None
        back = skipped = 0
        keep = []
        for t in self.trash:
            if want is not None and t["n"] not in want:
                keep.append(t)
                continue
            if os.path.exists(t["orig_image"]) or not os.path.exists(t["image"]):
                skipped += 1
                keep.append(t)
                continue
            try:
                _move(t["image"], t["orig_image"])
                if t.get("thumb") and os.path.exists(t["thumb"]) and t.get("orig_thumb"):
                    _move(t["thumb"], t["orig_thumb"])
                back += 1
            except OSError as e:
                log.warning(f"couldn't restore {t['name']}: {e}")
                skipped += 1
                keep.append(t)
        self.trash = keep
        self._save_trash()
        await self._rescan()
        return {"ok": skipped == 0, "restored": back, "skipped": skipped, "overview": self._overview()}

    def _export(self, shots: List[Dict[str, Any]], names: Dict[str, str], paths: Optional[List[str]] = None) -> Tuple[int, int, str]:
        """Copy screenshots to ~/Pictures/Steam Screenshots/<game name>/<date time>.jpg. Nothing is moved.
        If `paths` is given, the final file of every screenshot (copied now or already there) is appended to it."""
        dest_root = os.path.join(self.home, "Pictures", "Steam Screenshots")
        copied = skipped = 0
        for s in sorted(shots, key=lambda s: (s["appid"], s["taken"], s["name"])):
            game = safe_name(names.get(str(s["appid"])) or self.names.get(s["appid"]) or f"App {s['appid']}", f"App {s['appid']}")
            ext = os.path.splitext(s["name"])[1].lower()
            base = os.path.join(dest_root, game, time.strftime("%Y-%m-%d %H.%M.%S", time.localtime(s["taken"])))
            dst, n, same = base + ext, 1, ""
            while os.path.exists(dst):
                try:
                    if os.path.getsize(dst) == s["size"]:
                        same = dst
                        dst = ""
                        break
                except OSError:
                    pass
                n += 1
                dst = f"{base}_{n}{ext}"
            if not dst:
                skipped += 1
                if paths is not None:
                    paths.append(same)
                continue
            try:
                _copy(s["path"], dst)
                copied += 1
                if paths is not None:
                    paths.append(dst)
            except OSError as e:
                log.warning(f"couldn't export {s['path']}: {e}")
        return copied, skipped, dest_root

    async def export_organized(self, names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """Copy every screenshot, organized by game (nothing is moved)."""
        copied, skipped, folder = await asyncio.to_thread(self._export, [x for x in self.index.values() if not x.get("edited")], names if isinstance(names, dict) else {})
        return {"ok": True, "copied": copied, "skipped": skipped, "folder": folder}

    async def export_selected(self, ids: List[str], names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """Copy only the chosen screenshots, organized by game."""
        chosen = [self.index[i] for i in (ids if isinstance(ids, list) else []) if i in self.index and not self.index[i].get("edited")]
        copied, skipped, folder = await asyncio.to_thread(self._export, chosen, names if isinstance(names, dict) else {})
        return {"ok": True, "copied": copied, "skipped": skipped, "folder": folder}

    async def prepare_share(self, shot_id: str, names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """Put one screenshot where it is easy to pick in a web page (~/Pictures/Steam Screenshots/<game>/), for 'Share as artwork'.
        Steam's artwork upload is a web form that needs a file chosen by hand, so the plugin copies the file there and says where it is."""
        s = self.index.get(str(shot_id))
        if not s:
            return {"ok": False, "path": "", "display": "", "note": "That screenshot is gone."}
        paths: List[str] = []
        if s.get("edited"):                                 # already in Pictures
            paths.append(s["path"])
        else:
            await asyncio.to_thread(self._export, [s], names if isinstance(names, dict) else {}, paths)
        if not paths or not paths[0] or not os.path.isfile(paths[0]):
            return {"ok": False, "path": "", "display": "", "note": "Couldn't copy it to the Pictures folder."}
        p = paths[0]
        home = self.home.rstrip(os.sep) + os.sep
        return {"ok": True, "path": p, "display": p[len(home):] if p.startswith(home) else p, "note": "", "size": os.path.getsize(p)}

    async def attach_artwork(self, path: str) -> Dict[str, Any]:
        """Put a picture into the open artwork upload page's file box (after 'Share as Artwork' has opened that page).
        Waits for the page to load; only files in ~/Pictures/Steam Screenshots can be used, up to Steam's 5 MB limit."""
        root = os.path.realpath(os.path.join(self.home, "Pictures", "Steam Screenshots"))
        real = os.path.realpath(str(path or ""))
        ext = os.path.splitext(real)[1].lower()
        if not real.startswith(root + os.sep) or ext not in (".jpg", ".jpeg", ".png", ".gif") or not os.path.isfile(real):
            return {"ok": False, "note": "That file can't be attached."}
        data = await asyncio.to_thread(_read, real, ART_MAX)
        if data is None:
            return {"ok": False, "note": "The picture is over Steam's 5 MB limit for artwork (or unreadable)."}
        mime = {".png": "image/png", ".gif": "image/gif"}.get(ext, "image/jpeg")
        deadline = time.time() + 70
        last = "The artwork page didn't open in time."
        while time.time() < deadline:
            try:
                targets = [x for x in await _cef_targets() if x.get("webSocketDebuggerUrl")]
                # the artwork form first; any other steamcommunity page is only a fallback (the address can differ a little after a redirect)
                pages = [x for x in targets if ART_URL in str(x.get("url", ""))]
                if not pages:
                    pages = [x for x in targets if "steamcommunity.com" in str(x.get("url", "")) and "edititem" in str(x.get("url", ""))]
            except Exception as e:                           # noqa: BLE001
                pages, last = [], f"Couldn't reach Steam's browser ({e})."
            for pg in reversed(pages):
                res = await attach_file_to_page(pg["webSocketDebuggerUrl"], real, os.path.basename(real), mime, data)
                if res == "ok":
                    return {"ok": True, "note": ""}
                last = ("The page is still loading, or isn't the upload form (are you signed in to Steam Community?)." if res in ("loading", "no-input")
                        else f"Steam's page didn't accept the file ({res}).")
            await asyncio.sleep(1.5)
        return {"ok": False, "note": last}

    # -- albums ------------------------------------------------------------------------
    @staticmethod
    def _album_name(name: Any) -> str:
        return re.sub(r"\s+", " ", str(name or "")).strip()[:40]

    async def create_album(self, name: str) -> Dict[str, Any]:
        n = self._album_name(name)
        if not n:
            return {"ok": False, "note": "Type a name for the album."}
        if n in self.albums:
            return {"ok": True, "name": n, "note": "That album already exists."}
        if len(self.albums) >= ALBUM_MAX:
            return {"ok": False, "note": f"You can have up to {ALBUM_MAX} albums."}
        self.albums[n] = []
        self._save_settings()
        return {"ok": True, "name": n, "note": ""}

    async def delete_album(self, name: str) -> Dict[str, Any]:
        """Removes the album only. The screenshots in it are not touched."""
        if name in self.albums:
            del self.albums[name]
            self._save_settings()
        return {"ok": True}

    async def album_add(self, name: str, ids: List[str]) -> Dict[str, Any]:
        if name not in self.albums:
            return {"ok": False, "added": 0}
        cur = self.albums[name]
        have = set(cur)
        added = 0
        for i in ids if isinstance(ids, list) else []:
            if isinstance(i, str) and i in self.index and i not in have and len(cur) < ALBUM_SHOTS_MAX:
                cur.append(i)
                have.add(i)
                added += 1
        if added:
            self._save_settings()
        return {"ok": True, "added": added, "count": len(cur)}

    async def album_remove(self, name: str, ids: List[str]) -> Dict[str, Any]:
        if name not in self.albums:
            return {"ok": False, "removed": 0}
        drop = set(i for i in ids if isinstance(i, str)) if isinstance(ids, list) else set()
        before = len(self.albums[name])
        self.albums[name] = [i for i in self.albums[name] if i not in drop]
        if len(self.albums[name]) != before:
            self._save_settings()
        return {"ok": True, "removed": before - len(self.albums[name])}

    # -- send to phone: a small web page on the home network, open for a few minutes ---------
    async def _phone_close(self) -> None:
        ph = self.phone
        self.phone = None
        if ph:
            try:
                ph["server"].close()
                await ph["server"].wait_closed()
            except Exception:                                # noqa: BLE001
                pass
            if ph.get("timer"):
                ph["timer"].cancel()

    @staticmethod
    def _lan_ip() -> str:
        import socket
        for target in ("10.255.255.255", "192.168.255.255", "8.8.8.8"):
            sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                sk.settimeout(1)
                sk.connect((target, 1))
                ip = sk.getsockname()[0]
                if ip and not ip.startswith("127."):
                    return ip
            except OSError:
                pass
            finally:
                sk.close()
        return ""

    def _phone_page(self, ph: Dict[str, Any]) -> bytes:
        cells = []
        for n, it in enumerate(ph["items"]):
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(it["taken"]))
            cells.append(f'<a href="img/{n}" class="c"><img loading="lazy" src="th/{n}"><span>{when}</span></a>'
                         f'<a class="dl" href="img/{n}?dl=1">Save</a>')
        body = ("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                "<title>Steam Deck screenshots</title><style>body{margin:0;background:#0e141b;color:#dfe6ec;font:15px sans-serif}"
                "h1{font-size:18px;margin:14px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:0 10px 20px}"
                ".c{position:relative;display:block;border-radius:6px;overflow:hidden;background:#1b2838;aspect-ratio:16/10}.c img{width:100%;height:100%;object-fit:cover}"
                ".c span{position:absolute;left:0;right:0;bottom:0;padding:14px 6px 4px;font-size:11px;background:linear-gradient(transparent,#000a)}"
                ".dl{display:block;text-align:center;margin:4px 0 10px;color:#66c0f4;text-decoration:none}</style></head><body>"
                f"<h1>{len(ph['items'])} screenshot{'s' if len(ph['items']) != 1 else ''} from your Steam Deck</h1><div class=g>"
                + "".join(f"<div>{c}</div>" for c in cells) + "</div></body></html>")
        return body.encode("utf-8")

    async def _phone_serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        ph = self.phone
        try:
            line = await asyncio.wait_for(reader.readline(), 5)
            for _ in range(40):                              # skip the headers
                h = await asyncio.wait_for(reader.readline(), 5)
                if h in (b"\r\n", b"\n", b""):
                    break
            parts = line.decode("latin-1", "replace").split()
            if not ph or len(parts) < 2 or parts[0] != "GET":
                raise ValueError("bad request")
            path, _, query = parts[1].partition("?")
            pre = f"/{ph['token']}/"
            if not path.startswith(pre):
                head = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                writer.write(head)
            else:
                rest = path[len(pre):]
                if rest == "":
                    data, ctype, extra = self._phone_page(ph), "text/html; charset=utf-8", ""
                else:
                    kind, _, num = rest.partition("/")
                    it = ph["items"][int(num)] if kind in ("img", "th") and num.isdigit() and int(num) < len(ph["items"]) else None
                    if it is None:
                        raise ValueError("no such file")
                    if kind == "th":
                        data = await asyncio.to_thread(lambda: self._make_thumb(it) or (_read(it["thumb"], 3_000_000) if it.get("thumb") else None) or _read(it["path"], 12_000_000) or b"")
                    else:
                        data = await asyncio.to_thread(_read, it["path"], 40_000_000) or b""
                    ctype = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
                    extra = ""
                    if "dl=1" in query:
                        extra = f'Content-Disposition: attachment; filename="{safe_name(it["name"])}"\r\n'
                writer.write((f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {len(data)}\r\n{extra}"
                              "Cache-Control: no-store\r\nConnection: close\r\n\r\n").encode("latin-1"))
                writer.write(data)
            await writer.drain()
        except Exception:                                    # noqa: BLE001 - one bad request must not stop the page
            try:
                writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
            except Exception:                                # noqa: BLE001
                pass
        finally:
            try:
                writer.close()
            except Exception:                                # noqa: BLE001
                pass

    async def phone_start(self, ids: List[str]) -> Dict[str, Any]:
        """Open a page on the home network with the chosen screenshots. Anyone on the same Wi-Fi with the link can see it until it closes."""
        await self._phone_close()
        items = [self.index[i] for i in (ids if isinstance(ids, list) else []) if i in self.index][:PHONE_MAX]
        if not items:
            return {"ok": False, "note": "Choose at least one screenshot first."}
        ip = await asyncio.to_thread(self._lan_ip)
        if not ip:
            return {"ok": False, "note": "The Steam Deck isn't connected to a network (no address found)."}
        token = os.urandom(12).hex()
        try:
            server = await asyncio.start_server(self._phone_serve, "0.0.0.0", 0)
        except OSError as e:
            return {"ok": False, "note": f"Couldn't open a port ({e})."}
        port = server.sockets[0].getsockname()[1]
        ph: Dict[str, Any] = {"server": server, "token": token, "items": items, "until": int(time.time()) + PHONE_SECONDS, "url": f"http://{ip}:{port}/{token}/"}

        async def stop_later():
            await asyncio.sleep(PHONE_SECONDS)
            await self._phone_close()
        ph["timer"] = asyncio.ensure_future(stop_later())
        self.phone = ph
        return {"ok": True, "url": ph["url"], "count": len(items), "seconds": PHONE_SECONDS, "note": ""}

    async def phone_status(self) -> Dict[str, Any]:
        ph = self.phone
        if not ph:
            return {"open": False, "url": "", "left": 0}
        return {"open": True, "url": ph["url"], "left": max(0, ph["until"] - int(time.time())), "count": len(ph["items"])}

    async def phone_stop(self) -> Dict[str, Any]:
        await self._phone_close()
        return {"ok": True}

    # -- a text report the panel can save (for when something in Steam's own API doesn't work) ------
    async def save_report(self, text: str) -> Dict[str, Any]:
        out = os.path.join(self.home, "Downloads", "screenshot-gallery-report.txt")
        try:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "w", encoding="utf-8") as f:
                f.write(str(text)[:200_000])
        except OSError as e:
            return {"ok": False, "note": f"Couldn't write {out} ({e})."}
        return {"ok": True, "path": out}

    async def check_folders(self) -> Dict[str, Any]:
        """What the plugin found, and where it looked: for when the gallery looks empty."""
        await self._rescan()
        lines = []
        looked = [os.path.join(self.home, p) for p in (".local/share/Steam/userdata", ".steam/steam/userdata")]
        if not self.report:
            lines.append({"label": "Steam's screenshot folder", "ok": False, "detail": "none found in " + " or ".join(looked)})
        for r in self.report:
            lines.append({"label": f"Account {r['user']}", "ok": r["shots"] > 0, "detail": f"{r['shots']} screenshots in {r['apps']} games ({r['folder']})"})
        thumbs = sum(1 for s in self.index.values() if s["thumb"])
        if self.index:
            lines.append({"label": "Thumbnails", "ok": thumbs > 0, "detail": f"{thumbs} of {len(self.index)} screenshots have one"})
        return {"ok": bool(self.index), "lines": lines}
