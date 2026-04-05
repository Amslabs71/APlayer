const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { get, put } = require("@vercel/blob");

const SESSION_COOKIE = "amos_player_session";
const STATE_PATH = "app/state.json";
const DEFAULT_PROGRESS_START = "#050505";
const DEFAULT_PROGRESS_END = "#2d7dff";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

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

function createEmptyState() {
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

function normalizeState(raw) {
    return {
        ...createEmptyState(),
        ...raw,
        library: Array.isArray(raw?.library) ? raw.library : [],
        series: Array.isArray(raw?.series) ? raw.series : [],
        accounts: Array.isArray(raw?.accounts) ? raw.accounts.map(normalizeAccountRecord) : [],
        admin: {
            pinHash: typeof raw?.admin?.pinHash === "string" ? raw.admin.pinHash : null
        },
        meta: {
            createdAt: Number(raw?.meta?.createdAt) || Date.now(),
            updatedAt: Number(raw?.meta?.updatedAt) || Date.now()
        }
    };
}

function normalizeSession(raw) {
    return {
        userKey: typeof raw?.userKey === "string" && raw.userKey ? raw.userKey : null,
        adminUnlocked: Boolean(raw?.adminUnlocked)
    };
}

function getCookieSecret() {
    return process.env.APP_COOKIE_SECRET || process.env.BLOB_READ_WRITE_TOKEN || "amos-player-dev-secret";
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

function signSessionValue(value) {
    return crypto.createHmac("sha256", getCookieSecret()).update(value).digest("base64url");
}

function encodeSession(session) {
    const payload = Buffer.from(JSON.stringify(normalizeSession(session))).toString("base64url");
    const signature = signSessionValue(payload);
    return `${payload}.${signature}`;
}

function decodeSession(rawValue) {
    if (!rawValue || typeof rawValue !== "string") return normalizeSession(null);
    const separator = rawValue.lastIndexOf(".");
    if (separator === -1) return normalizeSession(null);

    const payload = rawValue.slice(0, separator);
    const signature = rawValue.slice(separator + 1);
    if (signSessionValue(payload) !== signature) {
        return normalizeSession(null);
    }

    try {
        const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return normalizeSession(json);
    } catch {
        return normalizeSession(null);
    }
}

function makeSessionCookie(session) {
    return `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(session))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

function clearSessionCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function streamToText(stream) {
    const reader = stream.getReader();
    const chunks = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks).toString("utf8");
}

async function readSeedState() {
    try {
        const seedPath = path.join(process.cwd(), "data", "store.json");
        const raw = await fs.readFile(seedPath, "utf8");
        return normalizeState(JSON.parse(raw));
    } catch {
        return createEmptyState();
    }
}

async function readState() {
    const result = await get(STATE_PATH, {
        access: "private",
        useCache: false
    });

    if (result?.stream) {
        const raw = await streamToText(result.stream);
        return normalizeState(JSON.parse(raw));
    }

    const seed = await readSeedState();
    await writeState(seed);
    return seed;
}

async function writeState(state) {
    const normalized = normalizeState({
        ...state,
        meta: {
            createdAt: Number(state?.meta?.createdAt) || Date.now(),
            updatedAt: Date.now()
        }
    });

    await put(STATE_PATH, JSON.stringify(normalized), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: 60
    });

    return normalized;
}

function buildSnapshot(state, session) {
    return {
        library: state.library,
        series: state.series,
        accounts: state.accounts.map(sanitizeAccount),
        currentUserKey: session.userKey || null,
        adminUnlocked: Boolean(session.adminUnlocked),
        hasAdminPin: Boolean(state.admin?.pinHash)
    };
}

function getCurrentAccount(state, session) {
    return state.accounts.find((account) => account.usernameKey === session.userKey) ?? null;
}

function syncSessionAccount(state, session) {
    if (!session.userKey) return;
    if (!state.accounts.some((account) => account.usernameKey === session.userKey)) {
        session.userKey = null;
    }
}

function sendJson(res, statusCode, payload, { cookie } = {}) {
    if (cookie) {
        res.setHeader("Set-Cookie", cookie);
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(statusCode).json(payload);
}

function parsePath(req) {
    const parts = req.query?.path;
    const segments = Array.isArray(parts) ? parts : parts ? [parts] : [];
    return `/${segments.join("/")}`;
}

function getJsonBody(req) {
    if (!req.body) return {};
    if (typeof req.body === "string") {
        return JSON.parse(req.body || "{}");
    }
    return req.body;
}

module.exports = async function handler(req, res) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        sendJson(res, 500, {
            error: "Vercel Blob is not configured. Connect a Blob store to this project first."
        });
        return;
    }

    const session = decodeSession(parseCookies(req)[SESSION_COOKIE]);
    const pathname = parsePath(req);

    try {
        if (req.method === "GET" && pathname === "/bootstrap") {
            const state = await readState();
            syncSessionAccount(state, session);
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "POST" && pathname === "/migrate/local") {
            const incoming = getJsonBody(req);
            let state = await readState();
            const isFreshState = !state.library.length && !state.series.length && !state.accounts.length && !state.admin.pinHash;

            if (isFreshState) {
                state.library = sanitizeLibrary(incoming.library);
                const libraryIds = new Set(state.library.map((item) => item.id));
                state.series = sanitizeSeries(incoming.series, libraryIds);
                state.accounts = Array.isArray(incoming.accounts)
                    ? incoming.accounts.map(normalizeAccountRecord).filter((account) => account.usernameKey && account.passwordHash)
                    : [];
                if (!state.admin.pinHash && typeof incoming.pin === "string" && incoming.pin.trim()) {
                    state.admin.pinHash = hashValue(incoming.pin.trim());
                }

                const desiredUserKey = normalizeUsername(incoming.currentUserKey || "");
                if (desiredUserKey && state.accounts.some((account) => account.usernameKey === desiredUserKey)) {
                    session.userKey = desiredUserKey;
                }

                state = await writeState(state);
            }

            syncSessionAccount(state, session);
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "PUT" && pathname === "/library") {
            if (!session.adminUnlocked) {
                sendJson(res, 401, { error: "Unlock the admin panel first." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            const incoming = getJsonBody(req);
            let state = await readState();
            state.library = sanitizeLibrary(incoming.library);
            const libraryIds = new Set(state.library.map((item) => item.id));
            state.series = sanitizeSeries(state.series, libraryIds);
            state = await writeState(state);
            syncSessionAccount(state, session);
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "PUT" && pathname === "/series") {
            if (!session.adminUnlocked) {
                sendJson(res, 401, { error: "Unlock the admin panel first." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            const incoming = getJsonBody(req);
            let state = await readState();
            const libraryIds = new Set(state.library.map((item) => item.id));
            state.series = sanitizeSeries(incoming.series, libraryIds);
            state = await writeState(state);
            syncSessionAccount(state, session);
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "POST" && pathname === "/auth/register") {
            const incoming = getJsonBody(req);
            const username = String(incoming.username || "").trim();
            const password = String(incoming.password || "");
            const usernameKey = normalizeUsername(username);
            let state = await readState();

            if (!username || !password) {
                sendJson(res, 400, { error: "Username and password are required." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            if (password.length < 4) {
                sendJson(res, 400, { error: "Password needs at least 4 characters." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            if (state.accounts.some((account) => account.usernameKey === usernameKey)) {
                sendJson(res, 409, { error: "That username already exists." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            state.accounts.push(normalizeAccountRecord({
                username,
                usernameKey,
                passwordHash: hashValue(password),
                progress: {},
                preferences: getDefaultAccountPreferences()
            }));
            state = await writeState(state);
            session.userKey = usernameKey;
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "POST" && pathname === "/auth/login") {
            const incoming = getJsonBody(req);
            const username = String(incoming.username || "").trim();
            const password = String(incoming.password || "");
            const usernameKey = normalizeUsername(username);
            const state = await readState();

            if (!username || !password) {
                sendJson(res, 400, { error: "Username and password are required." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            const account = state.accounts.find((entry) => entry.usernameKey === usernameKey);
            if (!account) {
                sendJson(res, 404, { error: "Account not found." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            if (hashValue(password) !== account.passwordHash) {
                sendJson(res, 401, { error: "Password is incorrect." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            session.userKey = account.usernameKey;
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "POST" && pathname === "/auth/logout") {
            const state = await readState();
            session.userKey = null;
            session.adminUnlocked = false;
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: clearSessionCookie()
            });
            return;
        }

        if (req.method === "PATCH" && pathname === "/account/settings") {
            const incoming = getJsonBody(req);
            let state = await readState();
            const account = getCurrentAccount(state, session);

            if (!account) {
                sendJson(res, 401, { error: "Sign in first." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            const username = String(incoming.username || "").trim();
            const usernameKey = normalizeUsername(username);

            if (!username) {
                sendJson(res, 400, { error: "Username is required." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            const isTaken = state.accounts.some((entry) =>
                entry.usernameKey === usernameKey && entry.usernameKey !== account.usernameKey
            );
            if (isTaken) {
                sendJson(res, 409, { error: "That username already exists." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            const previousUserKey = account.usernameKey;
            account.username = username;
            account.usernameKey = usernameKey;
            account.preferences = {
                progressStart: normalizeHexColor(incoming.progressStart, DEFAULT_PROGRESS_START),
                progressEnd: normalizeHexColor(incoming.progressEnd, DEFAULT_PROGRESS_END)
            };

            session.userKey = usernameKey;
            state.accounts = state.accounts.map((entry) =>
                entry.usernameKey === previousUserKey
                    ? normalizeAccountRecord({ ...entry, ...account })
                    : entry
            );
            state = await writeState(state);
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "DELETE" && pathname === "/account") {
            let state = await readState();
            if (!getCurrentAccount(state, session)) {
                sendJson(res, 401, { error: "Sign in first." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            state.accounts = state.accounts.filter((entry) => entry.usernameKey !== session.userKey);
            session.userKey = null;
            session.adminUnlocked = false;
            state = await writeState(state);
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: clearSessionCookie()
            });
            return;
        }

        if (req.method === "POST" && pathname === "/admin/unlock") {
            const incoming = getJsonBody(req);
            const pin = String(incoming.pin || "").trim();
            let state = await readState();

            if (pin.length < 4) {
                sendJson(res, 400, { error: "Please use at least 4 characters." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            if (!state.admin.pinHash) {
                state.admin.pinHash = hashValue(pin);
                state = await writeState(state);
            } else if (state.admin.pinHash !== hashValue(pin)) {
                sendJson(res, 401, { error: "PIN does not match the saved admin PIN." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            session.adminUnlocked = true;
            sendJson(res, 200, buildSnapshot(state, session), {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "POST" && pathname === "/progress") {
            const incoming = getJsonBody(req);
            let state = await readState();
            const account = getCurrentAccount(state, session);

            if (!account) {
                sendJson(res, 401, { error: "Sign in first." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            const itemId = String(incoming.itemId || "").trim();
            const currentTime = Number(incoming.currentTime) || 0;
            const duration = Number(incoming.duration) || 0;
            const completed = Boolean(incoming.completed);

            if (!itemId || !duration) {
                sendJson(res, 400, { error: "Item and duration are required." }, {
                    cookie: makeSessionCookie(session)
                });
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

            state.accounts = state.accounts.map((entry) =>
                entry.usernameKey === account.usernameKey ? normalizeAccountRecord(account) : entry
            );
            await writeState(state);
            sendJson(res, 200, { ok: true }, {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        if (req.method === "DELETE" && pathname.startsWith("/progress/")) {
            const itemId = decodeURIComponent(pathname.slice("/progress/".length));
            let state = await readState();
            const account = getCurrentAccount(state, session);

            if (!account) {
                sendJson(res, 401, { error: "Sign in first." }, {
                    cookie: makeSessionCookie(session)
                });
                return;
            }

            if (account.progress && typeof account.progress === "object") {
                delete account.progress[itemId];
            }

            state.accounts = state.accounts.map((entry) =>
                entry.usernameKey === account.usernameKey ? normalizeAccountRecord(account) : entry
            );
            await writeState(state);
            sendJson(res, 200, { ok: true }, {
                cookie: makeSessionCookie(session)
            });
            return;
        }

        sendJson(res, 404, { error: "Not found." }, {
            cookie: makeSessionCookie(session)
        });
    } catch (error) {
        sendJson(res, 500, { error: error?.message || "Unexpected server error." }, {
            cookie: makeSessionCookie(session)
        });
    }
};
