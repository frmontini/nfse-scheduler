const { digits } = require('../utils');

function baseUrl() {
  return (process.env.NFSE_BASE_URL || 'https://www.nfse.gov.br').replace(/\/$/, '');
}

async function login(page) {
  const user = digits(process.env.NFSE_LOGIN);
  const password = process.env.NFSE_PASSWORD || '';
  if (!user || !password) throw new Error('NFSE_LOGIN/NFSE_PASSWORD não configurados no .env.');

  const url = `${baseUrl()}/EmissorNacional/Login`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('#Inscricao', user);
  await page.fill('#Senha', password);
  await page.locator('button:has-text("Entrar")').first().click({ timeout: 10000 });
  await page.waitForURL((u) => !u.toString().includes('/Login'), { timeout: 20000 }).catch(() => {});

  if (page.url().includes('/Login')) {
    const body = await page.locator('body').innerText().catch(() => '');
    const msg = /captcha/i.test(body)
      ? 'O portal exigiu CAPTCHA no login. A automação não tenta contornar CAPTCHA.'
      : 'Login não saiu da tela de autenticação. Confira CNPJ e senha.';
    throw new Error(msg);
  }
  return true;
}

module.exports = { login, baseUrl };
