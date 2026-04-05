const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const STORE_BACKEND = DATABASE_URL ? "postgres" : "file";
const STORE_RECORD_KEY = "main";
const SESSION_COOKIE = "amos_player_session";
const DEFAULT_PROGRESS_START = "#050505";
const DEFAULT_PROGRESS_END = "#2d7dff";
const sessions = new Map();
const dbPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 4 }) : null;
let storeBackendReadyPromise = null;

function makeId() {
    return crypto.randomUUID();
}

function hashValue(value) {
    return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeUsername(username) {
    return String(username || "").trim().toLowerCase();
}

function normalizeHexColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(value || "") ? String(value).toLowerCase() : fallback;
}

function getDefaultAccountPreferences() {
    return {
        progressStart: DEFAULT_PROGRESS_START,
        progressEnd: DEFAULT_PROGRESS_END
    };
}

function createEmptyStore() {
    return {
        library: [],
        series: [],
        accounts: [],
        admin: {
            pinHash: null
        },
        meta: {
            createdAt: Date.now(),
            updatedAt: Date.now()
        }
    };
}

function normalizeStoreShape(store) {
    const base = createEmptyStore();
    const nextLibrary = sanitizeLibrary(store?.library);
    const libraryIds = new Set(nextLibrary.map((item) => item.id));

    return {
        ...base,
        ...store,
        library: nextLibrary,
        series: sanitizeSeries(store?.series, libraryIds),
        accounts: Array.isArray(store?.accounts) ? store.accounts.map(normalizeAccountRecord) : [],
        admin: {
            pinHash: typeof store?.admin?.pinHash === "string" ? store.admin.pinHash : null
        },
        meta: {
            createdAt: Number(store?.meta?.createdAt) || Date.now(),
            updatedAt: Date.now()
        }
    };
}

async function ensureFileStore() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    try {
        await fsp.access(STORE_FILE, fs.constants.F_OK);
    } catch {
        await fsp.writeFile(STORE_FILE, JSON.stringify(normalizeStoreShape(createEmptyStore()), null, 2), "utf8");
    }
}

async function readSeedStoreFromDisk() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    try {
        const raw = await fsp.readFile(STORE_FILE, "utf8");
        return normalizeStoreShape(JSON.parse(raw));
    } catch {
        return normalizeStoreShape(createEmptyStore());
    }
}

async function ensureDatabaseStore() {
    if (!dbPool) return;
    if (!storeBackendReadyPromise) {
        storeBackendReadyPromise = (async () => {
            await dbPool.query(`
                CREATE TABLE IF NOT EXISTS app_state (
                    store_key TEXT PRIMARY KEY,
                    payload JSONB NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);

            const existing = await dbPool.query(
                "SELECT 1 FROM app_state WHERE store_key = $1 LIMIT 1",
                [STORE_RECORD_KEY]
            );

            if (!existing.rowCount) {
                const seedStore = await readSeedStoreFromDisk();
                await dbPool.query(
                    `
                    INSERT INTO app_state (store_key, payload, updated_at)
                    VALUES ($1, $2::jsonb, NOW())
                    `,
                    [STORE_RECORD_KEY, JSON.stringify(seedStore)]
                );
            }
        })().catch((error) => {
            storeBackendReadyPromise = null;
            throw error;
        });
    }

    await storeBackendReadyPromise;
}

async function readStore() {
    if (STORE_BACKEND === "postgres") {
        await ensureDatabaseStore();
        const result = await dbPool.query(
            "SELECT payload FROM app_state WHERE store_key = $1 LIMIT 1",
            [STORE_RECORD_KEY]
        );

        if (!result.rowCount) {
            const seedStore = await readSeedStoreFromDisk();
            await writeStore(seedStore);
            return seedStore;
        }

        return normalizeStoreShape(result.rows[0].payload);
    }

    await ensureFileStore();
    return readSeedStoreFromDisk();
}

async function writeStore(store) {
    const nextStore = normalizeStoreShape(store);

    if (STORE_BACKEND === "postgres") {
        await ensureDatabaseStore();
        await dbPool.query(
            `
            INSERT INTO app_state (store_key, payload, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (store_key)
            DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
            `,
            [STORE_RECORD_KEY, JSON.stringify(nextStore)]
        );
        return;
    }

    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(STORE_FILE, JSON.stringify(nextStore, null, 2), "utf8");
}

function normalizeAccountRecord(account) {
    const username = typeof account?.username === "string" && account.username.trim()
        ? account.username.trim()
        : "Guest";
    const usernameKey = normalizeUsername(account?.usernameKey || username);
    const preferences = account?.preferences && typeof account.preferences === "object"
        ? account.preferences
        : {};
    const migratedStart = preferences.progressStart === "#ffffff" ? DEFAULT_PROGRESS_START : preferences.progressStart;
    const migratedEnd = preferences.progressEnd === "#96ddff" ? DEFAULT_PROGRESS_END : preferences.progressEnd;

    return {
        username,
        usernameKey,
        passwordHash: typeof account?.passwordHash === "string" ? account.passwordHash : "",
        progress: account?.progress && typeof account.progress === "object" ? account.progress : {},
        preferences: {
            ...getDefaultAccountPreferences(),
            progressStart: normalizeHexColor(migratedStart, DEFAULT_PROGRESS_START),
            progressEnd: normalizeHexColor(migratedEnd, DEFAULT_PROGRESS_END)
        }
    };
}

function sanitizeAccount(account) {
    const normalized = normalizeAccountRecord(account);
    return {
        username: normalized.username,
        usernameKey: normalized.usernameKey,
        progress: normalized.progress,
        preferences: normalized.preferences
    };
}

function sanitizeLibraryItem(item) {
    if (!item || typeof item !== "object") return null;
    const title = String(item.title || "").trim();
    const url = String(item.url || "").trim();
    if (!title || !url) return null;

    return {
        id: String(item.id || makeId()),
        title,
        url,
        sourceInput: String(item.sourceInput || item.url || "").trim(),
        playerType: String(item.playerType || "hls").trim() || "hls",
        cover: String(item.cover || "").trim(),
        createdAt: Number(item.createdAt) || Date.now()
    };
}

function sanitizeLibrary(library) {
    return Array.isArray(library)
        ? library.map(sanitizeLibraryItem).filter(Boolean)
        : [];
}

function sanitizeSeries(seriesList, libraryIds) {
    if (!Array.isArray(seriesList)) return [];
    const assignedIds = new Set();

    return seriesList
        .map((series) => {
            if (!series || typeof series !== "object") return null;
            const title = String(series.title || "").trim();
            if (!title) return null;

            const uniqueIds = [];
            for (const rawId of Array.isArray(series.itemIds) ? series.itemIds : []) {
                const itemId = String(rawId || "").trim();
                if (!itemId || !libraryIds.has(itemId) || assignedIds.has(itemId)) continue;
                assignedIds.add(itemId);
                uniqueIds.push(itemId);
            }

            return {
                id: String(series.id || makeId()),
                title,
                cover: String(series.cover || "").trim(),
                itemIds: uniqueIds,
                createdAt: Number(series.createdAt) || Date.now()
            };
        })
        .filter(Boolean);
}

function parseCookies(req) {
    const header = req.headers.cookie || "";
    return header
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .reduce((cookies, entry) => {
            const separator = entry.indexOf("=");
            if (separator === -1) return cookies;
            const key = entry.slice(0, separator).trim();
            const value = entry.slice(separator + 1).trim();
            cookies[key] = decodeURIComponent(value);
            return cookies;
        }, {});
}

function setSessionCookie(res, sessionId) {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}

function getSession(req, res) {
    const cookies = parseCookies(req);
    const existingId = cookies[SESSION_COOKIE];
    if (existingId && sessions.has(existingId)) {
        return sessions.get(existingId);
    }

    const session = {
        id: makeId(),
        userKey: null,
        adminUnlocked: false
    };
    sessions.set(session.id, session);
    setSessionCookie(res, session.id);
    return session;
}

function buildSnapshot(store, session) {
    return {
        library: store.library,
        series: store.series,
        accounts: store.accounts.map(sanitizeAccount),
        currentUserKey: session.userKey || null,
        adminUnlocked: Boolean(session.adminUnlocked),
        hasAdminPin: Boolean(store.admin?.pinHash)
    };
}

function setJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(body);
}

function setText(res, statusCode, message) {
    res.writeHead(statusCode, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(message);
}

function applyApiCors(res, req) {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin === "null" ? "null" : origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
        const size = chunks.reduce((total, entry) => total + entry.length, 0);
        if (size > 1024 * 1024) {
            throw new Error("Payload too large.");
        }
    }

    if (!chunks.length) return {};
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
}

function getCurrentAccount(store, session) {
    return store.accounts.find((account) => account.usernameKey === session.userKey) ?? null;
}

function syncSessionAccount(store, session) {
    if (!session.userKey) return;
    if (!store.accounts.some((account) => account.usernameKey === session.userKey)) {
        session.userKey = null;
    }
}

function isAdminUnlocked(session) {
    return Boolean(session?.adminUnlocked);
}

async function handleBootstrap(req, res, session) {
    const store = await readStore();
    syncSessionAccount(store, session);
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleLocalMigration(req, res, session) {
    const body = await readJsonBody(req);
    const store = await readStore();
    const isFreshStore = !store.library.length && !store.series.length && !store.accounts.length && !store.admin.pinHash;

    if (isFreshStore) {
        store.library = sanitizeLibrary(body.library);
        const libraryIds = new Set(store.library.map((item) => item.id));
        store.series = sanitizeSeries(body.series, libraryIds);
        store.accounts = Array.isArray(body.accounts)
            ? body.accounts.map(normalizeAccountRecord).filter((account) => account.usernameKey && account.passwordHash)
            : [];
        if (!store.admin.pinHash && typeof body.pin === "string" && body.pin.trim()) {
            store.admin.pinHash = hashValue(body.pin.trim());
        }

        const desiredUserKey = normalizeUsername(body.currentUserKey || "");
        if (desiredUserKey && store.accounts.some((account) => account.usernameKey === desiredUserKey)) {
            session.userKey = desiredUserKey;
        }

        await writeStore(store);
    }

    syncSessionAccount(store, session);
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleLibraryUpdate(req, res, session) {
    if (!isAdminUnlocked(session)) {
        setJson(res, 401, { error: "Unlock the admin panel first." });
        return;
    }
    const body = await readJsonBody(req);
    const store = await readStore();
    store.library = sanitizeLibrary(body.library);
    const libraryIds = new Set(store.library.map((item) => item.id));
    store.series = sanitizeSeries(store.series, libraryIds);
    await writeStore(store);
    syncSessionAccount(store, session);
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleSeriesUpdate(req, res, session) {
    if (!isAdminUnlocked(session)) {
        setJson(res, 401, { error: "Unlock the admin panel first." });
        return;
    }
    const body = await readJsonBody(req);
    const store = await readStore();
    const libraryIds = new Set(store.library.map((item) => item.id));
    store.series = sanitizeSeries(body.series, libraryIds);
    await writeStore(store);
    syncSessionAccount(store, session);
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleRegister(req, res, session) {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const usernameKey = normalizeUsername(username);
    const store = await readStore();

    if (!username || !password) {
        setJson(res, 400, { error: "Username and password are required." });
        return;
    }

    if (password.length < 4) {
        setJson(res, 400, { error: "Password needs at least 4 characters." });
        return;
    }

    if (store.accounts.some((account) => account.usernameKey === usernameKey)) {
        setJson(res, 409, { error: "That username already exists." });
        return;
    }

    store.accounts.push(normalizeAccountRecord({
        username,
        usernameKey,
        passwordHash: hashValue(password),
        progress: {},
        preferences: getDefaultAccountPreferences()
    }));
    session.userKey = usernameKey;
    await writeStore(store);
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleLogin(req, res, session) {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const usernameKey = normalizeUsername(username);
    const store = await readStore();

    if (!username || !password) {
        setJson(res, 400, { error: "Username and password are required." });
        return;
    }

    const account = store.accounts.find((entry) => entry.usernameKey === usernameKey);
    if (!account) {
        setJson(res, 404, { error: "Account not found." });
        return;
    }

    if (hashValue(password) !== account.passwordHash) {
        setJson(res, 401, { error: "Password is incorrect." });
        return;
    }

    session.userKey = account.usernameKey;
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleLogout(req, res, session) {
    const store = await readStore();
    session.userKey = null;
    session.adminUnlocked = false;
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleAccountSettings(req, res, session) {
    const body = await readJsonBody(req);
    const store = await readStore();
    const account = getCurrentAccount(store, session);

    if (!account) {
        setJson(res, 401, { error: "Sign in first." });
        return;
    }

    const username = String(body.username || "").trim();
    const usernameKey = normalizeUsername(username);
    if (!username) {
        setJson(res, 400, { error: "Username is required." });
        return;
    }

    const isTaken = store.accounts.some((entry) =>
        entry.usernameKey === usernameKey && entry.usernameKey !== account.usernameKey
    );
    if (isTaken) {
        setJson(res, 409, { error: "That username already exists." });
        return;
    }

    const previousUserKey = account.usernameKey;
    account.username = username;
    account.usernameKey = usernameKey;
    account.preferences = {
        progressStart: normalizeHexColor(body.progressStart, DEFAULT_PROGRESS_START),
        progressEnd: normalizeHexColor(body.progressEnd, DEFAULT_PROGRESS_END)
    };

    session.userKey = usernameKey;
    store.accounts = store.accounts.map((entry) =>
        entry.usernameKey === previousUserKey
            ? normalizeAccountRecord({ ...entry, ...account })
            : entry
    );

    await writeStore(store);
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleAccountDelete(req, res, session) {
    const store = await readStore();
    if (!getCurrentAccount(store, session)) {
        setJson(res, 401, { error: "Sign in first." });
        return;
    }

    store.accounts = store.accounts.filter((entry) => entry.usernameKey !== session.userKey);
    session.userKey = null;
    await writeStore(store);
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleAdminUnlock(req, res, session) {
    const body = await readJsonBody(req);
    const pin = String(body.pin || "").trim();
    const store = await readStore();

    if (pin.length < 4) {
        setJson(res, 400, { error: "Please use at least 4 characters." });
        return;
    }

    if (!store.admin.pinHash) {
        store.admin.pinHash = hashValue(pin);
        await writeStore(store);
    } else if (store.admin.pinHash !== hashValue(pin)) {
        setJson(res, 401, { error: "PIN does not match the saved admin PIN." });
        return;
    }

    session.adminUnlocked = true;
    setJson(res, 200, buildSnapshot(store, session));
}

async function handleProgressUpdate(req, res, session) {
    const body = await readJsonBody(req);
    const store = await readStore();
    const account = getCurrentAccount(store, session);

    if (!account) {
        setJson(res, 401, { error: "Sign in first." });
        return;
    }

    const itemId = String(body.itemId || "").trim();
    const currentTime = Number(body.currentTime) || 0;
    const duration = Number(body.duration) || 0;
    const completed = Boolean(body.completed);

    if (!itemId || !duration) {
        setJson(res, 400, { error: "Item and duration are required." });
        return;
    }

    if (!account.progress || typeof account.progress !== "object") {
        account.progress = {};
    }

    if (completed || currentTime >= Math.max(duration - 10, duration * 0.95)) {
        delete account.progress[itemId];
    } else if (currentTime > 5) {
        account.progress[itemId] = {
            currentTime,
            duration,
            updatedAt: Date.now(),
            completed: false
        };
    }

    store.accounts = store.accounts.map((entry) =>
        entry.usernameKey === account.usernameKey ? normalizeAccountRecord(account) : entry
    );
    await writeStore(store);
    setJson(res, 200, { ok: true });
}

async function handleProgressDelete(req, res, session, itemId) {
    const store = await readStore();
    const account = getCurrentAccount(store, session);

    if (!account) {
        setJson(res, 401, { error: "Sign in first." });
        return;
    }

    if (account.progress && typeof account.progress === "object") {
        delete account.progress[itemId];
    }

    store.accounts = store.accounts.map((entry) =>
        entry.usernameKey === account.usernameKey ? normalizeAccountRecord(account) : entry
    );
    await writeStore(store);
    setJson(res, 200, { ok: true });
}

async function serveIndex(res) {
    const html = await fsp.readFile(INDEX_FILE, "utf8");
    res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(html);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const isApiRoute = url.pathname.startsWith("/api/");

    if (isApiRoute) {
        applyApiCors(res, req);
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
    }

    const session = getSession(req, res);

    try {
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
            await serveIndex(res);
            return;
        }

        if (req.method === "GET" && url.pathname === "/healthz") {
            setJson(res, 200, { ok: true, backend: STORE_BACKEND });
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/bootstrap") {
            await handleBootstrap(req, res, session);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/migrate/local") {
            await handleLocalMigration(req, res, session);
            return;
        }

        if (req.method === "PUT" && url.pathname === "/api/library") {
            await handleLibraryUpdate(req, res, session);
            return;
        }

        if (req.method === "PUT" && url.pathname === "/api/series") {
            await handleSeriesUpdate(req, res, session);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/auth/register") {
            await handleRegister(req, res, session);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/auth/login") {
            await handleLogin(req, res, session);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/auth/logout") {
            await handleLogout(req, res, session);
            return;
        }

        if (req.method === "PATCH" && url.pathname === "/api/account/settings") {
            await handleAccountSettings(req, res, session);
            return;
        }

        if (req.method === "DELETE" && url.pathname === "/api/account") {
            await handleAccountDelete(req, res, session);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/admin/unlock") {
            await handleAdminUnlock(req, res, session);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/progress") {
            await handleProgressUpdate(req, res, session);
            return;
        }

        const progressDeleteMatch = req.method === "DELETE" && url.pathname.match(/^\/api\/progress\/([^/]+)$/);
        if (progressDeleteMatch) {
            await handleProgressDelete(req, res, session, decodeURIComponent(progressDeleteMatch[1]));
            return;
        }

        if (!isApiRoute && req.method === "GET") {
            await serveIndex(res);
            return;
        }

        setText(res, 404, "Not found.");
    } catch (error) {
        if (error instanceof SyntaxError) {
            setJson(res, 400, { error: "Invalid JSON payload." });
            return;
        }
        setJson(res, 500, { error: error?.message || "Unexpected server error." });
    }
});

server.listen(PORT, () => {
    console.log(`Amos Player server is running on http://localhost:${PORT} using ${STORE_BACKEND} storage.`);
});

async function closeResources() {
    if (dbPool) {
        await dbPool.end().catch(() => null);
    }
}

process.on("SIGINT", async () => {
    await closeResources();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await closeResources();
    process.exit(0);
});
