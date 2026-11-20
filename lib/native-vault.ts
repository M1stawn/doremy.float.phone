// lib/native-vault.ts
// 统一的 Android 原生 filesDir 磁盘镜像层（float_local_vault）：
// - 自动分片（单片 <= 1.5MB），消除 4MB/6MB 静默截断与 WebView JSBridge 大字符串崩溃问题
// - 缩容与删除时自动清理尾部分片，不留孤儿死文件
// - 进程内缓存物理键集合，vaultHasKey() 为 O(1) 纯内存查询，彻底消除读路径与冷启动的重复全量写盘

export type NativeVaultBridge = {
    saveLocalDiskData?: (key: string, content: string) => boolean;
    loadLocalDiskData?: (key: string) => string;
    removeLocalDiskData?: (key: string) => boolean;
    listLocalDiskKeys?: () => string;
};

export const VAULT_KEYS = {
    CHAT_SESSIONS: "ai_phone_chat_sessions_v1",
    CHAT_CONTACTS: "ai_phone_chat_contacts_v1",
    CHAT_SESSION_PREFIX: "chat_sess_",
    LEGACY_CHAT_META_PREFIX: "msg_meta_",
    LEGACY_CHAT_SESS_PREFIX: "msg_sess_",
    LEGACY_CHAT_MESSAGES: "ai_phone_chat_messages_v1",
    SETTINGS_PRESETS: "ai_phone_presets_v1",
    SETTINGS_WORLDBOOKS: "ai_phone_worldbooks_v1",
    SETTINGS_REGEXES: "ai_phone_regexes_v1",
    MOMENTS_POSTS: "moments_posts_v1",
    MOMENTS_COMMENTS: "moments_comments_v1",
    MEDIA_BLOB_PREFIX: "media_blob_",
    THEME_ASSET_PREFIX: "theme_asset_",
} as const;

const CHUNK_CHARS = 1_500_000;
const META_PREFIX = "vmeta_";
const SAFE_KEY_MAX = 120;

let _physicalKeysCache: Set<string> | null = null;

export function getNativeVaultBridge(): NativeVaultBridge | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { AndroidShell?: NativeVaultBridge };
    return w.AndroidShell ?? null;
}

export function hasNativeVault(): boolean {
    const b = getNativeVaultBridge();
    return Boolean(b && typeof b.saveLocalDiskData === "function" && typeof b.loadLocalDiskData === "function");
}

function fnv1aHex(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 与 Android MainActivity.safeVaultKey 对齐，同时保证附加分片后缀后绝不超过 160 字符上限。 */
export function normalizeVaultKey(key: string): string {
    const sanitized = key.replace(/[^a-zA-Z0-9._:-]/g, "_");
    if (sanitized.length <= SAFE_KEY_MAX) return sanitized;
    return `${sanitized.slice(0, 96)}_${fnv1aHex(key)}`;
}

function metaKeyOf(safeKey: string): string {
    return `${META_PREFIX}${safeKey}`;
}

function partKeyOf(safeKey: string, index: number): string {
    return `${safeKey}__p${index}`;
}

function getPhysicalKeysSet(): Set<string> {
    if (_physicalKeysCache) return _physicalKeysCache;
    const set = new Set<string>();
    const bridge = getNativeVaultBridge();
    if (bridge && typeof bridge.listLocalDiskKeys === "function") {
        try {
            const parsed = JSON.parse(bridge.listLocalDiskKeys() || "[]");
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    if (typeof item === "string" && item.length > 0) set.add(item);
                }
            }
        } catch {
            // ignore
        }
    }
    _physicalKeysCache = set;
    return set;
}

function rawSave(bridge: NativeVaultBridge, physicalKey: string, content: string): boolean {
    if (!bridge.saveLocalDiskData) return false;
    const ok = bridge.saveLocalDiskData(physicalKey, content) !== false;
    if (ok) getPhysicalKeysSet().add(physicalKey);
    return ok;
}

function rawRemove(bridge: NativeVaultBridge, physicalKey: string): void {
    if (!bridge.removeLocalDiskData) return;
    try {
        bridge.removeLocalDiskData(physicalKey);
    } catch {
        // ignore
    }
    getPhysicalKeysSet().delete(physicalKey);
}

function readChunkCount(bridge: NativeVaultBridge, safeKey: string): number {
    const mKey = metaKeyOf(safeKey);
    if (!getPhysicalKeysSet().has(mKey)) return 0;
    try {
        const raw = bridge.loadLocalDiskData?.(mKey);
        if (!raw) return 0;
        const parsed = JSON.parse(raw) as { chunks?: number };
        return Number.isFinite(parsed?.chunks) ? Math.max(0, Number(parsed.chunks)) : 0;
    } catch {
        return 0;
    }
}

/** O(1) 纯内存查询该逻辑键在原生硬盘中是否已有镜像（直存或分片均可识别）。 */
export function vaultHasKey(key: string): boolean {
    if (!key || !hasNativeVault()) return false;
    const safeKey = normalizeVaultKey(key);
    const keys = getPhysicalKeysSet();
    return keys.has(safeKey) || keys.has(metaKeyOf(safeKey));
}

/** 写入任意长度字符串（超过阈值自动分片，并自动清理缩容后多余的旧分片）。 */
export function vaultWriteString(key: string, content: string): boolean {
    if (!key) return false;
    const bridge = getNativeVaultBridge();
    if (!bridge?.saveLocalDiskData) return false;

    const safeKey = normalizeVaultKey(key);
    try {
        const prevChunks = readChunkCount(bridge, safeKey);

        if (content.length <= CHUNK_CHARS) {
            const ok = rawSave(bridge, safeKey, content);
            if (prevChunks > 0) {
                for (let i = 0; i < prevChunks; i += 1) {
                    rawRemove(bridge, partKeyOf(safeKey, i));
                }
                rawRemove(bridge, metaKeyOf(safeKey));
            }
            return ok;
        }

        const totalChunks = Math.ceil(content.length / CHUNK_CHARS);
        for (let i = 0; i < totalChunks; i += 1) {
            const slice = content.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
            if (!rawSave(bridge, partKeyOf(safeKey, i), slice)) return false;
        }
        const metaOk = rawSave(
            bridge,
            metaKeyOf(safeKey),
            JSON.stringify({ chunks: totalChunks, updatedAt: Date.now() }),
        );
        if (!metaOk) return false;

        rawRemove(bridge, safeKey);
        for (let i = totalChunks; i < prevChunks; i += 1) {
            rawRemove(bridge, partKeyOf(safeKey, i));
        }
        return true;
    } catch {
        return false;
    }
}

/** 读取字符串（自动兼容分片与直存；若任一分片缺失返回 null，绝不拼出损坏数据）。 */
export function vaultReadString(key: string): string | null {
    if (!key) return null;
    const bridge = getNativeVaultBridge();
    if (!bridge?.loadLocalDiskData) return null;

    const safeKey = normalizeVaultKey(key);
    try {
        const chunks = readChunkCount(bridge, safeKey);
        if (chunks > 0) {
            const parts: string[] = [];
            for (let i = 0; i < chunks; i += 1) {
                const chunk = bridge.loadLocalDiskData(partKeyOf(safeKey, i));
                if (typeof chunk !== "string" || chunk.length === 0) return null;
                parts.push(chunk);
            }
            return parts.join("");
        }
        const raw = bridge.loadLocalDiskData(safeKey);
        return typeof raw === "string" && raw.length > 0 ? raw : null;
    } catch {
        return null;
    }
}

/** 彻底删除一个逻辑键对应的全部物理文件（直存、元数据及所有分片）。 */
export function vaultRemove(key: string): void {
    if (!key) return;
    const bridge = getNativeVaultBridge();
    if (!bridge?.removeLocalDiskData) return;

    const safeKey = normalizeVaultKey(key);
    try {
        const prevChunks = readChunkCount(bridge, safeKey);
        for (let i = 0; i < prevChunks; i += 1) {
            rawRemove(bridge, partKeyOf(safeKey, i));
        }
        rawRemove(bridge, metaKeyOf(safeKey));
        rawRemove(bridge, safeKey);
    } catch {
        // ignore
    }
}

/** 直接按物理文件前缀清理（用于清库和清理历史遗留分片文件）。 */
export function vaultRemovePhysicalByPrefix(prefix: string): void {
    if (!prefix) return;
    const bridge = getNativeVaultBridge();
    if (!bridge?.removeLocalDiskData) return;

    const safePrefix = normalizeVaultKey(prefix);
    const metaPrefix = `${META_PREFIX}${safePrefix}`;
    const toRemove: string[] = [];
    for (const k of getPhysicalKeysSet()) {
        if (k.startsWith(safePrefix) || k.startsWith(metaPrefix)) {
            toRemove.push(k);
        }
    }
    for (const k of toRemove) {
        rawRemove(bridge, k);
    }
}

/** 列出当前原生硬盘中所有逻辑键名（自动去重并折叠分片键）。 */
export function vaultListLogicalKeys(prefix?: string): string[] {
    const keys = getPhysicalKeysSet();
    const logical = new Set<string>();
    for (const item of keys) {
        if (item.startsWith(META_PREFIX)) {
            logical.add(item.slice(META_PREFIX.length));
        } else if (!/__p\d+$/.test(item)) {
            logical.add(item);
        }
    }
    const out = Array.from(logical);
    return prefix ? out.filter((k) => k.startsWith(prefix)) : out;
}

export function vaultWriteJson<T>(key: string, data: T): boolean {
    try {
        return vaultWriteString(key, JSON.stringify(data));
    } catch {
        return false;
    }
}

export function vaultReadJson<T>(key: string): T | null {
    const raw = vaultReadString(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** 兼容读取旧版（_meta + _pN）分片数组，仅用于历史数据无损迁移。 */
export function vaultReadLegacyChunkedArray<T>(prefix: string): T[] {
    const bridge = getNativeVaultBridge();
    if (!bridge?.loadLocalDiskData) return [];
    try {
        const metaRaw = bridge.loadLocalDiskData(`${prefix}_meta`);
        if (!metaRaw) return [];
        const meta = JSON.parse(metaRaw) as { chunks?: number };
        const count = Number(meta?.chunks || 0);
        const out: T[] = [];
        for (let i = 0; i < count; i += 1) {
            const raw = bridge.loadLocalDiskData(`${prefix}_p${i}`);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) out.push(...(parsed as T[]));
        }
        return out;
    } catch {
        return [];
    }
}

/** 清理旧版（_meta + _pN）残留分片文件。 */
export function vaultRemoveLegacyChunked(prefix: string): void {
    const bridge = getNativeVaultBridge();
    if (!bridge?.removeLocalDiskData) return;
    const keys = getPhysicalKeysSet();
    const toRemove: string[] = [];
    const metaName = `${prefix}_meta`;
    const partPrefix = `${prefix}_p`;
    for (const k of keys) {
        if (k === metaName || k.startsWith(partPrefix)) {
            toRemove.push(k);
        }
    }
    for (const k of toRemove) {
        rawRemove(bridge, k);
    }
}

/** 按数据库名与仓库名同步清理原生硬盘镜像（供数据管理清空/导入前清旧使用）。 */
export function vaultPurgeDatabase(dbName: string, storeNames?: string[]): void {
    if (!hasNativeVault()) return;
    const hasStore = (name: string) => !storeNames || storeNames.length === 0 || storeNames.includes(name);

    if (dbName === "AiPhoneChatDB") {
        if (hasStore("messages")) {
            vaultRemovePhysicalByPrefix(VAULT_KEYS.CHAT_SESSION_PREFIX);
            vaultRemovePhysicalByPrefix(VAULT_KEYS.LEGACY_CHAT_META_PREFIX);
            vaultRemovePhysicalByPrefix(VAULT_KEYS.LEGACY_CHAT_SESS_PREFIX);
            vaultRemove(VAULT_KEYS.LEGACY_CHAT_MESSAGES);
        }
        if (hasStore("sessions")) vaultRemove(VAULT_KEYS.CHAT_SESSIONS);
        if (hasStore("contacts")) vaultRemove(VAULT_KEYS.CHAT_CONTACTS);
        return;
    }

    if (dbName === "AiPhoneSettingsDB") {
        if (hasStore("presets")) vaultRemove(VAULT_KEYS.SETTINGS_PRESETS);
        if (hasStore("worldBooks")) vaultRemove(VAULT_KEYS.SETTINGS_WORLDBOOKS);
        if (hasStore("regexes")) vaultRemove(VAULT_KEYS.SETTINGS_REGEXES);
        return;
    }

    if (dbName === "AiPhoneMomentsDB") {
        if (hasStore("posts")) {
            vaultRemove(VAULT_KEYS.MOMENTS_POSTS);
            vaultRemoveLegacyChunked(VAULT_KEYS.MOMENTS_POSTS);
        }
        if (hasStore("comments")) {
            vaultRemove(VAULT_KEYS.MOMENTS_COMMENTS);
            vaultRemoveLegacyChunked(VAULT_KEYS.MOMENTS_COMMENTS);
        }
        return;
    }

    if (dbName === "AiPhoneMediaCacheDB") {
        if (hasStore("entries")) {
            vaultRemovePhysicalByPrefix(VAULT_KEYS.MEDIA_BLOB_PREFIX);
        }
        return;
    }

    if (dbName === "ai_phone_theme_db_v1") {
        if (hasStore("assets")) {
            vaultRemovePhysicalByPrefix(VAULT_KEYS.THEME_ASSET_PREFIX);
        }
    }
}
