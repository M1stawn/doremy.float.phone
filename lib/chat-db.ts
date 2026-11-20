// lib/chat-db.ts
// IndexedDB persistence layer for chat data using Dexie.js.
// Provides async persistence behind the synchronous in-memory cache in chat-storage.ts,
// backed by incremental per-session Android native disk vault mirroring.

import Dexie from "dexie";
import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";
import {
    VAULT_KEYS,
    getNativeVaultBridge,
    hasNativeVault,
    vaultHasKey,
    vaultListLogicalKeys,
    vaultReadJson,
    vaultRemove,
    vaultRemovePhysicalByPrefix,
    vaultWriteJson,
} from "./native-vault";

// ── Database Schema ──────────────────────────────

class ChatDatabase extends Dexie {
    messages!: Dexie.Table<ChatMessage, string>;
    sessions!: Dexie.Table<ChatSession, string>;
    contacts!: Dexie.Table<ChatContact, string>;

    constructor() {
        super("AiPhoneChatDB");
        this.version(1).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
        });
    }
}

export const chatDb = new ChatDatabase();

// ── Initialization + Migration from localStorage ──

const LS_MESSAGES_KEY = "ai_phone_chat_messages_v1";
const LS_SESSIONS_KEY = "ai_phone_chat_sessions_v1";
const LS_CONTACTS_KEY = "ai_phone_chat_contacts_v1";
const LS_MIGRATED_FLAG = "ai_phone_idb_migrated_v1";

// ── 按会话增量落盘到 Android 原生 filesDir（单会话独立分片，绝不全库重写，主动删除即时同步）──

const _sessionMirrorTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionVaultKey(sessionId: string): string {
    return `${VAULT_KEYS.CHAT_SESSION_PREFIX}${sessionId}`;
}

function removeLegacySessionDiskFiles(sessionId: string): void {
    if (!sessionId) return;
    vaultRemove(`${VAULT_KEYS.LEGACY_CHAT_META_PREFIX}${sessionId}`);
    vaultRemovePhysicalByPrefix(`${VAULT_KEYS.LEGACY_CHAT_SESS_PREFIX}${sessionId}`);
}

function removeSessionDiskMirror(sessionId: string): void {
    if (!sessionId) return;
    const pending = _sessionMirrorTimers.get(sessionId);
    if (pending) {
        clearTimeout(pending);
        _sessionMirrorTimers.delete(sessionId);
    }
    vaultRemove(sessionVaultKey(sessionId));
    removeLegacySessionDiskFiles(sessionId);
}

function writeSingleSessionMirror(sessionId: string, list: ChatMessage[]): void {
    if (!sessionId || !hasNativeVault()) return;
    if (!list || list.length === 0) {
        removeSessionDiskMirror(sessionId);
        return;
    }
    vaultWriteJson(sessionVaultKey(sessionId), list);
    removeLegacySessionDiskFiles(sessionId);
}

async function flushSessionDiskMirrorNow(sessionId: string): Promise<void> {
    if (!sessionId || !hasNativeVault()) return;
    const pending = _sessionMirrorTimers.get(sessionId);
    if (pending) {
        clearTimeout(pending);
        _sessionMirrorTimers.delete(sessionId);
    }
    try {
        const list = await chatDb.messages.where("sessionId").equals(sessionId).toArray();
        writeSingleSessionMirror(sessionId, list);
    } catch {
        // ignore
    }
}

function scheduleSessionDiskMirror(sessionId: string): void {
    if (!sessionId || !hasNativeVault()) return;
    const prev = _sessionMirrorTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
        _sessionMirrorTimers.delete(sessionId);
        void flushSessionDiskMirrorNow(sessionId);
    }, 600);
    _sessionMirrorTimers.set(sessionId, timer);
}

function syncAllSessionsListToVault(): void {
    if (!hasNativeVault()) return;
    void chatDb.sessions.toArray()
        .then((all) => { vaultWriteJson(VAULT_KEYS.CHAT_SESSIONS, all); })
        .catch(() => {});
}

function syncAllContactsListToVault(): void {
    if (!hasNativeVault()) return;
    void chatDb.contacts.toArray()
        .then((all) => { vaultWriteJson(VAULT_KEYS.CHAT_CONTACTS, all); })
        .catch(() => {});
}

function readLegacyMessagesFromDisk(): ChatMessage[] {
    const bridge = getNativeVaultBridge();
    if (!bridge?.loadLocalDiskData || !bridge.listLocalDiskKeys) return [];
    const combined: ChatMessage[] = [];
    const seenIds = new Set<string>();
    const addMsgs = (arr: unknown) => {
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
            if (item && typeof item === "object" && "id" in item && typeof (item as ChatMessage).id === "string") {
                const msg = item as ChatMessage;
                if (!seenIds.has(msg.id)) {
                    seenIds.add(msg.id);
                    combined.push(msg);
                }
            }
        }
    };
    try {
        const keys = JSON.parse(bridge.listLocalDiskKeys() || "[]");
        if (!Array.isArray(keys)) return [];
        for (const k of keys) {
            if (typeof k !== "string") continue;
            if (k.startsWith(VAULT_KEYS.LEGACY_CHAT_META_PREFIX)) {
                const sid = k.slice(VAULT_KEYS.LEGACY_CHAT_META_PREFIX.length);
                const metaRaw = bridge.loadLocalDiskData(k);
                if (!metaRaw) continue;
                const meta = JSON.parse(metaRaw) as { chunks?: number };
                const count = Number(meta?.chunks || 0);
                for (let i = 0; i < count; i += 1) {
                    const chunkRaw = bridge.loadLocalDiskData(`${VAULT_KEYS.LEGACY_CHAT_SESS_PREFIX}${sid}_p${i}`);
                    if (chunkRaw) addMsgs(JSON.parse(chunkRaw));
                }
            } else if (k.startsWith(VAULT_KEYS.LEGACY_CHAT_SESS_PREFIX) && !k.includes("_p")) {
                const raw = bridge.loadLocalDiskData(k);
                if (raw) addMsgs(JSON.parse(raw));
            }
        }
    } catch {
        // ignore
    }
    return combined;
}

function readMessagesDiskMirror(): ChatMessage[] {
    if (!hasNativeVault()) return [];
    const combined: ChatMessage[] = [];
    const seenIds = new Set<string>();
    const append = (arr: ChatMessage[] | null) => {
        if (!Array.isArray(arr)) return;
        for (const msg of arr) {
            if (msg && typeof msg.id === "string" && !seenIds.has(msg.id)) {
                seenIds.add(msg.id);
                combined.push(msg);
            }
        }
    };

    const newKeys = vaultListLogicalKeys(VAULT_KEYS.CHAT_SESSION_PREFIX);
    for (const k of newKeys) {
        append(vaultReadJson<ChatMessage[]>(k));
    }

    // 兼容历史旧版分片（msg_meta_ / msg_sess_），避免老用户升级后首轮灾备读不到旧档
    if (combined.length === 0) {
        append(readLegacyMessagesFromDisk());
    }
    return combined;
}

/** 仅当原生盘尚无新版镜像（如首次升级或刚导入备份清旧后）时，在后台按会话逐个补齐镜像。 */
function backfillChatVaultIfMissing(
    messages: ChatMessage[],
    sessions: ChatSession[],
    contacts: ChatContact[],
): void {
    if (!hasNativeVault()) return;
    if (!vaultHasKey(VAULT_KEYS.CHAT_SESSIONS) && sessions.length > 0) {
        vaultWriteJson(VAULT_KEYS.CHAT_SESSIONS, sessions);
    }
    if (!vaultHasKey(VAULT_KEYS.CHAT_CONTACTS) && contacts.length > 0) {
        vaultWriteJson(VAULT_KEYS.CHAT_CONTACTS, contacts);
    }
    if (messages.length === 0) return;

    const bySession = new Map<string, ChatMessage[]>();
    for (const m of messages) {
        if (!m || !m.sessionId) continue;
        if (vaultHasKey(sessionVaultKey(m.sessionId))) continue;
        const arr = bySession.get(m.sessionId);
        if (arr) arr.push(m);
        else bySession.set(m.sessionId, [m]);
    }
    if (bySession.size === 0) return;

    const entries = Array.from(bySession.entries());
    let idx = 0;
    const step = () => {
        if (idx >= entries.length) {
            vaultRemove(VAULT_KEYS.LEGACY_CHAT_MESSAGES);
            return;
        }
        const [sid, list] = entries[idx];
        idx += 1;
        writeSingleSessionMirror(sid, list);
        setTimeout(step, 40);
    };
    setTimeout(step, 300);
}

export async function initChatDb(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
}> {
    if (typeof window === "undefined") {
        return { messages: [], sessions: [], contacts: [] };
    }

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        let indexedDbHasData = false;
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            indexedDbHasData = existingCount > 0;
        } catch (err) {
            console.warn("[ChatDB] Pre-migration IndexedDB check failed; recovering directly:", err);
            const recovered = await loadFromIndexedDbWithRetries();
            if (recovered) {
                markMigrated();
                return recovered;
            }
            throw new Error(`[ChatDB] 无法读取本地聊天数据库（${err instanceof Error ? err.message : String(err)}），已保持未水合状态以避免覆盖真实数据`);
        }

        if (indexedDbHasData) {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            markMigrated();
            clearLegacyLocalStorage();
            backfillChatVaultIfMissing(messages, sessions, contacts);
            return { messages, sessions, contacts };
        }

        const diskSessions = vaultReadJson<ChatSession[]>(VAULT_KEYS.CHAT_SESSIONS) ?? [];
        const diskContacts = vaultReadJson<ChatContact[]>(VAULT_KEYS.CHAT_CONTACTS) ?? [];
        const diskMessages = readMessagesDiskMirror();
        if (diskSessions.length > 0 || diskContacts.length > 0 || diskMessages.length > 0) {
            markMigrated();
            clearLegacyLocalStorage();
            if (diskMessages.length > 0) await chatDb.messages.bulkPut(diskMessages).catch(() => {});
            if (diskSessions.length > 0) await chatDb.sessions.bulkPut(diskSessions).catch(() => {});
            if (diskContacts.length > 0) await chatDb.contacts.bulkPut(diskContacts).catch(() => {});
            return { messages: diskMessages, sessions: diskSessions, contacts: diskContacts };
        }

        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) await chatDb.messages.bulkPut(lsMessages);
            if (lsSessions.length > 0) await chatDb.sessions.bulkPut(lsSessions);
            if (lsContacts.length > 0) await chatDb.contacts.bulkPut(lsContacts);

            markMigrated();
            clearLegacyLocalStorage();
            backfillChatVaultIfMissing(lsMessages, lsSessions, lsContacts);

            return { messages: lsMessages, sessions: lsSessions, contacts: lsContacts };
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            return {
                messages: safeParse(window.localStorage.getItem(LS_MESSAGES_KEY)),
                sessions: safeParse(window.localStorage.getItem(LS_SESSIONS_KEY)),
                contacts: safeParse(window.localStorage.getItem(LS_CONTACTS_KEY)),
            };
        }
    }

    const loaded = await loadFromIndexedDbWithRetries();
    if (!loaded) {
        throw new Error("[ChatDB] Failed to load after 3 attempts");
    }
    return loaded;
}

function clearLegacyLocalStorage(): void {
    try {
        window.localStorage.removeItem(LS_MESSAGES_KEY);
        window.localStorage.removeItem(LS_SESSIONS_KEY);
        window.localStorage.removeItem(LS_CONTACTS_KEY);
    } catch {
        // ignore
    }
}

function markMigrated(): void {
    try {
        window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
    } catch (err) {
        console.warn("[ChatDB] Failed to persist migration flag:", err);
    }
}

async function loadFromIndexedDbWithRetries(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
} | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const [loadedMessages, loadedSessions, loadedContacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            let messages = loadedMessages;
            let sessions = loadedSessions;
            let contacts = loadedContacts;

            // 仅当整库全空（WebView 缓存被系统清除）时才从原生硬盘恢复，绝不复活主动删掉的会话或单条消息
            if (messages.length === 0 && sessions.length === 0 && contacts.length === 0) {
                const diskMessages = readMessagesDiskMirror();
                const diskSessions = vaultReadJson<ChatSession[]>(VAULT_KEYS.CHAT_SESSIONS) ?? [];
                const diskContacts = vaultReadJson<ChatContact[]>(VAULT_KEYS.CHAT_CONTACTS) ?? [];
                if (diskMessages.length > 0) {
                    messages = diskMessages;
                    await chatDb.messages.bulkPut(diskMessages).catch(() => {});
                }
                if (diskSessions.length > 0) {
                    sessions = diskSessions;
                    await chatDb.sessions.bulkPut(diskSessions).catch(() => {});
                }
                if (diskContacts.length > 0) {
                    contacts = diskContacts;
                    await chatDb.contacts.bulkPut(diskContacts).catch(() => {});
                }
            } else {
                backfillChatVaultIfMissing(messages, sessions, contacts);
            }
            console.log(`[ChatDB] Loaded from IndexedDB: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        } catch (err) {
            lastErr = err;
            console.warn(`[ChatDB] Load attempt ${attempt + 1}/3 failed:`, err);
            if (attempt < 2) {
                await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
                try { if (!chatDb.isOpen()) await chatDb.open(); } catch { /* ignore */ }
            }
        }
    }
    console.error("[ChatDB] All load attempts failed:", lastErr);
    return null;
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Async persistence helpers ──

export function dbPutMessage(msg: ChatMessage): void {
    chatDb.messages.put(msg)
        .then(() => { if (msg?.sessionId) scheduleSessionDiskMirror(msg.sessionId); })
        .catch((err) => console.warn("[ChatDB] put message failed:", err));
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    const sids = new Set<string>();
    for (const m of msgs) {
        if (m?.sessionId) sids.add(m.sessionId);
    }
    chatDb.messages.bulkPut(msgs)
        .then(() => { for (const sid of sids) scheduleSessionDiskMirror(sid); })
        .catch((err) => console.warn("[ChatDB] bulkPut messages failed:", err));
}

const DB_BULK_PUT_CHUNK = 2000;
export async function dbBulkPutMessages(msgs: ChatMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    const sids = new Set<string>();
    for (const m of msgs) {
        if (m?.sessionId) sids.add(m.sessionId);
    }
    for (let start = 0; start < msgs.length; start += DB_BULK_PUT_CHUNK) {
        await chatDb.messages.bulkPut(msgs.slice(start, start + DB_BULK_PUT_CHUNK));
    }
    for (const sid of sids) scheduleSessionDiskMirror(sid);
}

export function dbDeleteMessage(id: string): void {
    void (async () => {
        try {
            const existing = await chatDb.messages.get(id);
            await chatDb.messages.delete(id);
            if (existing?.sessionId) {
                await flushSessionDiskMirrorNow(existing.sessionId);
            }
        } catch (err) {
            console.warn("[ChatDB] delete message failed:", err);
        }
    })();
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    removeSessionDiskMirror(sessionId);
    chatDb.messages.where("sessionId").equals(sessionId).delete()
        .catch((err) => console.warn("[ChatDB] delete session messages failed:", err));
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    if (ids.length === 0) return;
    void (async () => {
        try {
            const existing = await chatDb.messages.bulkGet(ids);
            const sids = new Set<string>();
            for (const m of existing) {
                if (m?.sessionId) sids.add(m.sessionId);
            }
            await chatDb.messages.bulkDelete(ids);
            for (const sid of sids) {
                await flushSessionDiskMirrorNow(sid);
            }
        } catch (err) {
            console.warn("[ChatDB] bulkDelete messages failed:", err);
        }
    })();
}

export function dbPutSession(session: ChatSession): void {
    chatDb.sessions.put(session)
        .then(() => syncAllSessionsListToVault())
        .catch((err) => console.warn("[ChatDB] put session failed:", err));
}

export function dbPutSessions(sessions: ChatSession[]): void {
    chatDb.sessions.bulkPut(sessions)
        .then(() => syncAllSessionsListToVault())
        .catch((err) => console.warn("[ChatDB] bulkPut sessions failed:", err));
}

export function dbReplaceSessions(sessions: ChatSession[]): void {
    vaultWriteJson(VAULT_KEYS.CHAT_SESSIONS, sessions);
    chatDb.transaction("rw", chatDb.sessions, async () => {
        await chatDb.sessions.clear();
        await chatDb.sessions.bulkPut(sessions);
    }).catch((err) => console.warn("[ChatDB] replace sessions failed:", err));
}

export function dbDeleteSession(id: string): void {
    removeSessionDiskMirror(id);
    chatDb.sessions.delete(id)
        .then(() => syncAllSessionsListToVault())
        .catch((err) => console.warn("[ChatDB] delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    chatDb.contacts.bulkPut(contacts)
        .then(() => syncAllContactsListToVault())
        .catch((err) => console.warn("[ChatDB] bulkPut contacts failed:", err));
}

export function dbClearContacts(): void {
    vaultWriteJson(VAULT_KEYS.CHAT_CONTACTS, []);
    chatDb.contacts.clear().catch((err) => console.warn("[ChatDB] clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    vaultWriteJson(VAULT_KEYS.CHAT_CONTACTS, contacts);
    chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    }).catch((err) => console.warn("[ChatDB] replaceContacts failed:", err));
}
