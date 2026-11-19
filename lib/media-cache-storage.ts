import Dexie from "dexie";
import { loadPhotoWallState } from "./photo-wall-storage";

// ── Database ─────────────────────────────────────

interface MediaCacheEntry {
    id: string;
    blob: Blob;
    mimeType: string;
    mediaCategory: "audio" | "image" | "video" | "file";
    createdAt: number;
    /** Persistent references held by features; generic media cleanup must not remove these. */
    retainedBy?: string[];
}

class MediaCacheDatabase extends Dexie {
    entries!: Dexie.Table<MediaCacheEntry, string>;

    constructor() {
        super("AiPhoneMediaCacheDB");
        this.version(1).stores({
            entries: "id, createdAt",
        });
    }
}

let db: MediaCacheDatabase | null = null;

function getDb(): MediaCacheDatabase {
    if (!db) db = new MediaCacheDatabase();
    return db;
}

// ── Android 原生 filesDir 永久磁盘媒体镜像（防止 WebView 清理缓存丢失聊天照片、照片墙与表情）──

type NativeVaultBridge = {
    saveLocalDiskData?: (key: string, content: string) => boolean;
    loadLocalDiskData?: (key: string) => string;
    removeLocalDiskData?: (key: string) => boolean;
};

function getNativeVaultBridge(): NativeVaultBridge | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { AndroidShell?: NativeVaultBridge };
    return w.AndroidShell ?? null;
}

const MAX_MEDIA_DISK_CHARS = 5_500_000;

function blobToBase64String(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            const res = String(reader.result ?? "");
            const comma = res.indexOf(",");
            resolve(comma >= 0 ? res.slice(comma + 1) : res);
        };
        reader.readAsDataURL(blob);
    });
}

function base64ToBlob(b64: string, mimeType: string): Blob {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

async function writeMediaEntryToDisk(entry: MediaCacheEntry): Promise<void> {
    if (typeof window === "undefined" || !entry?.id || !entry?.blob) return;
    if (entry.blob.size > 4_000_000) return;
    try {
        const bridge = getNativeVaultBridge();
        if (!bridge || typeof bridge.saveLocalDiskData !== "function") return;
        const b64 = await blobToBase64String(entry.blob);
        const payload = JSON.stringify({
            id: entry.id,
            b64,
            mimeType: entry.mimeType,
            mediaCategory: entry.mediaCategory,
            createdAt: entry.createdAt,
            retainedBy: entry.retainedBy,
        });
        if (payload.length <= MAX_MEDIA_DISK_CHARS) {
            bridge.saveLocalDiskData("media_blob_" + entry.id, payload);
        }
    } catch {}
}

function readMediaEntryFromDisk(id: string): MediaCacheEntry | null {
    if (typeof window === "undefined" || !id) return null;
    try {
        const bridge = getNativeVaultBridge();
        if (!bridge || typeof bridge.loadLocalDiskData !== "function") return null;
        const raw = bridge.loadLocalDiskData("media_blob_" + id);
        if (!raw || raw.trim().length < 10) return null;
        const parsed = JSON.parse(raw) as {
            id?: string;
            b64?: string;
            mimeType?: string;
            mediaCategory?: MediaCacheEntry["mediaCategory"];
            createdAt?: number;
            retainedBy?: string[];
        };
        if (!parsed || typeof parsed.b64 !== "string" || !parsed.b64) return null;
        const mimeType = parsed.mimeType || "image/png";
        const blob = base64ToBlob(parsed.b64, mimeType);
        return {
            id: parsed.id || id,
            blob,
            mimeType,
            mediaCategory: parsed.mediaCategory || "image",
            createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
            retainedBy: Array.isArray(parsed.retainedBy) ? parsed.retainedBy : undefined,
        };
    } catch {
        return null;
    }
}

function removeMediaEntryFromDisk(id: string): void {
    if (typeof window === "undefined" || !id) return;
    try {
        const bridge = getNativeVaultBridge();
        if (bridge && typeof bridge.removeLocalDiskData === "function") {
            bridge.removeLocalDiskData("media_blob_" + id);
        }
    } catch {}
}

// ── MIME Sniffing ────────────────────────────────

const MAGIC_SIGNATURES: Array<{ prefix: string; mime: string; category: MediaCacheEntry["mediaCategory"] }> = [
    // Images
    { prefix: "iVBORw0KGgo", mime: "image/png", category: "image" },
    { prefix: "/9j/", mime: "image/jpeg", category: "image" },
    { prefix: "R0lGOD", mime: "image/gif", category: "image" },
    { prefix: "UklGRg", mime: "image/webp", category: "image" },
    // Audio
    { prefix: "SUQz", mime: "audio/mpeg", category: "audio" },
    { prefix: "//u", mime: "audio/mpeg", category: "audio" },
    { prefix: "T2dnUw", mime: "audio/ogg", category: "audio" },
    { prefix: "ZkxhQw", mime: "audio/flac", category: "audio" },
    // Video
    { prefix: "AAAAIG", mime: "video/mp4", category: "video" },
    { prefix: "AAAAHG", mime: "video/mp4", category: "video" },
    { prefix: "GkXfo", mime: "video/webm", category: "video" },
    // Documents
    { prefix: "JVBERi", mime: "application/pdf", category: "file" },
];

function sniffBase64(b64: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } {
    for (const sig of MAGIC_SIGNATURES) {
        if (b64.startsWith(sig.prefix)) return { mime: sig.mime, category: sig.category };
    }
    return { mime: "application/octet-stream", category: "file" };
}

// WAV shares UklGR prefix with WebP — disambiguate by checking bytes 8-11 for "WAVE"
function refineWavOrWebp(b64: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } | null {
    if (!b64.startsWith("UklGR")) return null;
    try {
        const raw = atob(b64.slice(0, 24));
        if (raw.length >= 12 && raw.slice(8, 12) === "WAVE") {
            return { mime: "audio/wav", category: "audio" };
        }
    } catch { /* ignore */ }
    return null;
}

export function detectMediaType(b64: string, declaredMime?: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } {
    if (declaredMime && declaredMime !== "application/octet-stream") {
        const category: MediaCacheEntry["mediaCategory"] =
            declaredMime.startsWith("image/") ? "image" :
            declaredMime.startsWith("audio/") ? "audio" :
            declaredMime.startsWith("video/") ? "video" : "file";
        return { mime: declaredMime, category };
    }
    const wavCheck = refineWavOrWebp(b64);
    if (wavCheck) return wavCheck;
    return sniffBase64(b64);
}

// ── Store & Retrieve ─────────────────────────────

export const MEDIA_STORE_PROTOCOL = "media-store://";

function generateId(): string {
    return `mc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function storeMediaBlob(blob: Blob, mimeType: string, category: MediaCacheEntry["mediaCategory"]): Promise<string> {
    const id = generateId();
    const entry: MediaCacheEntry = { id, blob, mimeType, mediaCategory: category, createdAt: Date.now() };
    await getDb().entries.put(entry);
    void writeMediaEntryToDisk(entry);
    return `${MEDIA_STORE_PROTOCOL}${id}`;
}

export async function storeMediaBase64(b64: string, declaredMime?: string): Promise<{ ref: string; category: MediaCacheEntry["mediaCategory"]; mime: string }> {
    const { mime, category } = detectMediaType(b64, declaredMime);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const ref = await storeMediaBlob(blob, mime, category);
    return { ref, category, mime };
}

export async function loadMediaBlob(ref: string): Promise<{ blob: Blob; mimeType: string; category: MediaCacheEntry["mediaCategory"] } | null> {
    const id = ref.startsWith(MEDIA_STORE_PROTOCOL) ? ref.slice(MEDIA_STORE_PROTOCOL.length) : ref;
    const entry = await getDb().entries.get(id);
    if (entry) {
        void writeMediaEntryToDisk(entry);
        return { blob: entry.blob, mimeType: entry.mimeType, category: entry.mediaCategory };
    }
    const diskEntry = readMediaEntryFromDisk(id);
    if (diskEntry) {
        await getDb().entries.put(diskEntry).catch(() => {});
        return { blob: diskEntry.blob, mimeType: diskEntry.mimeType, category: diskEntry.mediaCategory };
    }
    return null;
}

/** Keep a media ref alive while a persistent feature references it. */
export async function retainMediaRef(ref: string | undefined, owner: string): Promise<void> {
    if (!ref || !ref.startsWith(MEDIA_STORE_PROTOCOL) || !owner.trim()) return;
    const table = getDb().entries;
    const id = ref.slice(MEDIA_STORE_PROTOCOL.length);
    let entry = await table.get(id);
    if (!entry) {
        const diskEntry = readMediaEntryFromDisk(id);
        if (diskEntry) {
            await table.put(diskEntry).catch(() => {});
            entry = diskEntry;
        }
    }
    if (!entry) throw new Error("媒体文件不存在，无法建立引用保护");
    const retainedBy = Array.from(new Set([...(entry.retainedBy ?? []), owner.trim()]));
    await table.update(id, { retainedBy });
    void writeMediaEntryToDisk({ ...entry, retainedBy });
}

/** Release one feature's reference. Deletion remains an explicit separate operation. */
export async function releaseMediaRef(ref: string | undefined, owner: string): Promise<void> {
    if (!ref || !ref.startsWith(MEDIA_STORE_PROTOCOL) || !owner.trim()) return;
    const table = getDb().entries;
    const id = ref.slice(MEDIA_STORE_PROTOCOL.length);
    const entry = await table.get(id);
    if (!entry) return;
    const retainedBy = (entry.retainedBy ?? []).filter(value => value !== owner.trim());
    await table.update(id, { retainedBy });
    void writeMediaEntryToDisk({ ...entry, retainedBy });
}

export async function isMediaRefRetained(ref: string | undefined): Promise<boolean> {
    if (!ref || !ref.startsWith(MEDIA_STORE_PROTOCOL)) return false;
    const entry = await getDb().entries.get(ref.slice(MEDIA_STORE_PROTOCOL.length));
    return Boolean(entry?.retainedBy?.length);
}

export async function deleteMediaRef(ref: string | undefined): Promise<void> {
    if (!ref || !ref.startsWith(MEDIA_STORE_PROTOCOL)) return;
    const table = getDb().entries;
    const id = ref.slice(MEDIA_STORE_PROTOCOL.length);
    const entry = await table.get(id);
    let referencedByPhotoWall = false;
    try {
        const state = loadPhotoWallState();
        referencedByPhotoWall = state.wallBackgroundRef === ref || state.photos.some(photo => photo.mediaRef === ref);
    } catch { /* ignore */ }
    if (entry?.retainedBy?.length || referencedByPhotoWall) return;
    removeMediaEntryFromDisk(id);
    await table.delete(id);
}

export async function loadMediaObjectUrl(ref: string): Promise<string | null> {
    const result = await loadMediaBlob(ref);
    if (!result) return null;
    return URL.createObjectURL(result.blob);
}

export function isMediaStoreRef(url: string): boolean {
    return url.startsWith(MEDIA_STORE_PROTOCOL);
}

export type MediaCacheSummary = {
    id: string;
    bytes: number;
    category: MediaCacheEntry["mediaCategory"];
    createdAt: number;
    /** Explicit owners of durable feature references, e.g. photo-wall-background. */
    retainedBy: string[];
};

/** 逐条流式读取 id/大小/类别——blob.size 只读元数据，不会把媒体内容载入内存。 */
export async function listMediaCacheSummaries(): Promise<MediaCacheSummary[]> {
    const out: MediaCacheSummary[] = [];
    await getDb().entries.each((entry) => {
        out.push({
            id: entry.id,
            bytes: entry.blob?.size ?? 0,
            category: entry.mediaCategory,
            createdAt: entry.createdAt,
            retainedBy: entry.retainedBy ?? [],
        });
    });
    return out;
}

// ── Bulk detection in JSON text ──────────────────

const B64_BLOCK_RE = /(?:data:([^;]+);base64,)?([A-Za-z0-9+/]{200,}={0,2})/g;

export function extractBase64Blocks(text: string): Array<{ fullMatch: string; declaredMime?: string; b64: string; start: number }> {
    const results: Array<{ fullMatch: string; declaredMime?: string; b64: string; start: number }> = [];
    let match: RegExpExecArray | null;
    B64_BLOCK_RE.lastIndex = 0;
    while ((match = B64_BLOCK_RE.exec(text)) !== null) {
        results.push({
            fullMatch: match[0],
            declaredMime: match[1] || undefined,
            b64: match[2],
            start: match.index,
        });
    }
    return results;
}
