const express = require('express');
const { 
    createGuestAccount, 
    getGuestAccountByUuid, 
    refreshGuestAccountExpiration,
    createSession, 
    validateSession, 
    deleteSession,
    deleteSessionsForAccount,
    getAccountById,
    getUsernameById,
    registerGuestAccount,
    loginAccount,
    getAccountData,
    cleanupExpiredGuests,
    getGuestAccountTtlDays
} = require('./database');

const router = express.Router();

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
};

function setAuthCookie(res, token) {
    res.cookie('auth_token', token, COOKIE_OPTIONS);
}

function clearAuthCookie(res) {
    res.clearCookie('auth_token', COOKIE_OPTIONS);
}

function getTokenFromRequest(req) {
    return req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
}

function requireAuth(req, res, next) {
    const token = getTokenFromRequest(req);
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const session = validateSession(token);
    if (!session) {
        clearAuthCookie(res);
        return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.auth = session;
    next();
}

function optionalAuth(req, res, next) {
    const token = getTokenFromRequest(req);
    if (token) {
        const session = validateSession(token);
        if (session) {
            req.auth = session;
        }
    }
    next();
}

router.post('/auth/guest', optionalAuth, (req, res) => {
    if (req.auth) {
        return res.json({ 
            authenticated: true,
            accountType: req.auth.accountType,
            accountId: req.auth.accountId,
            username: req.auth.username,
            guestUuid: req.auth.guestUuid,
            authToken: getTokenFromRequest(req)
        });
    }

    const account = createGuestAccount();
    const session = createSession(account.accountId);
    setAuthCookie(res, session.token);

    res.json({
        authenticated: false,
        accountType: 'guest',
        accountId: account.accountId,
        guestUuid: account.guestUuid,
        expiresAt: account.expiresAt,
        ttlDays: getGuestAccountTtlDays(),
        authToken: session.token
    });
});

router.post('/auth/guest/recover', (req, res) => {
    const { guestUuid } = req.body;
    if (!guestUuid) {
        return res.status(400).json({ error: 'Guest UUID required' });
    }

    const account = getGuestAccountByUuid(guestUuid);
    if (!account) {
        return res.status(401).json({ error: 'Invalid or expired guest UUID' });
    }
    if (account.expired) {
        return res.status(401).json({ error: 'Guest account has expired' });
    }

    const newExpiresAt = refreshGuestAccountExpiration(guestUuid);
    const session = createSession(account.id);
    setAuthCookie(res, session.token);

    res.json({
        authenticated: false,
        accountType: 'guest',
        accountId: account.id.toString(),
        guestUuid: account.guest_uuid,
        expiresAt: newExpiresAt,
        ttlDays: getGuestAccountTtlDays(),
        authToken: session.token
    });
});

router.post('/auth/register', (req, res) => {
    const { guestUuid, username, password } = req.body;
    if (!guestUuid || !username || !password) {
        return res.status(400).json({ error: 'Guest UUID, username, and password required' });
    }

    if (username.length < 3 || username.length > 32) {
        return res.status(400).json({ error: 'Username must be 3-32 characters' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(username)) {
        return res.status(400).json({ error: 'Username may only contain letters, numbers, dashes (-) and underscores (_)' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
        const result = registerGuestAccount(guestUuid, username, password);
        const session = createSession(result.accountId);
        setAuthCookie(res, session.token);

        res.json({
            authenticated: true,
            accountType: 'registered',
            accountId: result.accountId,
            username: result.username,
            authToken: session.token
        });
    } catch (error) {
        if (error.message === 'Guest account not found' || error.message === 'Guest account has expired') {
            return res.status(401).json({ error: error.message });
        }
        if (error.message === 'Username already taken') {
            return res.status(409).json({ error: error.message });
        }
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

router.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    const result = loginAccount(username, password);
    if (!result) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    const session = createSession(result.accountId);
    setAuthCookie(res, session.token);

    res.json({
        authenticated: true,
        accountType: 'registered',
        accountId: result.accountId,
        username: result.username,
        authToken: session.token
    });
});

router.post('/auth/logout', (req, res) => {
    const token = getTokenFromRequest(req);
    if (token) {
        deleteSession(token);
    }
    clearAuthCookie(res);
    res.json({ success: true });
});

router.get('/auth/me', optionalAuth, (req, res) => {
    if (!req.auth) {
        return res.json({ authenticated: false });
    }

    const accountData = getAccountData(req.auth.accountId);
    const token = getTokenFromRequest(req);
    res.json({
        authenticated: true,
        accountType: req.auth.accountType,
        accountId: req.auth.accountId,
        username: req.auth.username,
        guestUuid: req.auth.guestUuid,
        authToken: token,
        ...accountData
    });
});

router.post('/auth/switch', requireAuth, (req, res) => {
    const { targetAccountId } = req.body;
    if (!targetAccountId) {
        return res.status(400).json({ error: 'Target account ID required' });
    }

    const targetAccount = getAccountById(targetAccountId);
    if (!targetAccount) {
        return res.status(404).json({ error: 'Account not found' });
    }

    if (targetAccount.account_type === 'guest' && targetAccount.expires_at && targetAccount.expires_at < Date.now()) {
        return res.status(401).json({ error: 'Guest account has expired' });
    }

    deleteSessionsForAccount(req.auth.accountId);
    const session = createSession(targetAccountId);
    setAuthCookie(res, session.token);

    const accountData = getAccountData(targetAccountId);
    res.json({
        authenticated: true,
        accountType: targetAccount.account_type,
        accountId: targetAccount.id.toString(),
        username: targetAccount.username,
        guestUuid: targetAccount.guest_uuid,
        authToken: session.token,
        ...accountData
    });
});

router.post('/auth/cleanup-guests', (req, res) => {
    const deletedCount = cleanupExpiredGuests();
    res.json({ deletedCount });
});

router.get('/users/:id', (req, res) => {
    const account = getUsernameById(req.params.id);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json(account);
});

module.exports = router;