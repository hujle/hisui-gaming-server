const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = path.resolve(__dirname, '../../data/auth.db');
const DATA_DIR = path.dirname(DB_PATH);

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initializeSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY,
            account_type TEXT NOT NULL CHECK (account_type IN ('guest', 'registered')),
            username TEXT UNIQUE,
            password_hash TEXT,
            guest_uuid TEXT UNIQUE,
            created_at INTEGER NOT NULL,
            last_activity_at INTEGER NOT NULL,
            expires_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_accounts_guest_uuid ON accounts(guest_uuid);
        CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
        CREATE INDEX IF NOT EXISTS idx_accounts_expires_at ON accounts(expires_at);

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            account_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);

        CREATE TABLE IF NOT EXISTS account_data (
            account_id INTEGER PRIMARY KEY,
            achievements TEXT DEFAULT '{}',
            items TEXT DEFAULT '{}',
            progress TEXT DEFAULT '{}',
            custom_data TEXT DEFAULT '{}',
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );
    `);
}

function ensureGuestNameColumn() {
    const columns = db.prepare('PRAGMA table_info(accounts)').all();
    if (!columns.some((column) => column.name === 'guest_name')) {
        db.exec('ALTER TABLE accounts ADD COLUMN guest_name TEXT');
    }
}

function ensurePlaytimeColumns() {
    const columns = db.prepare('PRAGMA table_info(account_data)').all();
    const names = columns.map((column) => column.name);
    if (!names.includes('playtime_total')) {
        db.exec('ALTER TABLE account_data ADD COLUMN playtime_total INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.includes('playtime_by_game')) {
        db.exec("ALTER TABLE account_data ADD COLUMN playtime_by_game TEXT NOT NULL DEFAULT '{}'");
    }
}

initializeSchema();
ensureGuestNameColumn();
ensurePlaytimeColumns();

function generateAccountId() {
    const buffer = crypto.randomBytes(8);
    let id = buffer.readBigUInt64LE(0);
    id = id & 0x7FFFFFFFFFFFFFFFn;
    if (id === 0n) id = 1n;
    return id;
}

function accountIdExists(id) {
    const stmt = db.prepare('SELECT 1 FROM accounts WHERE id = ?');
    return !!stmt.get(Number(id));
}

function generateUniqueAccountId() {
    let id;
    do {
        id = generateAccountId();
    } while (accountIdExists(id));
    return id;
}

function generateGuestUuid() {
    return crypto.randomUUID();
}

function guestUuidExists(uuid) {
    const stmt = db.prepare('SELECT 1 FROM accounts WHERE guest_uuid = ?');
    return !!stmt.get(uuid);
}

function generateUniqueGuestUuid() {
    let uuid;
    do {
        uuid = generateGuestUuid();
    } while (guestUuidExists(uuid));
    return uuid;
}

function hashPassword(password) {
    return bcrypt.hashSync(password, 12);
}

function verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

const DEFAULT_GUEST_TTL_DAYS = 30;
const GUEST_TTL_MS = (process.env.GUEST_ACCOUNT_TTL_DAYS ? parseInt(process.env.GUEST_ACCOUNT_TTL_DAYS) : DEFAULT_GUEST_TTL_DAYS) * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function now() {
    return Date.now();
}

function createGuestAccount() {
    const accountId = generateUniqueAccountId();
    const guestUuid = generateUniqueGuestUuid();
    const timestamp = now();

    // Guest accounts are persistent (no expiry): they behave like normal
    // accounts, they are just created automatically and only need a name.
    const stmt = db.prepare(`
        INSERT INTO accounts (id, account_type, guest_uuid, created_at, last_activity_at, expires_at)
        VALUES (?, 'guest', ?, ?, ?, NULL)
    `);
    stmt.run(Number(accountId), guestUuid, timestamp, timestamp);

    const dataStmt = db.prepare('INSERT INTO account_data (account_id) VALUES (?)');
    dataStmt.run(Number(accountId));

    return {
        accountId: accountId.toString(),
        guestUuid
    };
}

function getGuestAccountByUuid(guestUuid) {
    const stmt = db.prepare('SELECT * FROM accounts WHERE guest_uuid = ? AND account_type = ?');
    const account = stmt.get(guestUuid, 'guest');
    if (!account) return null;
    if (account.expires_at && account.expires_at < now()) {
        return { expired: true };
    }
    return account;
}

function loadGuestAccount(guestUuid) {
    const stmt = db.prepare('SELECT * FROM accounts WHERE guest_uuid = ? AND account_type = ?');
    return stmt.get(guestUuid, 'guest');
}

function setGuestName(guestUuid, username) {
    const timestamp = now();
    const result = db.prepare(`
        UPDATE accounts SET guest_name = ?, last_activity_at = ?
        WHERE guest_uuid = ? AND account_type = ?
    `).run(username, timestamp, guestUuid, 'guest');

    if (result.changes === 0) {
        throw new Error('Guest account not found');
    }

    const account = loadGuestAccount(guestUuid);
    return { accountId: account.id.toString(), username };
}

function refreshGuestAccountExpiration(guestUuid) {
    const newExpiresAt = now() + GUEST_TTL_MS;
    const stmt = db.prepare('UPDATE accounts SET last_activity_at = ?, expires_at = ? WHERE guest_uuid = ? AND account_type = ?');
    stmt.run(now(), newExpiresAt, guestUuid, 'guest');
    return newExpiresAt;
}

function createSession(accountId) {
    const token = generateSessionToken();
    const timestamp = now();
    const expiresAt = timestamp + SESSION_TTL_MS;

    const stmt = db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
    stmt.run(token, Number(accountId), timestamp, expiresAt);

    return { token, expiresAt };
}

function validateSession(token) {
    const stmt = db.prepare(`
        SELECT s.*, a.account_type, a.username, a.guest_name, a.guest_uuid
        FROM sessions s
        JOIN accounts a ON s.account_id = a.id
        WHERE s.token = ? AND s.expires_at > ?
    `);
    const session = stmt.get(token, now());
    if (!session) return null;
    return {
        accountId: session.account_id.toString(),
        accountType: session.account_type,
        username: session.username ?? session.guest_name,
        guestUuid: session.guest_uuid,
        expiresAt: session.expires_at
    };
}

function deleteSession(token) {
    const stmt = db.prepare('DELETE FROM sessions WHERE token = ?');
    stmt.run(token);
}

function deleteSessionsForAccount(accountId) {
    const stmt = db.prepare('DELETE FROM sessions WHERE account_id = ?');
    stmt.run(Number(accountId));
}

function getAccountById(accountId) {
    const stmt = db.prepare('SELECT * FROM accounts WHERE id = ?');
    return stmt.get(Number(accountId));
}

function getUsernameById(accountId) {
    const numericId = Number(accountId);
    if (!Number.isFinite(numericId)) {
        return null;
    }
    const stmt = db.prepare(`
        SELECT a.id, a.username, a.guest_name, a.account_type, d.playtime_total
        FROM accounts a
        LEFT JOIN account_data d ON d.account_id = a.id
        WHERE a.id = ?
    `);
    const account = stmt.get(numericId);
    if (!account) return null;
    return {
        id: account.id.toString(),
        username: account.username ?? account.guest_name,
        accountType: account.account_type,
        playtimeTotal: Number(account.playtime_total) || 0
    };
}

function getAccountByUsername(username) {
    const stmt = db.prepare('SELECT * FROM accounts WHERE username = ? AND account_type = ?');
    return stmt.get(username, 'registered');
}

function registerGuestAccount(guestUuid, username, password) {
    const transaction = db.transaction((guestUuid, username, password) => {
        const account = db.prepare('SELECT * FROM accounts WHERE guest_uuid = ? AND account_type = ?').get(guestUuid, 'guest');
        if (!account) {
            throw new Error('Guest account not found');
        }
        if (account.expires_at && account.expires_at < now()) {
            throw new Error('Guest account has expired');
        }

        const existingUsername = db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username);
        if (existingUsername) {
            throw new Error('Username already taken');
        }

        const passwordHash = hashPassword(password);
        const timestamp = now();

        db.prepare('UPDATE accounts SET account_type = ?, username = ?, password_hash = ?, guest_uuid = NULL, guest_name = NULL, last_activity_at = ?, expires_at = NULL WHERE id = ?')
            .run('registered', username, passwordHash, timestamp, Number(account.id));

        db.prepare('DELETE FROM sessions WHERE account_id = ?').run(Number(account.id));

        return { accountId: account.id.toString(), username };
    });

    return transaction(guestUuid, username, password);
}

function createRegisteredAccount(username, password) {
    const accountId = generateUniqueAccountId();
    const passwordHash = hashPassword(password);
    const timestamp = now();

    const transaction = db.transaction(() => {
        const existingUsername = db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username);
        if (existingUsername) {
            throw new Error('Username already taken');
        }

        db.prepare(`
            INSERT INTO accounts (id, account_type, username, password_hash, created_at, last_activity_at)
            VALUES (?, 'registered', ?, ?, ?, ?)
        `).run(Number(accountId), username, passwordHash, timestamp, timestamp);

        db.prepare('INSERT INTO account_data (account_id) VALUES (?)').run(Number(accountId));
    });

    transaction();
    return { accountId: accountId.toString(), username };
}

function loginAccount(username, password) {
    const account = getAccountByUsername(username);
    if (!account) return null;
    if (!verifyPassword(password, account.password_hash)) return null;

    const timestamp = now();
    db.prepare('UPDATE accounts SET last_activity_at = ? WHERE id = ?').run(timestamp, Number(account.id));

    return { accountId: account.id.toString(), username: account.username };
}

function getAccountData(accountId) {
    const stmt = db.prepare('SELECT * FROM account_data WHERE account_id = ?');
    let data = stmt.get(Number(accountId));
    if (!data) {
        const insertStmt = db.prepare('INSERT INTO account_data (account_id) VALUES (?)');
        insertStmt.run(Number(accountId));
        data = stmt.get(Number(accountId));
    }
    return {
        achievements: JSON.parse(data.achievements || '{}'),
        items: JSON.parse(data.items || '{}'),
        progress: JSON.parse(data.progress || '{}'),
        customData: JSON.parse(data.custom_data || '{}'),
        playtimeTotal: Number(data.playtime_total) || 0,
        playtimeByGame: JSON.parse(data.playtime_by_game || '{}')
    };
}

function addPlaytime(accountId, gameId, seconds) {
    const numericId = Number(accountId);
    const delta = Math.floor(Number(seconds));
    if (!Number.isFinite(numericId) || !Number.isFinite(delta) || delta <= 0 || !gameId) {
        return getAccountData(numericId);
    }

    const transaction = db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO account_data (account_id) VALUES (?)').run(numericId);

        const row = db.prepare('SELECT playtime_total, playtime_by_game FROM account_data WHERE account_id = ?').get(numericId);
        let byGame = {};
        try {
            byGame = JSON.parse(row.playtime_by_game || '{}');
        } catch (_) {
            byGame = {};
        }
        byGame[gameId] = (Number(byGame[gameId]) || 0) + delta;

        db.prepare('UPDATE account_data SET playtime_total = ?, playtime_by_game = ? WHERE account_id = ?')
            .run((Number(row.playtime_total) || 0) + delta, JSON.stringify(byGame), numericId);
    });

    transaction();
    return getAccountData(numericId);
}

function setAccountData(accountId, key, value) {
    const allowedKeys = ['achievements', 'items', 'progress', 'customData'];
    if (!allowedKeys.includes(key)) throw new Error('Invalid data key');
    const dbKey = key === 'customData' ? 'custom_data' : key;
    const stmt = db.prepare(`UPDATE account_data SET ${dbKey} = ? WHERE account_id = ?`);
    stmt.run(JSON.stringify(value), Number(accountId));
}

function cleanupExpiredGuests() {
    const expiredAccounts = db.prepare('SELECT id FROM accounts WHERE account_type = ? AND expires_at IS NOT NULL AND expires_at < ?').all('guest', now());
    if (expiredAccounts.length === 0) return 0;

    const ids = expiredAccounts.map(a => a.id);
    const placeholders = ids.map(() => '?').join(',');
    
    const transaction = db.transaction((ids) => {
        db.prepare(`DELETE FROM account_data WHERE account_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM sessions WHERE account_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM accounts WHERE id IN (${placeholders})`).run(...ids);
    });
    transaction(ids);
    return ids.length;
}

function getGuestAccountTtlDays() {
    return process.env.GUEST_ACCOUNT_TTL_DAYS ? parseInt(process.env.GUEST_ACCOUNT_TTL_DAYS) : DEFAULT_GUEST_TTL_DAYS;
}

module.exports = {
    db,
    createGuestAccount,
    getGuestAccountByUuid,
    loadGuestAccount,
    setGuestName,
    refreshGuestAccountExpiration,
    createSession,
    validateSession,
    deleteSession,
    deleteSessionsForAccount,
    getAccountById,
    getUsernameById,
    getAccountByUsername,
    registerGuestAccount,
    createRegisteredAccount,
    loginAccount,
    getAccountData,
    setAccountData,
    addPlaytime,
    cleanupExpiredGuests,
    getGuestAccountTtlDays,
    now,
    GUEST_TTL_MS,
    SESSION_TTL_MS
};