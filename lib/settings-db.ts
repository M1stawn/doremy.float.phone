// lib/settings-db.ts
// IndexedDB persistence for presets, world books, and regex configs.
// Same pattern as chat-db.ts: in-memory cache + async fire-and-forget writes.

import Dexie from "dexie";
import type { PresetConfig, WorldBookConfig, RegexConfig } from "./settings-types";
import {
    VAULT_KEYS,
    hasNativeVault,
    vaultHasKey,
    vaultReadJson,
    vaultWriteJson,
} from "./native-vault";

// ── Database Schema ──────────────────────────────

class SettingsDatabase extends Dexie {
    presets!: Dexie.Table<PresetConfig, string>;
    worldBooks!: Dexie.Table<WorldBookConfig, string>;
    regexes!: Dexie.Table<RegexConfig, string>;

    constructor() {
        super("AiPhoneSettingsDB");
        this.version(1).stores({
            presets: "id",
            worldBooks: "id",
            regexes: "id",
        });
    }
}

const settingsDb = new SettingsDatabase();

// ── localStorage keys (for migration) ──

const LS_PRESETS_KEY = "ai_phone_presets_v1";
const LS_WORLDBOOKS_KEY = "ai_phone_worldbooks_v1";
const LS_REGEXES_KEY = "ai_phone_regexes_v1";
const LS_MIGRATED_FLAG = "ai_phone_settings_idb_migrated_v1";

// ── In-memory caches ──

let _presets: PresetConfig[] | null = null;
let _worldBooks: WorldBookConfig[] | null = null;
let _regexes: RegexConfig[] | null = null;
let _hydrated = false;
let _presetsWriteQueue: Promise<void> = Promise.resolve();

function writeSettingsDiskMirror<T>(key: string, items: T[]): void {
    if (typeof window === "undefined" || !hasNativeVault()) return;
    if (!_hydrated && items.length === 0) return;
    vaultWriteJson(key, items);
}

function readSettingsDiskMirror<T>(key: string): T[] {
    const parsed = vaultReadJson<T[]>(key);
    return Array.isArray(parsed) ? parsed : [];
}

function backfillSettingsVaultIfMissing(
    presets: PresetConfig[],
    worldBooks: WorldBookConfig[],
    regexes: RegexConfig[],
): void {
    if (!hasNativeVault()) return;
    if (!vaultHasKey(VAULT_KEYS.SETTINGS_PRESETS)) vaultWriteJson(VAULT_KEYS.SETTINGS_PRESETS, presets);
    if (!vaultHasKey(VAULT_KEYS.SETTINGS_WORLDBOOKS)) vaultWriteJson(VAULT_KEYS.SETTINGS_WORLDBOOKS, worldBooks);
    if (!vaultHasKey(VAULT_KEYS.SETTINGS_REGEXES)) vaultWriteJson(VAULT_KEYS.SETTINGS_REGEXES, regexes);
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Hydration (must be called once at startup) ──

export async function hydrateSettingsDb(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return;

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        try {
            const existingCount =
                (await settingsDb.presets.count()) +
                (await settingsDb.worldBooks.count()) +
                (await settingsDb.regexes.count());
            if (existingCount > 0) {
                window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
                const [presets, worldBooks, regexes] = await Promise.all([
                    settingsDb.presets.toArray(),
                    settingsDb.worldBooks.toArray(),
                    settingsDb.regexes.toArray(),
                ]);
                _presets = presets;
                _worldBooks = worldBooks;
                _regexes = regexes;
                _hydrated = true;
                backfillSettingsVaultIfMissing(presets, worldBooks, regexes);
                console.log(`[SettingsDB] Migration flag missing but IndexedDB has data; reusing it: ${presets.length} presets, ${worldBooks.length} worldBooks, ${regexes.length} regexes`);
                return;
            }
        } catch (err) {
            console.warn("[SettingsDB] Pre-migration IndexedDB check failed:", err);
        }

        const lsPresets: PresetConfig[] = safeParse(window.localStorage.getItem(LS_PRESETS_KEY));
        const lsWorldBooks: WorldBookConfig[] = safeParse(window.localStorage.getItem(LS_WORLDBOOKS_KEY));
        const lsRegexes: RegexConfig[] = safeParse(window.localStorage.getItem(LS_REGEXES_KEY));

        if (lsPresets.length === 0 && lsWorldBooks.length === 0 && lsRegexes.length === 0 && hasNativeVault()) {
            const diskPresets = readSettingsDiskMirror<PresetConfig>(VAULT_KEYS.SETTINGS_PRESETS);
            const diskBooks = readSettingsDiskMirror<WorldBookConfig>(VAULT_KEYS.SETTINGS_WORLDBOOKS);
            const diskRegexes = readSettingsDiskMirror<RegexConfig>(VAULT_KEYS.SETTINGS_REGEXES);
            if (diskPresets.length > 0 || diskBooks.length > 0 || diskRegexes.length > 0) {
                if (diskPresets.length > 0) await settingsDb.presets.bulkPut(diskPresets).catch(() => {});
                if (diskBooks.length > 0) await settingsDb.worldBooks.bulkPut(diskBooks).catch(() => {});
                if (diskRegexes.length > 0) await settingsDb.regexes.bulkPut(diskRegexes).catch(() => {});
                try { window.localStorage.setItem(LS_MIGRATED_FLAG, "1"); } catch { /* ignore */ }
                _presets = diskPresets;
                _worldBooks = diskBooks;
                _regexes = diskRegexes;
                _hydrated = true;
                return;
            }
        }

        // Migrate from localStorage → IndexedDB
        try {
            if (lsPresets.length > 0) await settingsDb.presets.bulkPut(lsPresets);
            if (lsWorldBooks.length > 0) await settingsDb.worldBooks.bulkPut(lsWorldBooks);
            if (lsRegexes.length > 0) await settingsDb.regexes.bulkPut(lsRegexes);

            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_PRESETS_KEY);
            window.localStorage.removeItem(LS_WORLDBOOKS_KEY);
            window.localStorage.removeItem(LS_REGEXES_KEY);

            console.log(`[SettingsDB] Migrated: ${lsPresets.length} presets, ${lsWorldBooks.length} worldBooks, ${lsRegexes.length} regexes`);

            _presets = lsPresets;
            _worldBooks = lsWorldBooks;
            _regexes = lsRegexes;
            backfillSettingsVaultIfMissing(lsPresets, lsWorldBooks, lsRegexes);
        } catch (err) {
            console.error("[SettingsDB] Migration failed, falling back to localStorage:", err);
            _presets = lsPresets;
            _worldBooks = lsWorldBooks;
            _regexes = lsRegexes;
        }
        _hydrated = true;
        return;
    }

    // Already migrated: load from IndexedDB; only recover from native disk if ALL 3 tables are empty
    try {
        const [loadedPresets, loadedWorldBooks, loadedRegexes] = await Promise.all([
            settingsDb.presets.toArray(),
            settingsDb.worldBooks.toArray(),
            settingsDb.regexes.toArray(),
        ]);
        let presets = loadedPresets;
        let worldBooks = loadedWorldBooks;
        let regexes = loadedRegexes;

        if (presets.length === 0 && worldBooks.length === 0 && regexes.length === 0) {
            const diskPresets = readSettingsDiskMirror<PresetConfig>(VAULT_KEYS.SETTINGS_PRESETS);
            const diskBooks = readSettingsDiskMirror<WorldBookConfig>(VAULT_KEYS.SETTINGS_WORLDBOOKS);
            const diskRegexes = readSettingsDiskMirror<RegexConfig>(VAULT_KEYS.SETTINGS_REGEXES);
            if (diskPresets.length > 0) {
                presets = diskPresets;
                await settingsDb.presets.bulkPut(diskPresets).catch(() => {});
            }
            if (diskBooks.length > 0) {
                worldBooks = diskBooks;
                await settingsDb.worldBooks.bulkPut(diskBooks).catch(() => {});
            }
            if (diskRegexes.length > 0) {
                regexes = diskRegexes;
                await settingsDb.regexes.bulkPut(diskRegexes).catch(() => {});
            }
        } else {
            backfillSettingsVaultIfMissing(presets, worldBooks, regexes);
        }
        _presets = presets;
        _worldBooks = worldBooks;
        _regexes = regexes;
        _hydrated = true;
        console.log(`[SettingsDB] Loaded: ${presets.length} presets, ${worldBooks.length} worldBooks, ${regexes.length} regexes`);
    } catch (err) {
        console.error("[SettingsDB] Failed to load from IndexedDB:", err);
        const diskPresets = readSettingsDiskMirror<PresetConfig>(VAULT_KEYS.SETTINGS_PRESETS);
        const diskBooks = readSettingsDiskMirror<WorldBookConfig>(VAULT_KEYS.SETTINGS_WORLDBOOKS);
        const diskRegexes = readSettingsDiskMirror<RegexConfig>(VAULT_KEYS.SETTINGS_REGEXES);
        if (diskPresets.length > 0 || diskBooks.length > 0 || diskRegexes.length > 0) {
            _presets = diskPresets;
            _worldBooks = diskBooks;
            _regexes = diskRegexes;
            _hydrated = true;
        }
    }
}

export function isSettingsHydrated(): boolean {
    return _hydrated;
}

// ── Sync reads from cache ──

export function readPresetsCache(): PresetConfig[] {
    return _presets ?? [];
}

export function readWorldBooksCache(): WorldBookConfig[] {
    return _worldBooks ?? [];
}

export function readRegexesCache(): RegexConfig[] {
    return _regexes ?? [];
}

// ── Writes: update cache + async persist ──

function persistPresetsSnapshot(presets: PresetConfig[]): Promise<void> {
    return settingsDb.transaction("rw", settingsDb.presets, async () => {
        await settingsDb.presets.clear();
        await settingsDb.presets.bulkPut(presets);
    });
}

function enqueuePresetsPersist(presets: PresetConfig[], warnInQueue: boolean): Promise<void> {
    const task = _presetsWriteQueue.then(() => persistPresetsSnapshot(presets));
    _presetsWriteQueue = task.catch((err) => {
        if (warnInQueue) console.warn("[SettingsDB] save presets failed:", err);
    });
    return task;
}

export function writePresetsCache(presets: PresetConfig[]): void {
    _presets = presets;
    writeSettingsDiskMirror(VAULT_KEYS.SETTINGS_PRESETS, presets);
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writePresetsCache before hydration; using additive write to avoid replacing existing presets.");
        settingsDb.presets.bulkPut(presets).catch((err) => console.warn("[SettingsDB] additive save presets failed:", err));
        return;
    }
    void enqueuePresetsPersist(presets, true);
}

export async function writePresetsCacheAsync(presets: PresetConfig[]): Promise<void> {
    _presets = presets;
    writeSettingsDiskMirror(VAULT_KEYS.SETTINGS_PRESETS, presets);
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writePresetsCacheAsync before hydration; using additive write to avoid replacing existing presets.");
        await settingsDb.presets.bulkPut(presets);
        return;
    }
    try {
        await enqueuePresetsPersist(presets, false);
    } catch (err) {
        console.warn("[SettingsDB] save presets failed:", err);
        throw err;
    }
}

export function writeWorldBooksCache(books: WorldBookConfig[]): void {
    _worldBooks = books;
    writeSettingsDiskMirror(VAULT_KEYS.SETTINGS_WORLDBOOKS, books);
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writeWorldBooksCache before hydration; using additive write to avoid replacing existing worldBooks.");
        settingsDb.worldBooks.bulkPut(books).catch((err) => console.warn("[SettingsDB] additive save worldBooks failed:", err));
        return;
    }
    settingsDb.transaction("rw", settingsDb.worldBooks, async () => {
        await settingsDb.worldBooks.clear();
        await settingsDb.worldBooks.bulkPut(books);
    }).catch((err) => console.warn("[SettingsDB] save worldBooks failed:", err));
}

export function writeRegexesCache(regexes: RegexConfig[]): void {
    _regexes = regexes;
    writeSettingsDiskMirror(VAULT_KEYS.SETTINGS_REGEXES, regexes);
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writeRegexesCache before hydration; using additive write to avoid replacing existing regexes.");
        settingsDb.regexes.bulkPut(regexes).catch((err) => console.warn("[SettingsDB] additive save regexes failed:", err));
        return;
    }
    settingsDb.transaction("rw", settingsDb.regexes, async () => {
        await settingsDb.regexes.clear();
        await settingsDb.regexes.bulkPut(regexes);
    }).catch((err) => console.warn("[SettingsDB] save regexes failed:", err));
}
