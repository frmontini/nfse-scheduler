/*
 * Sessão do painel por cookie assinado (HMAC-SHA256), sem dependência externa.
 * O segredo sai de APP_SESSION_SECRET ou, na falta dele, da própria senha do
 * painel — trocar a senha invalida as sessões abertas.
 */
const crypto = require('node:crypto');

const COOKIE_NAME = 'nfse_session';
const MAX_AGE_SECONDS = Number(process.env.APP_SESSION_HOURS || 12) * 3600;
const LOGIN_WINDOW_MS = 60000;
const LOGIN_MAX_ATTEMPTS = 5;

const attempts = new Map();

function authRequired() {
  return Boolean(process.env.APP_ADMIN_PASSWORD);
}

function secret() {
  return process.env.APP_SESSION_SECRET || `nfse-auto:${process.env.APP_ADMIN_PASSWORD || ''}`;
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + MAX_AGE_SECONDS * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  if (!safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function isSecureRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, user) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(createToken(user))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function basicCredentials(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return null; }
  const split = decoded.indexOf(':');
  if (split < 0) return null;
  return { user: decoded.slice(0, split), password: decoded.slice(split + 1) };
}

function checkCredentials(user, password) {
  const expectedUser = process.env.APP_ADMIN_USER || 'admin';
  const expectedPassword = process.env.APP_ADMIN_PASSWORD || '';
  return safeEqual(String(user || ''), expectedUser) && safeEqual(String(password || ''), expectedPassword);
}

function tooManyAttempts(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) { attempts.delete(key); return false; }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function registerFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

function clearFailures(key) {
  attempts.delete(key);
}

function currentUser(req) {
  if (!authRequired()) return { u: process.env.APP_ADMIN_USER || 'admin', anonymous: true };
  const fromCookie = verifyToken(readCookie(req));
  if (fromCookie) return fromCookie;
  const basic = basicCredentials(req);
  if (basic && checkCredentials(basic.user, basic.password)) return { u: basic.user, viaBasic: true };
  return null;
}

function guard(req, res, next) {
  if (currentUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.', login: true });
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  authRequired,
  checkCredentials,
  setSessionCookie,
  clearSessionCookie,
  currentUser,
  guard,
  tooManyAttempts,
  registerFailure,
  clearFailures,
  createToken,
  verifyToken
};
