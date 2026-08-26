const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ADMIN_USER = 'admin';
process.env.APP_ADMIN_PASSWORD = 'senha-forte';
delete process.env.APP_SESSION_SECRET;

const session = require('../src/session');

test('cookie assinado sobrevive à ida e volta', () => {
  const token = session.createToken('admin');
  assert.equal(session.verifyToken(token)?.u, 'admin');
});

test('token adulterado é rejeitado', () => {
  const token = session.createToken('admin');
  const [payload, signature] = token.split('.');
  assert.equal(session.verifyToken(`${payload}.${signature.slice(0, -2)}xx`), null);
  const forged = Buffer.from(JSON.stringify({ u: 'invasor', exp: Date.now() + 60000 })).toString('base64url');
  assert.equal(session.verifyToken(`${forged}.${signature}`), null);
  assert.equal(session.verifyToken('lixo'), null);
});

test('trocar a senha do painel invalida as sessões abertas', () => {
  const token = session.createToken('admin');
  process.env.APP_ADMIN_PASSWORD = 'outra-senha';
  assert.equal(session.verifyToken(token), null);
  process.env.APP_ADMIN_PASSWORD = 'senha-forte';
});

test('token expirado não vale', () => {
  const payload = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() - 1000 })).toString('base64url');
  const crypto = require('node:crypto');
  const signature = crypto.createHmac('sha256', `nfse-auto:${process.env.APP_ADMIN_PASSWORD}`).update(payload).digest('base64url');
  assert.equal(session.verifyToken(`${payload}.${signature}`), null);
});

test('credenciais são conferidas por igualdade exata', () => {
  assert.equal(session.checkCredentials('admin', 'senha-forte'), true);
  assert.equal(session.checkCredentials('admin', 'senha-fort'), false);
  assert.equal(session.checkCredentials('Admin', 'senha-forte'), false);
  assert.equal(session.checkCredentials('', ''), false);
});

test('bloqueia depois de 5 tentativas na mesma janela', () => {
  const key = 'ip-de-teste';
  for (let i = 0; i < 4; i++) session.registerFailure(key);
  assert.equal(session.tooManyAttempts(key), false);
  session.registerFailure(key);
  assert.equal(session.tooManyAttempts(key), true);
  session.clearFailures(key);
  assert.equal(session.tooManyAttempts(key), false);
});

test('sem senha configurada, o painel não exige login', () => {
  const saved = process.env.APP_ADMIN_PASSWORD;
  delete process.env.APP_ADMIN_PASSWORD;
  assert.equal(session.authRequired(), false);
  assert.ok(session.currentUser({ headers: {} }));
  process.env.APP_ADMIN_PASSWORD = saved;
});
