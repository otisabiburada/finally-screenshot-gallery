import { callable, definePlugin, routerHook, toaster } from "@decky/api";
import {
  ButtonItem,
  DialogButton,
  Field,
  Focusable,
  GamepadButton,
  Navigation,
  PanelSection,
  PanelSectionRow,
  Router,
  SliderField,
  staticClasses,
  TextField,
} from "@decky/ui";
import qrcode from "qrcode-generator";
import { useEffect, useRef, useState } from "react";
import { FaImages } from "react-icons/fa";

// ---------------------------------------------------------------------------------------------
// Types and backend calls
// ---------------------------------------------------------------------------------------------

interface GameInfo {
  appid: number;
  count: number;
  size: number;
  newest: number;
  favorites: number;
  hint: string;
}
interface Overview {
  total: number;
  size: number;
  favorites: number;
  games: GameInfo[];
  trash: { count: number; size: number };
  albums: { name: string; count: number }[];
  edited: number;
  scanned_at: number;
  folders: { user: string; folder: string; apps: number; shots: number }[];
}
interface Shot {
  id: string;
  appid: number;
  name: string;
  taken: number;
  size: number;
  favorite: boolean;
  thumb: string;
  art?: boolean; // sent to the artwork upload page
  hub?: boolean; // uploaded to the Steam Community
  edited?: boolean; // made in the editor
}
// What the gallery shows: how it is sorted and filtered.
interface Filters {
  sort: "new" | "old" | "big" | "small" | "game";
  days: number;
  size: "any" | "small" | "medium" | "large";
  q: string;
}
const NO_FILTERS: Filters = { sort: "new", days: 0, size: "any", q: "" };
interface ShotsPage {
  total: number;
  offset: number;
  items: Shot[];
}
interface CheckLine {
  label: string;
  ok: boolean;
  detail: string;
}

const getOverview = callable<[boolean], Overview>("get_overview");
const getShots = callable<[number, number, boolean, Record<string, unknown>], ShotsPage>("get_shots");
const getImage = callable<[string], { ok: boolean; url: string; note: string }>("get_image");
const setFavorite = callable<[string, boolean], { ok: boolean; favorites: number }>("set_favorite");
const restoreAll = callable<[], { ok: boolean; restored: number; skipped: number; overview: Overview }>("restore");
const exportOrganized = callable<[Record<string, string>], { ok: boolean; copied: number; skipped: number; folder: string }>("export_organized");
const checkFolders = callable<[], { ok: boolean; lines: CheckLine[] }>("check_folders");
const getIds = callable<[number, boolean, Record<string, unknown>], { ids: string[]; size: number }>("get_ids");
const createAlbum = callable<[string], { ok: boolean; name: string; note: string }>("create_album");
const deleteAlbum = callable<[string], { ok: boolean }>("delete_album");
const albumAdd = callable<[string, string[]], { ok: boolean; added: number; count: number }>("album_add");
const albumRemove = callable<[string, string[]], { ok: boolean; removed: number }>("album_remove");
const phoneStart = callable<[string[]], { ok: boolean; url: string; count: number; seconds: number; note: string }>("phone_start");
const phoneStatus = callable<[], { open: boolean; url: string; left: number }>("phone_status");
const phoneStop = callable<[], { ok: boolean }>("phone_stop");
const saveReport = callable<[string], { ok: boolean; path?: string; note?: string }>("save_report");
const summarize = callable<[string[]], { count: number; size: number; favorites: number }>("summarize");
const setFavorites = callable<[string[], boolean], { ok: boolean; changed: number; favorites: number }>("set_favorites");
const prepareShare = callable<[string, Record<string, string>], { ok: boolean; path: string; display: string; note: string; size: number }>("prepare_share");
const markShared = callable<[string[], string, boolean?], { ok: boolean; changed: number }>("mark_shared");
const attachArtwork = callable<[string], { ok: boolean; note: string }>("attach_artwork");
const getSource = callable<[string], { ok: boolean; url: string; note: string }>("get_source");
const saveEdit = callable<[string, number, Record<string, string>], { ok: boolean; path: string; display: string; note: string }>("save_edit");
const exportSelected = callable<[string[], Record<string, string>], { ok: boolean; copied: number; skipped: number; folder: string }>("export_selected");

// If the plugin's background part never started, a call neither succeeds nor fails: it just never answers.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The plugin's background part isn't answering.")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
const errText = (e: unknown) => String((e as any)?.message ?? e);
const shots = (n: number) => `${n} screenshot${n === 1 ? "" : "s"}`;

const ROUTE = "/screenshot-gallery";
const shared = { appid: 0, onlyFav: false, album: "", filters: { ...NO_FILTERS } as Filters };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const fmtSize = (b: number) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtDate = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const fmtDateTime = (t: number) => `${fmtDate(t)}, ${new Date(t * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;

// Game names come from Steam's own library in the panel (the backend only knows ids).
const knownNames = new Map<number, string>();
function gameName(appid: number, hint = ""): string {
  if (appid === 0) return "All screenshots";
  if (appid === -1) return "Edited pictures";
  const cached = knownNames.get(appid);
  if (cached) return cached;
  let n = "";
  try {
    n = (window as any).appStore?.GetAppOverviewByAppID?.(appid)?.display_name ?? "";
  } catch {
    n = "";
  }
  if (n) {
    knownNames.set(appid, n);
    return n;
  }
  return hint || `App ${appid}`;
}

function buttonCode(...patterns: RegExp[]): number | undefined {
  const table = (GamepadButton ?? {}) as Record<string, unknown>;
  for (const re of patterns) for (const [name, value] of Object.entries(table)) if (typeof value === "number" && re.test(name)) return value;
  return undefined;
}
const BUMPER_LEFT = buttonCode(/^BUMPER_LEFT$/, /bumper.*left|left.*bumper|^L1$/i);
const BUMPER_RIGHT = buttonCode(/^BUMPER_RIGHT$/, /bumper.*right|right.*bumper|^R1$/i);
function onBumpers(prev: () => void, next: () => void) {
  return (evt: any) => {
    const button = evt?.detail?.button;
    if (button === undefined) return;
    if (BUMPER_LEFT !== undefined && button === BUMPER_LEFT) prev();
    else if (BUMPER_RIGHT !== undefined && button === BUMPER_RIGHT) next();
  };
}

// Non-Steam shortcuts get ids with the top bit set; they have no Community Hub.
const isNonSteam = (appid: number) => appid >= 2147483648 || appid <= 0;

// The filters, as the backend wants them. A game-name search becomes the list of matching games.
function buildOpts(f: Filters, album: string, games: GameInfo[]): Record<string, unknown> {
  const o: Record<string, unknown> = { sort: f.sort };
  if (f.days) o.days = f.days;
  if (f.size === "small") o.max_mb = 1;
  else if (f.size === "medium") (o.min_mb = 1), (o.max_mb = 3);
  else if (f.size === "large") o.min_mb = 3;
  const q = f.q.trim().toLowerCase();
  if (q) o.appids = games.filter((g) => gameName(g.appid, g.hint).toLowerCase().includes(q)).map((g) => g.appid);
  if (album) o.album = album;
  return o;
}
const filterCount = (f: Filters) => (f.sort !== "new" ? 1 : 0) + (f.days ? 1 : 0) + (f.size !== "any" ? 1 : 0) + (f.q.trim() ? 1 : 0);

// A QR code that a phone camera can read.
function QR(props: { text: string; size: number }) {
  let d = "";
  let n = 0;
  try {
    const qr = qrcode(0, "M");
    qr.addData(props.text);
    qr.make();
    n = qr.getModuleCount();
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  } catch {
    return <div className="sg-hint">The link is too long for a QR code. Type it in your phone's browser.</div>;
  }
  return (
    <svg viewBox={`0 0 ${n + 8} ${n + 8}`} width={props.size} height={props.size} shapeRendering="crispEdges">
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Sharing a screenshot to the Steam Community through Steam's own uploader (the one its screenshot manager uses).
// Steam does not document this; everything it says is written to a log so a failure can be understood and fixed.
// ---------------------------------------------------------------------------------------------
interface SteamShot {
  nAppID: number;
  strGameID?: string;
  hHandle: number;
  nCreated: number;
  bUploaded?: boolean;
  strUrl?: string;
  [k: string]: unknown;
}
const PRIVACY = { PRIVATE: 2, FRIENDS: 4, PUBLIC: 8, UNLISTED: 16 }; // Steam's own values
const steamShotsApi = (): any => {
  const api = (window as any).SteamClient?.Screenshots;
  if (!api) throw new Error("Steam's screenshot service isn't available right now.");
  return api;
};
const shotsLog: string[] = [];
const trace = (line: string) => {
  shotsLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (shotsLog.length > 120) shotsLog.shift();
};
const brief = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x))?.slice(0, 300) ?? String(v);
  } catch {
    return String(v);
  }
};

let steamCache: { t: number; list: SteamShot[] } | null = null;
async function listSteamShots(fresh = false): Promise<SteamShot[]> {
  if (!fresh && steamCache && Date.now() - steamCache.t < 15000) return steamCache.list;
  const api = steamShotsApi();
  const names = Object.keys(api).filter((k) => typeof api[k] === "function");
  trace(`SteamClient.Screenshots has: ${names.join(", ") || "(nothing)"}`);
  const tryNames = ["GetAllAppsLocalScreenshots", "GetAllLocalScreenshots", ...names.filter((k) => /LocalScreenshots?$/i.test(k))];
  for (const fn of [...new Set(tryNames)]) {
    if (typeof api[fn] !== "function") continue;
    try {
      let r = await api[fn]();
      if (r && !Array.isArray(r)) r = r.screenshots ?? r.vecScreenshots ?? (typeof r.values === "function" ? [...r.values()] : r);
      if (Array.isArray(r)) {
        trace(`${fn}() gave ${r.length} entries${r[0] ? `; first: ${brief(r[0])}` : ""}`);
        if (r.length) {
          steamCache = { t: Date.now(), list: r as SteamShot[] };
          return r as SteamShot[];
        }
      } else trace(`${fn}() gave ${brief(r)}`);
    } catch (e) {
      trace(`${fn}() failed: ${errText(e)}`);
    }
  }
  return [];
}

// Find Steam's entry for a file. Best: ask Steam where each candidate lives (GetLocalScreenshotPath) and compare the file name.
// Then: the file name in its address; last: the closest one in time for that game.
async function findSteamShot(list: SteamShot[], s: Shot): Promise<SteamShot | null> {
  const mine = list.filter((x) => (Number(x.nAppID) >>> 0) === s.appid || String(x.strGameID) === String(s.appid));
  const stem = s.name.replace(/\.[^.]+$/, "");
  const byName = mine.find((x) => typeof x.strUrl === "string" && x.strUrl.includes(stem));
  if (byName) return byName;
  const ranked = [...mine].sort((a, b) => Math.abs(Number(a.nCreated) - s.taken) - Math.abs(Number(b.nCreated) - s.taken));
  const api = (window as any).SteamClient?.Screenshots;
  if (api && typeof api.GetLocalScreenshotPath === "function") {
    for (const x of ranked.slice(0, 8)) {
      try {
        const path = await withTimeout(api.GetLocalScreenshotPath(Number(x.nAppID) >>> 0, x.hHandle), 8000);
        trace(`GetLocalScreenshotPath(${x.nAppID}, ${x.hHandle}) = ${brief(path)}`);
        if (typeof path === "string" && path.split(/[\\/]/).pop() === s.name) return x;
      } catch (e) {
        trace(`GetLocalScreenshotPath failed: ${errText(e)}`);
        break;
      }
    }
  }
  const best = ranked[0];
  return best && Math.abs(Number(best.nCreated) - s.taken) <= 300 ? best : null;
}

// Steam's own Share dialog does exactly this (found in its client code): SteamClient.Apps.SetLocalScreenshotCaption(gameId, handle, text),
// then SteamClient.Apps.SetLocalScreenshotSpoiler(gameId, handle, flag), then SteamClient.Screenshots.UploadLocalScreenshot(gameId, handle, privacy).
async function setScreenshotInfo(fn: "SetLocalScreenshotCaption" | "SetLocalScreenshotSpoiler", m: SteamShot, value: string | boolean): Promise<void> {
  const apps = (window as any).SteamClient?.Apps;
  if (!apps || typeof apps[fn] !== "function") throw new Error(`This version of Steam has no ${fn}.`);
  const gid = m.strGameID ?? String(m.nAppID);
  trace(`SteamClient.Apps.${fn}(${brief(gid)}, ${m.hHandle}, ${brief(value)})`);
  const r = await withTimeout(apps[fn](gid, m.hHandle, value), 30000);
  trace(`  returned ${brief(r)}`);
}

async function shareToHub(s: Shot, privacy: number, caption = "", spoiler = false): Promise<{ ok: boolean; text: string }> {
  trace(`--- share ${s.id} (game ${s.appid}, taken ${s.taken}) with privacy ${privacy}`);
  if (isNonSteam(s.appid)) return { ok: false, text: "Only screenshots of Steam games can go to the Community Hub." };
  if (s.edited) return { ok: false, text: "Pictures made in the editor can only be shared as artwork." };
  const api = steamShotsApi();
  const list = await listSteamShots(true);
  if (!list.length) return { ok: false, text: "Steam didn't give a list of its screenshots, so it can't upload this one." };
  const m = await findSteamShot(list, s);
  if (!m) return { ok: false, text: "Steam doesn't have this screenshot in its own list. Only screenshots taken with Steam + R1 can be shared here." };
  trace(`matched: ${brief(m)}`);
  if (m.bUploaded) return { ok: true, text: "Already on Steam. Find it under your Community screenshots." };
  if (typeof api.UploadLocalScreenshot !== "function") return { ok: false, text: "This version of Steam has no screenshot upload function." };
  const gameIds = [m.strGameID, String(m.nAppID), m.nAppID].filter((x) => x !== undefined && x !== "undefined");
  // the caption and the spoiler mark are set on Steam's own entry first, the way its Share dialog does
  const text = caption.trim().slice(0, 140);
  try {
    if (text) await setScreenshotInfo("SetLocalScreenshotCaption", m, text);
    if (spoiler) await setScreenshotInfo("SetLocalScreenshotSpoiler", m, true);
    if (text) {
      const check = (await listSteamShots(true)).find((x) => x.hHandle === m.hHandle);
      trace(`caption now: ${brief(check?.strCaption)}`);
    }
  } catch (e) {
    trace(`caption failed: ${errText(e)}`);
    return { ok: false, text: `Steam didn't accept the ${text ? "caption" : "spoiler mark"} (${errText(e)}), so nothing was uploaded. Save a report (button below) so I can see why.` };
  }
  for (const gid of [...new Set(gameIds)]) {
    try {
      trace(`UploadLocalScreenshot(${brief(gid)}, ${m.hHandle}, ${privacy})`);
      const r = await withTimeout(api.UploadLocalScreenshot(gid, m.hHandle, privacy), 180000);
      trace(`  returned ${brief(r)}`);
      const after = await listSteamShots(true);
      const again = after.find((x) => x.hHandle === m.hHandle);
      if (again?.bUploaded || r === true) return { ok: true, text: "Uploaded to the Steam Community." };
    } catch (e) {
      trace(`  failed: ${errText(e)}`);
    }
  }
  return { ok: false, text: "Steam didn't accept the upload. Save a report (button below) and send it to me so I can see what Steam said." };
}

// A test that changes nothing: call the caption function with the caption a screenshot already has.
async function dryRunCaption(): Promise<void> {
  try {
    const apps = (window as any).SteamClient?.Apps ?? {};
    for (const fn of ["SetLocalScreenshotCaption", "SetLocalScreenshotSpoiler", "SetLocalScreenshotPrivacy", "GetDetailsForScreenshotUpload"]) trace(`SteamClient.Apps.${fn}: ${typeof apps[fn] === "function" ? "present" : "MISSING"}`);
    trace(`SteamClient.Screenshots.UploadLocalScreenshot: ${typeof (window as any).SteamClient?.Screenshots?.UploadLocalScreenshot === "function" ? "present" : "MISSING"}`);
    const list = await listSteamShots();
    const m = list.find((x) => !x.bUploaded && typeof x.strCaption === "string");
    if (m) {
      await setScreenshotInfo("SetLocalScreenshotCaption", m, String(m.strCaption));
      trace("dry run done (same caption, nothing changed)");
    } else trace("dry run skipped: no screenshot that isn't uploaded yet");
  } catch (e) {
    trace(`dry run failed: ${errText(e)}`);
  }
}

async function steamReport(extra = ""): Promise<string> {
  const lines = [`Screenshot Gallery report`, `Steam client: ${(navigator.userAgent || "").slice(0, 120)}`, extra, ""];
  try {
    await listSteamShots();
    await dryRunCaption();
  } catch (e) {
    trace(`probe failed: ${errText(e)}`);
  }
  lines.push(...shotsLog);
  return lines.join("\n");
}

// Once per session, when the viewer first opens: ask Steam what it can do. If something is missing, the report is saved for you.
let autoChecked = false;
async function autoCheck(): Promise<string> {
  if (autoChecked) return "";
  autoChecked = true;
  try {
    const before = shotsLog.length;
    await dryRunCaption();
    const mine = shotsLog.slice(before).join("\n");
    if (/MISSING|failed/.test(mine) || /gave 0 entries|nothing/.test(mine)) {
      const r = await withTimeout(saveReport(await steamReport("Saved automatically: the first check found something missing.")), 15000);
      return r.ok ? `Steam sharing check found a problem. A report was saved to ${r.path}.` : "";
    }
  } catch {
    /* sharing just may not work; the report button is still there */
  }
  return "";
}

// A small round icon on a thumbnail: purple picture = sent to the artwork page.
function ShareBadges(props: { art?: boolean; hub?: boolean; edited?: boolean }) {
  if (!props.art && !props.hub && !props.edited) return null;
  const svg = { viewBox: "0 0 24 24", width: 12, height: 12, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <span className="sg-badges">
      {props.edited && (
        <span className="sg-badge edit">
          <svg {...svg}>
            <path d="M4 20l4-1 11-11-3-3L5 16z" />
          </svg>
        </span>
      )}
      {props.hub && (
        <span className="sg-badge hub">
          <svg {...svg}>
            <path d="M12 3v12M7 8l5-5 5 5M5 21h14" />
          </svg>
        </span>
      )}
      {props.art && (
      <span className="sg-badge art">
        <svg {...svg}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="M4 18l5-5 4 4 3-3 4 4" />
        </svg>
      </span>
      )}
    </span>
  );
}

// Steam's artwork limit is 5 MB; stay a little under it.
const ART_LIMIT = 4_800_000;

// Opens the game's artwork upload page (the one its Community Hub links to) and puts the file into the page's file box for you:
// Gaming Mode's browser can't open a file picker. The plugin's background part does it once the page has loaded.
function openArtworkPage(appid: number, game: string, display: string, path: string, ids: string[], onShared: (ids: string[], kind: "hub" | "art") => void) {
  const page = `https://steamcommunity.com/sharedfiles/edititem/${appid}/3/`;
  const nav: any = Navigation;
  if (typeof nav.NavigateToSteamWeb === "function") nav.NavigateToSteamWeb(page);
  else Navigation.NavigateToExternalWeb(page);
  toaster.toast({ title: `Artwork for ${game}`, body: "Attaching your picture to the page…", duration: 8000 });
  const failed = (why: string) =>
    toaster.toast({ title: "Couldn't attach the picture automatically", body: `${why} Choose it by hand if you can: ${display}`, duration: 30000 });
  withTimeout(attachArtwork(path), 100000)
    .then((r) => {
      if (!r.ok) {
        failed(r.note);
        return;
      }
      markShared(ids, "art").catch(() => {});
      onShared(ids, "art");
      toaster.toast({ title: "Picture attached", body: "Add a title, tick the \"my own work\" box, then press Save and Continue.", duration: 20000 });
    })
    .catch((e) => failed(errText(e)));
}

// ---------------------------------------------------------------------------------------------
// Photo editor: one screenshot, or two joined into one picture. Drawn on a canvas, saved as a new JPEG.
// ---------------------------------------------------------------------------------------------
type Layout = "single" | "stack" | "side";
interface EditOpts {
  swap: boolean;
  gap: number;
  bright: number;
  contrast: number;
  sat: number;
  rot: number;
  flip: boolean;
  crop: number;
}
const DEFAULT_EDIT: EditOpts = { swap: false, gap: 0, bright: 100, contrast: 100, sat: 100, rot: 0, flip: false, crop: 0 };
const CROPS = [
  { label: "Original", r: 0 },
  { label: "16:9", r: 16 / 9 },
  { label: "16:10", r: 16 / 10 },
  { label: "4:3", r: 4 / 3 },
  { label: "Square", r: 1 },
];
const makeCanvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

// Same maths as the CSS filter (brightness, then contrast, then colour), for a canvas that has no ctx.filter.
function adjustPixels(c: HTMLCanvasElement, o: EditOpts) {
  const g = c.getContext("2d")!;
  const im = g.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  const b = o.bright / 100;
  const k = o.contrast / 100;
  const s = o.sat / 100;
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < d.length; i += 4) {
    let r = clamp(d[i] * b);
    let gr = clamp(d[i + 1] * b);
    let bl = clamp(d[i + 2] * b);
    r = clamp((r - 127.5) * k + 127.5);
    gr = clamp((gr - 127.5) * k + 127.5);
    bl = clamp((bl - 127.5) * k + 127.5);
    const y = 0.299 * r + 0.587 * gr + 0.114 * bl;
    d[i] = clamp(y + (r - y) * s);
    d[i + 1] = clamp(y + (gr - y) * s);
    d[i + 2] = clamp(y + (bl - y) * s);
  }
  g.putImageData(im, 0, 0);
}

// 1) place the picture(s) with the colour changes, 2) rotate / flip, 3) crop to a shape, 4) shrink if bigger than maxDim
function renderEdit(imgs: HTMLImageElement[], layout: Layout, o: EditOpts, maxDim: number): HTMLCanvasElement {
  let list = imgs.slice(0, layout === "single" ? 1 : 2);
  if (o.swap && list.length > 1) list = [list[1], list[0]];
  const gap = list.length > 1 ? o.gap : 0;
  const boxes: { img: HTMLImageElement; x: number; y: number; w: number; h: number }[] = [];
  let cw = 0;
  let ch = 0;
  if (layout === "stack" && list.length > 1) {
    cw = Math.min(...list.map((i) => i.naturalWidth));          // same width, so nothing is stretched up
    let y = 0;
    for (const img of list) {
      const h = Math.round((img.naturalHeight * cw) / img.naturalWidth);
      boxes.push({ img, x: 0, y, w: cw, h });
      y += h + gap;
    }
    ch = y - gap;
  } else if (layout === "side" && list.length > 1) {
    ch = Math.min(...list.map((i) => i.naturalHeight));         // same height
    let x = 0;
    for (const img of list) {
      const w = Math.round((img.naturalWidth * ch) / img.naturalHeight);
      boxes.push({ img, x, y: 0, w, h: ch });
      x += w + gap;
    }
    cw = x - gap;
  } else {
    cw = list[0].naturalWidth;
    ch = list[0].naturalHeight;
    boxes.push({ img: list[0], x: 0, y: 0, w: cw, h: ch });
  }
  const c1 = makeCanvas(cw, ch);
  const g1 = c1.getContext("2d")!;
  g1.fillStyle = "#000";
  g1.fillRect(0, 0, c1.width, c1.height);
  const plain = o.bright === 100 && o.contrast === 100 && o.sat === 100;
  const native = "filter" in g1;
  if (native && !plain) g1.filter = `brightness(${o.bright}%) contrast(${o.contrast}%) saturate(${o.sat}%)`;
  for (const b of boxes) g1.drawImage(b.img, b.x, b.y, b.w, b.h);
  if (!native && !plain) adjustPixels(c1, o);

  const turned = o.rot % 180 !== 0;
  const c2 = makeCanvas(turned ? c1.height : c1.width, turned ? c1.width : c1.height);
  const g2 = c2.getContext("2d")!;
  g2.translate(c2.width / 2, c2.height / 2);
  if (o.flip) g2.scale(-1, 1);
  g2.rotate((o.rot * Math.PI) / 180);
  g2.drawImage(c1, -c1.width / 2, -c1.height / 2);

  const ratio = CROPS[o.crop]?.r ?? 0;
  let sw = c2.width;
  let sh = c2.height;
  if (ratio > 0) {
    if (sw / sh > ratio) sw = sh * ratio;
    else sh = sw / ratio;
  }
  const k = Math.min(1, maxDim / Math.max(sw, sh));
  const c3 = makeCanvas(sw * k, sh * k);
  c3.getContext("2d")!.drawImage(c2, (c2.width - sw) / 2, (c2.height - sh) / 2, sw, sh, 0, 0, c3.width, c3.height);
  return c3;
}

// A JPEG of the canvas no bigger than `limit` bytes: lowers the quality, then the size, until it fits.
function encodeUnder(canvas: HTMLCanvasElement, limit: number): string {
  let c = canvas;
  for (let round = 0; round < 6; round++) {
    for (const q of [0.92, 0.85, 0.78, 0.7, 0.6]) {
      const url = c.toDataURL("image/jpeg", q);
      const b64 = url.split(",")[1] ?? "";
      if (b64.length * 0.75 <= limit) return b64;
    }
    const smaller = makeCanvas(c.width * 0.8, c.height * 0.8);
    smaller.getContext("2d")!.drawImage(c, 0, 0, smaller.width, smaller.height);
    c = smaller;
  }
  return c.toDataURL("image/jpeg", 0.6).split(",")[1] ?? "";
}

function Editor(props: { shots: Shot[]; layout: Layout; names: Record<string, string>; gameOf: (appid: number) => string; onClose: () => void; onShared: (ids: string[], kind: "hub" | "art") => void }) {
  const [imgs, setImgs] = useState<HTMLImageElement[] | null>(null);
  const [layout, setLayout] = useState<Layout>(props.layout);
  const [o, setO] = useState<EditOpts>(DEFAULT_EDIT);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [dim, setDim] = useState("");
  const cv = useRef<HTMLCanvasElement>(null);
  const set = (p: Partial<EditOpts>) => setO((c) => ({ ...c, ...p }));
  const two = props.shots.length > 1;

  useEffect(() => {
    let live = true;
    Promise.all(
      props.shots.map(async (s) => {
        const r = await withTimeout(getSource(s.id), 60000);
        if (!r.ok || !r.url) throw new Error(r.note || "Couldn't open that screenshot.");
        return new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("Couldn't read that screenshot."));
          im.src = r.url;
        });
      }),
    )
      .then((l) => live && setImgs(l))
      .catch((e) => live && setMsg(errText(e)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!imgs || !cv.current) return;
    try {
      const out = renderEdit(imgs, layout, o, 1100);
      cv.current.width = out.width;
      cv.current.height = out.height;
      cv.current.getContext("2d")!.drawImage(out, 0, 0);
      const full = renderEdit(imgs, layout, o, 4096);
      setDim(`${full.width} \u00d7 ${full.height}`);
    } catch (e) {
      setMsg(errText(e));
    }
  }, [imgs, layout, o]);

  // The game the picture belongs to: the first screenshot on screen (top or left).
  const lead = props.shots[o.swap && two && layout !== "single" ? 1 : 0];
  const save = async (): Promise<{ display: string; path: string } | null> => {
    if (!imgs) return null;
    const jpeg = encodeUnder(renderEdit(imgs, layout, o, 4096), ART_LIMIT);
    const r = await withTimeout(saveEdit(jpeg, lead.appid, props.names), 120000);
    if (!r.ok) {
      setMsg(r.note || "Couldn't save it.");
      return null;
    }
    return { display: r.display, path: r.path };
  };
  const doSave = async () => {
    setBusy(true);
    try {
      const d = await save();
      if (d) setMsg(`Saved a copy: ${d.display}. The original is untouched.`);
    } catch (e) {
      setMsg(errText(e));
    }
    setBusy(false);
  };
  const doArtwork = async () => {
    if (isNonSteam(lead.appid)) {
      setMsg("Non-Steam games don't have a Community Hub, so there's nowhere to post artwork. You can still save a copy.");
      return;
    }
    setBusy(true);
    try {
      const d = await save();
      if (d) {
        setMsg(`Saved. Opening the ${props.gameOf(lead.appid)} artwork page and attaching it for you.`);
        openArtworkPage(lead.appid, props.gameOf(lead.appid), d.display, d.path, props.shots.map((x) => x.id), props.onShared);
      }
    } catch (e) {
      setMsg(errText(e));
    }
    setBusy(false);
  };
  const changed = JSON.stringify(o) !== JSON.stringify(DEFAULT_EDIT);

  return (
    <Focusable className="sg-edit" flow-children="horizontal" onCancel={props.onClose} onCancelActionDescription="Close editor">
      <div className="pv">
        <canvas ref={cv} />
        {!imgs && <div className="sg-cap sg-loading">{msg || "Loading…"}</div>}
      </div>
      <Focusable className="ctl" flow-children="vertical">
        <div className="sg-title" style={{ fontSize: 18 }}>{two ? "Combine two screenshots" : "Edit screenshot"}</div>
        <div className="sg-sub" style={{ whiteSpace: "normal" }}>{dim ? `Result: ${dim}` : ""}</div>
        {msg && imgs && <div className="sg-status">{msg}</div>}
        {two && (
          <>
            <Focusable className="row" flow-children="horizontal">
              <DialogButton preferredFocus className={layout === "stack" ? "sg-pick" : ""} onClick={() => setLayout("stack")}>Top / bottom</DialogButton>
              <DialogButton className={layout === "side" ? "sg-pick" : ""} onClick={() => setLayout("side")}>Side by side</DialogButton>
              <DialogButton className={o.swap ? "sg-pick" : ""} onClick={() => set({ swap: !o.swap })}>Swap</DialogButton>
            </Focusable>
            <SliderField label="Gap between them" value={o.gap} min={0} max={40} step={4} showValue valueSuffix=" px" onChange={(v: number) => set({ gap: v })} />
          </>
        )}
        <SliderField label="Brightness" value={o.bright} min={50} max={150} step={5} showValue valueSuffix="%" onChange={(v: number) => set({ bright: v })} />
        <SliderField label="Contrast" value={o.contrast} min={50} max={150} step={5} showValue valueSuffix="%" onChange={(v: number) => set({ contrast: v })} />
        <SliderField label="Colour" value={o.sat} min={0} max={200} step={10} showValue valueSuffix="%" onChange={(v: number) => set({ sat: v })} />
        <Focusable className="row" flow-children="horizontal">
          <DialogButton preferredFocus={!two} onClick={() => set({ rot: (o.rot + 90) % 360 })}>Rotate</DialogButton>
          <DialogButton className={o.flip ? "sg-pick" : ""} onClick={() => set({ flip: !o.flip })}>Mirror</DialogButton>
          <DialogButton onClick={() => set({ crop: (o.crop + 1) % CROPS.length })}>Crop: {CROPS[o.crop].label}</DialogButton>
        </Focusable>
        <Focusable className="row" flow-children="horizontal">
          <DialogButton disabled={!changed && layout === props.layout} onClick={() => (setO(DEFAULT_EDIT), setLayout(props.layout))}>Reset</DialogButton>
          <DialogButton onClick={props.onClose}>Close</DialogButton>
        </Focusable>
        <DialogButton className="sg-wide" disabled={busy || !imgs} onClick={doSave}>Save a copy</DialogButton>
        <DialogButton className="sg-wide" disabled={busy || !imgs} onClick={doArtwork}>{two ? "Share combined as Artwork" : "Share edit as Artwork"}</DialogButton>
      </Focusable>
    </Focusable>
  );
}

// Steam gives its buttons their own margins and heights, so sizes are set here (!important beats Steam's rules).
const CSS = `
.sg-line { font-size: 12px; line-height: 1.45; white-space: pre-line; width: 100%; color: #cfd3d7; }
/* Steam draws its status bar over the top 40px and its button-hint footer over the bottom ~52px: keep everything clear of both. */
.sg-page { margin-top: 40px; height: calc(100% - 40px); display: flex; box-sizing: border-box; padding: 6px 20px 52px; gap: 18px; position: relative; overflow: hidden; }

/* ---- game list ---- */
.sg-side { width: 252px; flex: none; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; overflow-x: hidden; padding: 4px 6px 8px 4px; box-sizing: border-box; }
.sg-brand { padding: 0 6px 6px; }
.sg-brand .t { font-size: 20px; font-weight: bold; color: #fff; line-height: 1.2; }
.sg-brand .s { font-size: 12px; color: #9aa3ad; margin-top: 3px; }
.sg-game { flex: 0 0 auto !important; margin: 0 !important; width: 100% !important; min-width: 0 !important; min-height: 50px !important; height: auto !important; max-height: none !important; padding: 7px 12px !important;
  display: flex !important; flex-direction: column !important; align-items: flex-start !important; justify-content: center !important; text-align: left !important; box-sizing: border-box !important; overflow: hidden !important; }
.sg-game .n { display: block; flex: none; line-height: 1.3; font-size: 14px; font-weight: bold; color: #fff; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-game .c { display: block; flex: none; line-height: 1.3; font-size: 11px; color: #9aa3ad; margin-top: 2px; }
.sg-game.sg-on { background: rgba(26,159,255,0.28) !important; box-shadow: inset 4px 0 0 #1a9fff; }
.sg-game.sg-back { min-height: 38px !important; padding: 4px 12px !important; margin-bottom: 4px !important; }
.sg-divider { flex: none; height: 1px; margin: 4px 6px; background: rgba(255,255,255,0.1); }

/* ---- header and grid ---- */
.sg-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.sg-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 40px; flex: none; }
.sg-head .l { min-width: 0; }
.sg-head .r { display: flex; gap: 10px; align-items: center; flex: none; }
.sg-title { font-size: 24px; font-weight: bold; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.2; }
.sg-sub { font-size: 13px; color: #9aa3ad; white-space: nowrap; }
.sg-flash { font-size: 12px; color: #fff; background: rgba(26,159,255,0.25); border-radius: 12px; padding: 4px 12px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-headbtn { margin: 0 !important; width: auto !important; min-width: 0 !important; height: 36px !important; min-height: 36px !important; padding: 0 18px !important; font-size: 13px !important; display: flex !important; align-items: center !important; justify-content: center !important; }
.sg-grid { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); grid-auto-rows: auto; gap: 12px; align-content: start; padding: 6px 6px 14px; }
/* The 16:10 box is made with padding (not aspect-ratio): the grid sized the rows too small with aspect-ratio and the thumbnails piled up. */
.sg-cell { position: relative; display: block; width: 100%; height: 0; padding-top: 62.5%; border-radius: 7px; overflow: hidden; background: #1b222b; box-sizing: border-box; transition: transform 0.12s ease, box-shadow 0.12s ease; }
.sg-cell img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.sg-cell .nop { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #9aa3ad; }
.sg-cell-focus { box-shadow: 0 0 0 3px #1a9fff, 0 8px 20px rgba(0,0,0,0.55); transform: scale(1.03); z-index: 2; }
.sg-cell .tag { position: absolute; left: 0; right: 0; bottom: 0; padding: 16px 8px 5px; font-size: 11px; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,0.8)); display: flex; gap: 8px; align-items: baseline; padding-right: 54px; box-sizing: border-box; }
.sg-cell .tag .d { flex: none; white-space: nowrap; }
.sg-cell .tag .g { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #bcd; }
.sg-cell .star { position: absolute; top: 5px; right: 7px; font-size: 18px; color: #ffcf40; text-shadow: 0 0 4px #000; }
.sg-badges { position: absolute; right: 6px; bottom: 5px; display: flex; gap: 4px; }
.sg-badge { width: 20px; height: 20px; border-radius: 10px; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; }
.sg-badge.hub { color: #1a9fff; }
.sg-badge.art { color: #c58bff; }
.sg-empty { padding: 36px 10px; font-size: 15px; color: #9aa3ad; grid-column: 1 / -1; text-align: center; }
.sg-cell.sg-sel { box-shadow: 0 0 0 3px #1a9fff; }
.sg-cell.sg-sel img { opacity: 0.65; }
.sg-check { position: absolute; left: 6px; top: 5px; width: 24px; height: 24px; border-radius: 12px; background: #1a9fff; color: #fff; font-size: 15px; font-weight: bold;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 0 4px #000; }
.sg-ring { position: absolute; left: 6px; top: 5px; width: 20px; height: 20px; border-radius: 12px; border: 2px solid rgba(255,255,255,0.85); background: rgba(0,0,0,0.35); }
.sg-more { grid-column: 1 / -1; margin: 0 !important; height: 40px !important; min-height: 40px !important; }
.sg-sentinel { grid-column: 1 / -1; height: 2px; }

/* ---- select bar ---- */
.sg-selbar { flex: none; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 4px 0; border-top: 1px solid rgba(255,255,255,0.1); }
.sg-selbar .txt { flex: 1 1 100%; font-size: 13px; color: #cfd3d7; }
.sg-selbar > *:not(.txt) { margin: 0 !important; width: auto !important; min-width: 0 !important; height: 36px !important; min-height: 36px !important; padding: 0 14px !important; font-size: 13px !important; display: flex !important; align-items: center !important; justify-content: center !important; }

/* ---- viewer: picture on the left, actions on the right ---- */
.sg-view { position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: rgba(6,9,13,0.985); z-index: 50; display: flex; gap: 16px; padding: 8px 20px 52px; box-sizing: border-box; }
.sg-view .stage { flex: 1 1 auto; min-width: 0; position: relative; }
.sg-view .stage img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; border-radius: 4px; }
.sg-view .stage .sg-cap { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.sg-view .panel { width: 312px; flex: none; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; overflow-x: hidden; padding: 2px 6px 8px 2px; box-sizing: border-box; }
.sg-view .ttl { font-size: 19px; font-weight: bold; color: #fff; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.sg-view .meta { font-size: 12.5px; color: #9aa3ad; line-height: 1.55; }
.sg-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.sg-chip { font-size: 11.5px; border-radius: 11px; padding: 3px 10px; background: rgba(255,255,255,0.1); color: #dde; }
.sg-chip.hub { background: rgba(26,159,255,0.28); color: #bfe3ff; }
.sg-chip.art { background: rgba(197,139,255,0.25); color: #e6ceff; }
.sg-chip.fav { background: rgba(255,207,64,0.2); color: #ffe08a; }
.sg-act { margin: 0 !important; width: 100% !important; min-width: 0 !important; height: 42px !important; min-height: 42px !important; padding: 0 12px !important; font-size: 14px !important; line-height: 1 !important;
  display: flex !important; align-items: center !important; justify-content: center !important; box-sizing: border-box !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-row2 { display: flex; gap: 8px; }
.sg-row2 > * { flex: 1 1 0; }
.sg-view .gap { flex: none; height: 4px; }
.sg-formlbl { font-size: 13px; font-weight: bold; color: #fff; }
.sg-count { font-size: 11px; color: #9aa3ad; text-align: right; margin-top: -4px; }
.sg-hint { font-size: 11.5px; color: #8a939d; line-height: 1.4; }
.sg-status { flex: none; font-size: 13px; line-height: 1.35; color: #fff; background: rgba(26,159,255,0.22); border-radius: 6px; padding: 7px 12px; max-width: 100%; }
.sg-cap { flex: none; font-size: 13px; line-height: 1.35; color: #cfd3d7; text-align: center; max-width: 100%; }

/* ---- editor ---- */
.sg-edit { position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: rgba(6,9,13,0.99); z-index: 60; display: flex; gap: 16px; padding: 8px 20px 52px; box-sizing: border-box; }
.sg-edit .pv { flex: 1 1 auto; min-width: 0; position: relative; }
.sg-edit canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; border-radius: 4px; }
.sg-edit .sg-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.sg-edit .ctl { width: 370px; flex: none; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; overflow-x: hidden; padding: 2px 6px 8px 2px; box-sizing: border-box; }
.sg-edit .row { display: flex; gap: 8px; }
.sg-edit .row > *, .sg-edit .sg-wide { margin: 0 !important; min-width: 0 !important; height: 40px !important; min-height: 40px !important; padding: 0 8px !important; font-size: 13px !important; }
.sg-edit .row > * { flex: 1 1 0; }
.sg-edit .sg-wide { width: 100% !important; flex: none; }
.sg-pick { background: rgba(26,159,255,0.4) !important; box-shadow: inset 0 0 0 2px #1a9fff; }
.sg-badge.edit { color: #7ee0a0; }
.sg-chip.edit { background: rgba(126,224,160,0.22); color: #c8f5d8; }

/* ---- sheets: filter, album and phone panels over the gallery ---- */
.sg-sheet { position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: rgba(6,9,13,0.97); z-index: 70; display: flex; justify-content: center; padding: 8px 20px 52px; box-sizing: border-box; }
.sg-sheet .box { width: 720px; max-width: 100%; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; overflow-x: hidden; padding: 4px 8px 8px 4px; box-sizing: border-box; }
.sg-sheet .hd { font-size: 22px; font-weight: bold; color: #fff; }
.sg-seg { display: flex; flex-wrap: wrap; gap: 6px; }
.sg-seg > * { margin: 0 !important; width: auto !important; min-width: 0 !important; flex: 1 1 auto !important; height: 38px !important; min-height: 38px !important; padding: 0 12px !important; font-size: 13px !important; }
.sg-sheet .btns { display: flex; gap: 8px; flex-wrap: wrap; }
.sg-sheet .btns > * { margin: 0 !important; width: auto !important; min-width: 0 !important; flex: 1 1 auto !important; height: 40px !important; min-height: 40px !important; padding: 0 14px !important; font-size: 14px !important; }
.sg-phone { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }
.sg-phone svg { border-radius: 8px; flex: none; }
.sg-url { font-size: 15px; font-weight: bold; color: #fff; word-break: break-all; background: rgba(255,255,255,0.08); border-radius: 6px; padding: 8px 12px; }
`;

// ---------------------------------------------------------------------------------------------
// Quick Access panel: summary, tools
// ---------------------------------------------------------------------------------------------

function Content() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [lines, setLines] = useState<CheckLine[] | null>(null);
  const [working, setWorking] = useState(false);

  const load = async (rescan = false) => {
    try {
      setOv(await withTimeout(getOverview(rescan), 15000));
      setError("");
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => {
    load(true);
  }, []);

  if (!ov) {
    return (
      <PanelSection title="Screenshots">
        <style>{CSS}</style>
        <PanelSectionRow>
          <Field
            label={error ? "Screenshot Gallery couldn't start" : "Loading…"}
            description={error ? `${error} Restart Decky, or look at the log in ~/homebrew/logs/Screenshot Gallery/ for the reason.` : undefined}
          />
        </PanelSectionRow>
        {error && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => load(true)}>
              Retry
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <PanelSection title="Screenshots">
        <PanelSectionRow>
          <Field
            label={ov.total ? `${shots(ov.total)}, ${fmtSize(ov.size)}` : "No screenshots found"}
            description={ov.total ? `${ov.games.length} games, ${ov.favorites} favorites. This plugin never deletes screenshots.` : "Take one with Steam + R1, or use Check folders under Tools."}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={!ov.total}
            onClick={() => {
              Router.CloseSideMenus();
              Navigation.Navigate(ROUTE);
            }}
          >
            Open gallery
          </ButtonItem>
        </PanelSectionRow>
        {msg && (
          <PanelSectionRow>
            <Field label="Status" description={msg} />
          </PanelSectionRow>
        )}
      </PanelSection>

      {ov.trash.count > 0 && (
        <PanelSection title="Moved by an older version">
          <PanelSectionRow>
            <Field
              label={`${shots(ov.trash.count)}, ${fmtSize(ov.trash.size)}`}
              description="An older version of this plugin moved these out of Steam's folder. They are kept (never removed) until you restore them."
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={working}
              onClick={async () => {
                setWorking(true);
                try {
                  const r = await withTimeout(restoreAll(), 60000);
                  setOv(r.overview);
                  setMsg(`Restored ${r.restored}.${r.skipped ? ` ${r.skipped} were left because a file with that name exists.` : ""}`);
                } catch (e) {
                  setMsg(errText(e));
                }
                setWorking(false);
              }}
            >
              Restore everything
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      <PanelSection title="Tools">
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={working} onClick={() => load(true)}>
            Rescan
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={working}
            description="Copies every screenshot to Pictures/Steam Screenshots/<game name>/, named by date. Nothing is moved."
            onClick={async () => {
              setWorking(true);
              setMsg("Copying…");
              try {
                const names: Record<string, string> = {};
                for (const g of ov.games) names[String(g.appid)] = gameName(g.appid, g.hint);
                const r = await withTimeout(exportOrganized(names), 600000);
                setMsg(`Copied ${r.copied} (skipped ${r.skipped} already there) to ${r.folder}.`);
              } catch (e) {
                setMsg(errText(e));
              }
              setWorking(false);
            }}
          >
            Export an organized copy
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={working}
            description="Shows where Steam's screenshots were found. Useful if the gallery looks empty."
            onClick={async () => {
              setWorking(true);
              try {
                const r = await withTimeout(checkFolders(), 30000);
                setLines(r.lines);
              } catch (e) {
                setMsg(errText(e));
              }
              setWorking(false);
            }}
          >
            Check folders
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={working}
            description="Asks Steam what its screenshot service can do and saves a report to Downloads. Use it if Share as Screenshot doesn't work."
            onClick={async () => {
              setWorking(true);
              try {
                const text = await steamReport();
                const r = await withTimeout(saveReport(text), 15000);
                setMsg(r.ok ? `Saved ${r.path}. Send me that file.` : r.note || "Couldn't save the report.");
              } catch (e) {
                setMsg(errText(e));
              }
              setWorking(false);
            }}
          >
            Check Steam sharing
          </ButtonItem>
        </PanelSectionRow>
        {lines && (
          <PanelSectionRow>
            <div className="sg-line">{lines.map((l) => `${l.ok ? "\u2713" : "\u2717"} ${l.label}: ${l.detail}`).join("\n")}</div>
          </PanelSectionRow>
        )}
      </PanelSection>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Sheets that open over the gallery: filters, albums, send to phone
// ---------------------------------------------------------------------------------------------

// A row of choices (a segmented control: Steam's dropdowns don't work well with a controller).
function Seg<T extends string | number>(props: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void; first?: boolean }) {
  return (
    <>
      <div className="sg-formlbl">{props.label}</div>
      <Focusable className="sg-seg" flow-children="horizontal">
        {props.options.map(([v, text], i) => (
          <DialogButton key={String(v)} className={props.value === v ? "sg-pick" : ""} preferredFocus={props.first && i === 0} onClick={() => props.onPick(v)}>
            {text}
          </DialogButton>
        ))}
      </Focusable>
    </>
  );
}

function FilterSheet(props: { value: Filters; shown: number; onChange: (f: Filters) => void; onClose: () => void }) {
  const f = props.value;
  const set = (p: Partial<Filters>) => props.onChange({ ...f, ...p });
  return (
    <Focusable className="sg-sheet" flow-children="vertical" onCancel={props.onClose} onCancelActionDescription="Done">
      <Focusable className="box" flow-children="vertical">
        <div className="hd">Sort and filter</div>
        <div className="sg-hint">{shots(props.shown)} match right now.</div>
        <Seg first label="Sort by" value={f.sort} onPick={(v) => set({ sort: v })} options={[["new", "Newest"], ["old", "Oldest"], ["big", "Largest"], ["small", "Smallest"], ["game", "Game"]]} />
        <Seg label="Taken" value={f.days} onPick={(v) => set({ days: v })} options={[[0, "Any time"], [1, "Today"], [7, "Last 7 days"], [30, "Last 30 days"], [365, "Last year"]]} />
        <Seg label="File size" value={f.size} onPick={(v) => set({ size: v })} options={[["any", "Any"], ["small", "Under 1 MB"], ["medium", "1 to 3 MB"], ["large", "Over 3 MB"]]} />
        <div className="sg-formlbl">Game name contains</div>
        <TextField value={f.q} onChange={(e: any) => set({ q: String(e?.target?.value ?? "") })} />
        <div className="btns">
          <DialogButton onClick={() => props.onChange({ ...NO_FILTERS })}>Reset</DialogButton>
          <DialogButton className="sg-pick" onClick={props.onClose}>Done</DialogButton>
        </div>
      </Focusable>
    </Focusable>
  );
}

function AlbumSheet(props: { ids: string[]; albums: { name: string; count: number }[]; onDone: (msg: string, created?: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const add = async (album: string) => {
    setBusy(true);
    try {
      const r = await withTimeout(albumAdd(album, props.ids), 20000);
      props.onDone(r.added ? `Added ${shots(r.added)} to ${album}` : `Already in ${album}`);
    } catch (e) {
      setMsg(errText(e));
    }
    setBusy(false);
  };
  const create = async () => {
    setBusy(true);
    try {
      const c = await withTimeout(createAlbum(name), 15000);
      if (!c.ok) {
        setMsg(c.note || "Couldn't create it.");
      } else {
        const r = await withTimeout(albumAdd(c.name, props.ids), 20000);
        props.onDone(`Added ${shots(r.added)} to the new album ${c.name}`, c.name);
      }
    } catch (e) {
      setMsg(errText(e));
    }
    setBusy(false);
  };
  return (
    <Focusable className="sg-sheet" flow-children="vertical" onCancel={props.onClose} onCancelActionDescription="Cancel">
      <Focusable className="box" flow-children="vertical">
        <div className="hd">Add {shots(props.ids.length)} to an album</div>
        {msg && <div className="sg-status">{msg}</div>}
        {props.albums.length > 0 && (
          <Focusable className="sg-seg" flow-children="horizontal">
            {props.albums.map((a, i) => (
              <DialogButton key={a.name} preferredFocus={i === 0} disabled={busy} onClick={() => add(a.name)}>
                {a.name} ({a.count})
              </DialogButton>
            ))}
          </Focusable>
        )}
        <div className="sg-formlbl">Or make a new album</div>
        <TextField value={name} onChange={(e: any) => setName(String(e?.target?.value ?? ""))} />
        <div className="btns">
          <DialogButton className="sg-pick" disabled={busy || !name.trim()} onClick={create}>Create and add</DialogButton>
          <DialogButton onClick={props.onClose}>Cancel</DialogButton>
        </div>
      </Focusable>
    </Focusable>
  );
}

function PhoneSheet(props: { ids: string[]; onClose: () => void }) {
  const [link, setLink] = useState<{ url: string; count: number } | null>(null);
  const [left, setLeft] = useState(0);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    withTimeout(phoneStart(props.ids), 20000)
      .then((r) => {
        if (!live) return;
        if (r.ok) (setLink({ url: r.url, count: r.count }), setLeft(r.seconds));
        else setErr(r.note || "Couldn't start.");
      })
      .catch((e) => live && setErr(errText(e)));
    return () => {
      live = false;
      phoneStop().catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!link) return;
    const t = window.setInterval(() => {
      withTimeout(phoneStatus(), 8000)
        .then((r) => (setLeft(r.left), !r.open && props.onClose()))
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(t);
  }, [link]);
  return (
    <Focusable className="sg-sheet" flow-children="vertical" onCancel={props.onClose} onCancelActionDescription="Stop sharing">
      <Focusable className="box" flow-children="vertical">
        <div className="hd">Send to your phone</div>
        {err && <div className="sg-status">{err}</div>}
        {!link && !err && <div className="sg-cap">Opening a link on your home network…</div>}
        {link && (
          <>
            <div className="sg-phone">
              <QR text={link.url} size={230} />
              <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="sg-cap" style={{ textAlign: "left" }}>
                  1. Connect your phone to the same Wi-Fi as this Steam Deck.
                  <br />
                  2. Scan the code (or type the address below).
                  <br />
                  3. Tap a picture, then press and hold it to save it.
                </div>
                <div className="sg-url">{link.url}</div>
              </div>
            </div>
            <div className="sg-hint">
              {shots(link.count)} shared. Anyone on your Wi-Fi who has this link can see them until you stop it or it closes by itself ({Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left).
              The link only works while this screen is open.
            </div>
          </>
        )}
        <div className="btns">
          <DialogButton preferredFocus className="sg-pick" onClick={props.onClose}>{link ? "Stop sharing" : "Close"}</DialogButton>
        </div>
      </Focusable>
    </Focusable>
  );
}

// ---------------------------------------------------------------------------------------------
// Full-screen gallery
// ---------------------------------------------------------------------------------------------

function GalleryPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [appid, setAppid] = useState(shared.appid);
  const [onlyFav, setOnlyFav] = useState(shared.onlyFav);
  const [album, setAlbum] = useState(shared.album);
  const [filters, setFilters] = useState<Filters>(shared.filters);
  const [sheet, setSheet] = useState<null | { kind: "filter" } | { kind: "album"; ids: string[] } | { kind: "phone"; ids: string[] }>(null);
  const [hubPick, setHubPick] = useState(false);
  const [caption, setCaption] = useState("");
  const [spoiler, setSpoiler] = useState(false);
  const [reportable, setReportable] = useState(false);
  const [confirmAlbum, setConfirmAlbum] = useState(false);
  const [items, setItems] = useState<Shot[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [flash, setFlash] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<{ count: number; size: number; favorites: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareMsg, setShareMsg] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [editing, setEditing] = useState<{ ids: string[]; layout: Layout } | null>(null);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);     // the thumbnail to put focus back on when an overlay closes
  const [touchedShare, setTouchedShare] = useState(false);          // the viewer's share buttons were used: focus goes back to them, not to Favorite
  const loadingRef = useRef(false);
  const tokenRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<() => void>(() => undefined);

  // show a share icon right away
  const flag = (ids: string[], kind: "hub" | "art") => setItems((cur) => cur.map((x) => (ids.includes(x.id) ? { ...x, [kind]: true } : x)));
  const loadPage = async (offset: number) => {
    if (offset > 0 && loadingRef.current) return;
    const tok = offset === 0 ? ++tokenRef.current : tokenRef.current;     // a slow answer for a game you already left is ignored
    loadingRef.current = true;
    setLoading(true);
    try {
      const r = await withTimeout(getShots(appid, offset, onlyFav, buildOpts(filters, album, ov?.games ?? [])), 30000);
      if (tok !== tokenRef.current) return;
      setItems((cur) => (offset === 0 ? r.items : [...cur, ...r.items]));
      setTotal(r.total);
      setError("");
    } catch (e) {
      if (tok === tokenRef.current) setError(errText(e));
    } finally {
      if (tok === tokenRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    withTimeout(getOverview(false), 15000)
      .then(setOv)
      .catch((e) => setError(errText(e)));
  }, []);
  const filterKey = JSON.stringify(filters) + (filters.q ? `:${ov?.games.length ?? 0}` : "");
  useEffect(() => {
    shared.appid = appid;
    shared.onlyFav = onlyFav;
    shared.album = album;
    shared.filters = filters;
    setConfirmAlbum(false);
    setFocusIdx(null);
    setItems([]);
    setTotal(0);
    setView(null);
    setSel(new Set());
    loadPage(0);
  }, [appid, onlyFav, album, filterKey]);

  // what the selection holds (size, favorites), a moment after it stops changing
  useEffect(() => {
    if (sel.size === 0) {
      setInfo(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      withTimeout(summarize([...sel]), 20000)
        .then((r) => live && setInfo(r))
        .catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [sel]);

  useEffect(() => {
    if (view !== null) setFocusIdx(view);
  }, [view]);

  // the big picture
  useEffect(() => {
    if (view === null || !items[view]) return;
    setUrl("");
    setNote("");
    setShareMsg("");
    setHubPick(false);
    setCaption("");
    setSpoiler(false);
    setTouchedShare(false);
    let live = true;
    withTimeout(getImage(items[view].id), 30000)
      .then((r) => {
        if (!live) return;
        setUrl(r.url);
        setNote(r.note);
      })
      .catch((e) => live && setNote(errText(e)));
    return () => {
      live = false;
    };
  }, [view, items[view ?? 0]?.id]);

  // When the viewer opens: is this one already on Steam (then Share as Screenshot is greyed out)? And the first time, check what Steam can do.
  useEffect(() => {
    if (view === null || !items[view]) return;
    const s = items[view];
    if (isNonSteam(s.appid) || s.edited) return;
    let live = true;
    (async () => {
      try {
        const list = await listSteamShots();
        const m = await findSteamShot(list, s);
        if (live && m?.bUploaded && !s.hub) {
          flag([s.id], "hub");
          markShared([s.id], "hub").catch(() => undefined);
        }
      } catch {
        /* Steam's list isn't available: the button stays usable and says why when pressed */
      }
      const problem = await autoCheck();
      if (live && problem) setFlash(problem);
    })();
    return () => {
      live = false;
    };
  }, [view, items[view ?? 0]?.id]);
  // Opening the share options: start from the caption and spoiler mark Steam already has for this screenshot.
  useEffect(() => {
    if (!hubPick || view === null || !items[view]) return;
    const s = items[view];
    let live = true;
    (async () => {
      try {
        const m = await findSteamShot(await listSteamShots(), s);
        if (!live || !m) return;
        if (typeof m.strCaption === "string" && m.strCaption) setCaption((c) => c || String(m.strCaption).slice(0, 140));
        if (m.bSpoilers) setSpoiler(true);
      } catch {
        /* nothing to prefill */
      }
    })();
    return () => {
      live = false;
    };
  }, [hubPick]);

  const move = (d: number) => {
    if (view === null) return;
    const n = view + d;
    if (n >= 0 && n < items.length) setView(n);
    else if (n >= items.length && items.length < total) loadPage(items.length).then(() => setView(n));
  };
  const toggleFav = async () => {
    if (view === null) return;
    const s = items[view];
    const r = await setFavorite(s.id, !s.favorite);
    if (r.ok) {
      setItems((cur) => cur.map((x) => (x.id === s.id ? { ...x, favorite: !s.favorite } : x)));
      setOv((o) => (o ? { ...o, favorites: r.favorites } : o));
      if (onlyFav && s.favorite) setFlash("Removed from favorites");
    }
  };

  // Share to the Steam Community as a screenshot, through Steam's own uploader.
  const shareHubNow = async (privacy: number) => {
    if (view === null || !items[view]) return;
    const s = items[view];
    setHubPick(false);
    setReportable(false);
    setShareBusy(true);
    setShareMsg("Asking Steam to upload it…");
    try {
      if (s.edited) {
        setShareMsg("Pictures made in the editor aren't in Steam's own list, so Steam can't upload them as screenshots. Use Share as Artwork.");
      } else {
        const r = await shareToHub(s, privacy, caption, spoiler);
        setShareMsg(r.text);
        if (r.ok) {
          markShared([s.id], "hub").catch(() => undefined);
          flag([s.id], "hub");
        } else setReportable(true);
      }
    } catch (e) {
      setShareMsg(errText(e));
      setReportable(true);
    }
    setShareBusy(false);
  };
  const saveSteamReport = async () => {
    try {
      const r = await withTimeout(saveReport(await steamReport()), 15000);
      setShareMsg(r.ok ? `Saved the report to ${r.path}. Send me that file.` : r.note || "Couldn't save the report.");
    } catch (e) {
      setShareMsg(errText(e));
    }
  };

  // Artwork can only be posted through Steam's web form, which needs a file picked by hand: copy the file somewhere easy to find, open the form
  // for this game's hub, and put the picture into the form for you.
  const shareArtwork = async () => {
    if (view === null || !items[view]) return;
    const s = items[view];
    const game = gameName(s.appid, hintOf.get(s.appid));
    if (isNonSteam(s.appid)) {
      setShareMsg("Non-Steam games don't have a Community Hub, so there's nowhere to post artwork.");
      return;
    }
    setShareBusy(true);
    setShareMsg("Getting the file ready…");
    try {
      const r = await withTimeout(prepareShare(s.id, namesForExport()), 60000);
      if (!r.ok) {
        setShareMsg(r.note || "Couldn't get the file ready.");
      } else {
        let display = r.display;
        let path = r.path;
        if (r.size > ART_LIMIT) {
          // over Steam's 5 MB artwork limit: make a smaller JPEG copy
          setShareMsg("This screenshot is over Steam's 5 MB artwork limit. Making a smaller copy…");
          const src = await withTimeout(getSource(s.id), 60000);
          if (!src.ok || !src.url) throw new Error(src.note || "Couldn't open it to make a smaller copy.");
          const im = await new Promise<HTMLImageElement>((res, rej) => {
            const el = new Image();
            el.onload = () => res(el);
            el.onerror = () => rej(new Error("Couldn't read the screenshot."));
            el.src = src.url;
          });
          const small = await withTimeout(saveEdit(encodeUnder(renderEdit([im], "single", DEFAULT_EDIT, 4096), ART_LIMIT), s.appid, namesForExport()), 120000);
          if (!small.ok) throw new Error(small.note || "Couldn't save the smaller copy.");
          display = small.display;
          path = small.path;
        }
        setShareMsg(`Opening the ${game} artwork page and attaching the picture. Then add a title and tick the "my own work" box.`);
        openArtworkPage(s.appid, game, display, path, [s.id], flag);
      }
    } catch (e) {
      setShareMsg(errText(e));
    }
    setShareBusy(false);
  };

  const toggleSel = (id: string) => {
    setSel((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const leaveSelect = () => {
    setSelecting(false);
    setSel(new Set());
  };
  const selectAll = async () => {
    setBusy(true);
    try {
      const r = await withTimeout(getIds(appid, onlyFav, buildOpts(filters, album, ov?.games ?? [])), 30000);
      setSel(new Set(r.ids));
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  };
  const namesForExport = () => {
    const names: Record<string, string> = {};
    for (const g of ov?.games ?? []) names[String(g.appid)] = gameName(g.appid, g.hint);
    return names;
  };
  const bulk = async (what: "star" | "unstar" | "copy") => {
    if (!sel.size) return;
    const ids = [...sel];
    setBusy(true);
    try {
      if (what === "copy") {
        const r = await withTimeout(exportSelected(ids, namesForExport()), 600000);
        setFlash(`Copied ${r.copied}${r.skipped ? ` (${r.skipped} already there)` : ""} to ${r.folder}`);
      } else {
        const r = await withTimeout(setFavorites(ids, what === "star"), 30000);
        setFlash(`${what === "star" ? "Starred" : "Un-starred"} ${shots(r.changed)}`);
        if (onlyFav && what === "unstar") {
          setSel(new Set());
          await loadPage(0);
        } else {
          setItems((cur) => cur.map((x) => (sel.has(x.id) ? { ...x, favorite: what === "star" } : x)));
        }
        setOv(await withTimeout(getOverview(false), 15000));
      }
    } catch (e) {
      setFlash(errText(e));
    }
    setBusy(false);
  };

  const games = ov?.games ?? [];
  const hintOf = new Map<number, string>(games.map((g) => [g.appid, g.hint] as [number, string]));
  const title = album ? `Album: ${album}` : onlyFav ? "Favorites" : gameName(appid, hintOf.get(appid));
  const refreshOverview = () => withTimeout(getOverview(false), 15000).then(setOv).catch(() => undefined);
  const side = (label: string, count: number, on: boolean, click: () => void, key: string) => (
    <DialogButton key={key} className={`sg-game ${on ? "sg-on" : ""}`} preferredFocus={on && focusIdx === null} onClick={click}>
      <span className="n">{label}</span>
      <span className="c">{shots(count)}</span>
    </DialogButton>
  );

  // B steps back one level at a time: editor, then viewer, then select mode, then out of the page.
  const viewing = view !== null && !editing && !sheet && !!items[view];
  const showBase = !viewing && !editing && !sheet;
  const goBack = () => {
    if (sheet) setSheet(null);
    else if (editing) setEditing(null);
    else if (view !== null) setView(null);
    else if (selecting) leaveSelect();
    else Navigation.NavigateBack();
  };
  const backLabel = sheet ? "Close" : editing ? "Close editor" : view !== null ? "Close" : selecting ? "Stop selecting" : "Back";

  // more thumbnails load by themselves when the end of the grid scrolls into view
  moreRef.current = () => {
    if (!loadingRef.current && items.length > 0 && items.length < total) loadPage(items.length);
  };
  const hasMore = items.length < total;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) moreRef.current();
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [showBase, hasMore, items.length]);

  const cur = viewing && view !== null ? items[view] : null;

  return (
    <Focusable className="sg-page" flow-children="horizontal" onCancel={goBack} onCancelActionDescription={backLabel}>
      <style>{CSS}</style>
      {/* While the viewer or editor is open, the gallery under it is not rendered: that keeps the D-pad inside the overlay. */}
      {showBase && (
        <>
          <Focusable className="sg-side" flow-children="vertical">
            <div className="sg-brand">
              <div className="t">Screenshots</div>
              <div className="s">{ov ? `${shots(ov.total)} \u00b7 ${fmtSize(ov.size)}` : "Loading\u2026"}</div>
            </div>
            <DialogButton className="sg-game sg-back" onClick={() => Navigation.NavigateBack()}>
              <span className="n">Back</span>
            </DialogButton>
            <div className="sg-divider" />
            {ov && side("All screenshots", ov.total, !onlyFav && !album && appid === 0, () => { setOnlyFav(false); setAlbum(""); setAppid(0); }, "all")}
            {ov && ov.favorites > 0 && side("Favorites \u2605", ov.favorites, onlyFav && !album, () => { setOnlyFav(true); setAlbum(""); setAppid(0); }, "fav")}
            {ov && ov.albums.length > 0 && <div className="sg-divider" />}
            {ov && ov.albums.map((a) => side(`Album: ${a.name}`, a.count, album === a.name, () => { setOnlyFav(false); setAlbum(a.name); setAppid(0); }, `album:${a.name}`))}
            {ov && ov.albums.length > 0 && <div className="sg-divider" />}
            {games.map((g) => side(gameName(g.appid, g.hint), g.count, !onlyFav && !album && appid === g.appid, () => { setOnlyFav(false); setAlbum(""); setAppid(g.appid); }, String(g.appid)))}
          </Focusable>

          <Focusable className="sg-main" flow-children="vertical">
            <Focusable className="sg-head" flow-children="horizontal">
              <div className="l">
                <div className="sg-title">{title}</div>
                <div className="sg-sub">{total ? shots(total) : loading ? "Loading\u2026" : ""}</div>
              </div>
              <div className="r">
                {flash && <div className="sg-flash">{flash}</div>}
                {album && (
                  <DialogButton
                    className="sg-headbtn"
                    onClick={async () => {
                      if (!confirmAlbum) return setConfirmAlbum(true);
                      await deleteAlbum(album).catch(() => undefined);
                      setAlbum("");
                      setFlash("Album removed. The screenshots are untouched.");
                      refreshOverview();
                    }}
                  >
                    {confirmAlbum ? "Really delete the album? (screenshots stay)" : "Delete album"}
                  </DialogButton>
                )}
                <DialogButton className="sg-headbtn" onClick={() => setSheet({ kind: "filter" })}>
                  {filterCount(filters) ? `Sort / filter (${filterCount(filters)})` : "Sort / filter"}
                </DialogButton>
                {total > 0 && (
                  <DialogButton className="sg-headbtn" onClick={() => (selecting ? leaveSelect() : (setFlash(""), setSelecting(true)))}>
                    {selecting ? "Done" : "Select"}
                  </DialogButton>
                )}
              </div>
            </Focusable>
            {error && <div className="sg-empty">{error}</div>}
            <Focusable className="sg-grid" flow-children="grid">
              {loading && items.length === 0 && !error && <div className="sg-empty">Loading screenshots…</div>}
              {!loading && items.length === 0 && !error && <div className="sg-empty">{filterCount(filters) ? "Nothing matches these filters. Open Sort / filter and press Reset." : album ? "This album is empty. Select screenshots and choose Add to album." : onlyFav ? "No favorites yet. Open a screenshot and press Favorite." : "No screenshots here."}</div>}
              {items.map((s, i) => (
                <Focusable
                  key={s.id}
                  className={`sg-cell ${sel.has(s.id) ? "sg-sel" : ""}`}
                  focusClassName="sg-cell-focus"
                  preferredFocus={focusIdx === i}
                  onActivate={() => (selecting ? toggleSel(s.id) : (setFlash(""), setView(i)))}
                  onOKActionDescription={selecting ? (sel.has(s.id) ? "Deselect" : "Select") : "View"}
                  onSecondaryButton={() => (setSelecting(true), toggleSel(s.id))}
                  onSecondaryActionDescription="Select"
                >
                  {s.thumb ? <img src={s.thumb} draggable={false} /> : <div className="nop">No preview</div>}
                  {selecting && (sel.has(s.id) ? <span className="sg-check">{"\u2713"}</span> : <span className="sg-ring" />)}
                  {s.favorite && <span className="star">{"\u2605"}</span>}
                  <span className="tag">
                    <span className="d">{fmtDate(s.taken)}</span>
                    {appid === 0 && <span className="g">{gameName(s.appid, hintOf.get(s.appid))}</span>}
                  </span>
                  <ShareBadges art={s.art} hub={s.hub} edited={s.edited} />
                </Focusable>
              ))}
              {hasMore && <div className="sg-sentinel" ref={sentinelRef} />}
              {hasMore && (
                <DialogButton className="sg-more" disabled={loading} onClick={() => loadPage(items.length)}>
                  {loading ? "Loading…" : `Show more (${total - items.length} left)`}
                </DialogButton>
              )}
            </Focusable>
            {selecting && (
              <Focusable className="sg-selbar" flow-children="grid">
                <div className="txt">
                  {sel.size ? `${shots(sel.size)} selected${info ? ` (${fmtSize(info.size)}${info.favorites ? `, ${info.favorites} favorites` : ""})` : ""}` : "Press A on screenshots to select them, or select all."}
                </div>
                <DialogButton disabled={busy || total === 0} onClick={() => (sel.size >= total && total > 0 ? setSel(new Set()) : selectAll())}>
                  {sel.size >= total && total > 0 ? "Select none" : `Select all ${total}`}
                </DialogButton>
                <DialogButton disabled={busy || !sel.size} onClick={() => bulk("star")}>{"\u2605 Star"}</DialogButton>
                <DialogButton disabled={busy || !sel.size} onClick={() => bulk("unstar")}>{"\u2606 Un-star"}</DialogButton>
                <DialogButton disabled={busy || !sel.size} onClick={() => bulk("copy")}>Copy to Pictures</DialogButton>
                <DialogButton disabled={busy || !sel.size} onClick={() => setSheet({ kind: "album", ids: [...sel] })}>Add to album</DialogButton>
                {album && (
                  <DialogButton
                    disabled={busy || !sel.size}
                    onClick={async () => {
                      const r = await withTimeout(albumRemove(album, [...sel]), 20000).catch(() => null);
                      setFlash(r ? `Removed ${shots(r.removed)} from ${album}` : "Couldn't remove them.");
                      setSel(new Set());
                      loadPage(0);
                      refreshOverview();
                    }}
                  >
                    Remove from album
                  </DialogButton>
                )}
                <DialogButton disabled={busy || !sel.size} onClick={() => setSheet({ kind: "phone", ids: [...sel] })}>Send to phone</DialogButton>
                {sel.size === 1 && <DialogButton disabled={busy} onClick={() => setEditing({ ids: [...sel], layout: "single" })}>Edit</DialogButton>}
                {sel.size === 2 && <DialogButton disabled={busy} onClick={() => setEditing({ ids: [...sel], layout: "stack" })}>Combine: top / bottom</DialogButton>}
                {sel.size === 2 && <DialogButton disabled={busy} onClick={() => setEditing({ ids: [...sel], layout: "side" })}>Combine: side by side</DialogButton>}
              </Focusable>
            )}
          </Focusable>
        </>
      )}

      {cur && view !== null && (
        <Focusable
          className="sg-view"
          flow-children="horizontal"
          onCancel={goBack}
          onCancelActionDescription={backLabel}
          onButtonDown={onBumpers(() => move(-1), () => move(1))}
        >
          <div className="stage">{url ? <img src={url} draggable={false} /> : <div className="sg-cap">{note || "Loading…"}</div>}</div>
          <Focusable className="panel" flow-children="vertical" onSecondaryButton={toggleFav} onSecondaryActionDescription="Favorite">
            <div className="ttl">{gameName(cur.appid, hintOf.get(cur.appid))}</div>
            <div className="meta">
              {fmtDateTime(cur.taken)}
              <br />
              {fmtSize(cur.size)} {"\u00b7"} {view + 1} of {total}
              {note && url ? <><br />{note}</> : null}
            </div>
            {(cur.favorite || cur.art || cur.hub || cur.edited) && (
              <div className="sg-chips">
                {cur.favorite && <span className="sg-chip fav">{"\u2605"} Favorite</span>}
                {cur.edited && <span className="sg-chip edit">Edited</span>}
                {cur.hub && <span className="sg-chip hub">On Steam</span>}
                {cur.art && <span className="sg-chip art">Sent as artwork</span>}
              </div>
            )}
            {shareMsg && <div className="sg-status">{shareMsg}</div>}
            {reportable && <DialogButton className="sg-act" onClick={saveSteamReport}>Save a report about this</DialogButton>}

            <DialogButton className="sg-act" preferredFocus={!touchedShare} onClick={toggleFav}>{cur.favorite ? "\u2605 Favorite" : "\u2606 Favorite"}</DialogButton>
            <DialogButton className="sg-act" onClick={() => setEditing({ ids: [cur.id], layout: "single" })}>Edit</DialogButton>
            <DialogButton className="sg-act" preferredFocus={touchedShare} disabled={shareBusy || !!cur.hub} onClick={() => (setTouchedShare(true), setHubPick((v) => !v), setShareMsg("Who can see it? Only Public shows on the game's Community Hub."))}>
              {cur.hub ? "Already shared as Screenshot" : "Share as Screenshot"}
            </DialogButton>
            {hubPick && (
              <>
                <div className="sg-formlbl">Caption (optional)</div>
                <TextField value={caption} onChange={(e: any) => setCaption(String(e?.target?.value ?? "").slice(0, 140))} />
                <div className="sg-count">{caption.length} / 140</div>
                <DialogButton className={`sg-act ${spoiler ? "sg-pick" : ""}`} onClick={() => setSpoiler((v) => !v)}>
                  {spoiler ? "Marked as a spoiler" : "Mark as a spoiler"}
                </DialogButton>
              </>
            )}
            {hubPick && (
              <Focusable className="sg-row2" flow-children="horizontal" style={{ flexWrap: "wrap" }}>
                <DialogButton className="sg-act" style={{ flex: "1 1 45%" }} onClick={() => shareHubNow(PRIVACY.PUBLIC)}>Public</DialogButton>
                <DialogButton className="sg-act" style={{ flex: "1 1 45%" }} onClick={() => shareHubNow(PRIVACY.FRIENDS)}>Friends only</DialogButton>
                <DialogButton className="sg-act" style={{ flex: "1 1 45%" }} onClick={() => shareHubNow(PRIVACY.UNLISTED)}>Unlisted</DialogButton>
                <DialogButton className="sg-act" style={{ flex: "1 1 45%" }} onClick={() => shareHubNow(PRIVACY.PRIVATE)}>Private</DialogButton>
              </Focusable>
            )}
            <DialogButton className="sg-act" disabled={shareBusy} onClick={() => (setTouchedShare(true), shareArtwork())}>Share as Artwork</DialogButton>
            <DialogButton className="sg-act" onClick={() => setSheet({ kind: "phone", ids: [cur.id] })}>Send to phone</DialogButton>
            <DialogButton className="sg-act" onClick={() => setSheet({ kind: "album", ids: [cur.id] })}>Add to album</DialogButton>
            <div className="gap" />
            <Focusable className="sg-row2" flow-children="horizontal">
              <DialogButton className="sg-act" disabled={view === 0} onClick={() => move(-1)}>Previous</DialogButton>
              <DialogButton className="sg-act" disabled={view >= total - 1} onClick={() => move(1)}>Next</DialogButton>
            </Focusable>
            <DialogButton className="sg-act" onClick={() => setView(null)}>Close</DialogButton>
            <div className="sg-hint">L1 / R1: previous / next {"\u00b7"} X: favorite</div>
          </Focusable>
        </Focusable>
      )}

      {editing &&
        (() => {
          const list = editing.ids.map((id) => items.find((x) => x.id === id)).filter(Boolean) as Shot[];
          if (!list.length) return null;
          return (
            <Editor
              key={editing.ids.join("|") + editing.layout}
              shots={list}
              layout={list.length > 1 ? editing.layout : "single"}
              names={namesForExport()}
              gameOf={(a) => gameName(a, hintOf.get(a))}
              onClose={() => setEditing(null)}
              onShared={flag}
            />
          );
        })()}

      {sheet?.kind === "filter" && <FilterSheet value={filters} shown={total} onChange={setFilters} onClose={() => setSheet(null)} />}
      {sheet?.kind === "album" && (
        <AlbumSheet
          ids={sheet.ids}
          albums={ov?.albums ?? []}
          onClose={() => setSheet(null)}
          onDone={(msg) => {
            setFlash(msg);
            setSheet(null);
            refreshOverview();
          }}
        />
      )}
      {sheet?.kind === "phone" && <PhoneSheet ids={sheet.ids} onClose={() => setSheet(null)} />}
    </Focusable>
  );
}

export default definePlugin(() => {
  routerHook.addRoute(ROUTE, GalleryPage);
  return {
    name: "Screenshot Gallery",
    titleView: <div className={staticClasses.Title}>Screenshot Gallery</div>,
    content: <Content />,
    icon: <FaImages />,
    onDismount() {
      routerHook.removeRoute(ROUTE);
    },
  };
});
