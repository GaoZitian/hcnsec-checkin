/**
 * gen-token.js - 本地一次性生成「刷新令牌」(new_api_refresh)
 *
 * 用法：
 *   cd src
 *   export HCNSEC_USERNAME="..." HCNSEC_PASSWORD="..."
 *   node gen-token.js
 *
 * 流程：
 *   1. 打开可见浏览器，自动填好用户名密码
 *   2. 你手动完成 Cloudflare Turnstile 验证并点登录
 *   3. 登录成功后，脚本抓取 new_api_refresh 刷新令牌，
 *      并当场调用 /api/user/auth/refresh 验证它真的能换到 access_token
 *   4. 打印出要存进 GitHub Secret (HCNSEC_REFRESH_TOKEN) 的值
 *
 * 为什么用它：刷新令牌是 JWT 性质、不绑定 IP。存一次即可在 GitHub
 *   Actions（美国 IP）上长期自刷新签到，彻底绕开 cookie 跨 IP 失效问题。
 */
import { chromium } from 'playwright';

const HOST = 'api.hcnsec.cn';
const BASE = `https://${HOST}`;
const LOGIN_PAGE = `${BASE}/login`;

const USERNAME = process.env.HCNSEC_USERNAME;
const PASSWORD = process.env.HCNSEC_PASSWORD;
if (!USERNAME || !PASSWORD) {
  console.error('[FATAL] 请先设置 HCNSEC_USERNAME / HCNSEC_PASSWORD 再运行');
  process.exit(1);
}

console.log('[INFO] 打开浏览器，请完成 Turnstile 验证并点击登录...');
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

try {
  await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[name="username"]', USERNAME).catch(() => {});
  await page.fill('input[name="password"]', PASSWORD).catch(() => {});
  // 勾选协议
  await page.evaluate(() => {
    document.querySelectorAll('input[type="checkbox"]').forEach(b => { b.checked = true; b.click(); });
  }).catch(() => {});

  console.log('    请在浏览器中完成人机验证并登录（最多等 5 分钟）...');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 300000 });
  console.log('    ✅ 检测到登录成功');

  // 访问 /api/user/auth 让 new_api_refresh cookie 落到 path 范围内
  await page.goto(`${BASE}/api/user/auth`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

  // 抓所有 cookie
  const cookies = await context.cookies();
  console.log('\n[INFO] 捕获到的 cookies:');
  for (const c of cookies) {
    console.log(`    - ${c.name} (domain=${c.domain}, path=${c.path}, httpOnly=${c.httpOnly})`);
  }

  // 找刷新令牌（New-API 用 new_api_refresh，若没有则用含 refresh 的兜底）
  const refresh = cookies.find(c => c.name === 'new_api_refresh')
               || cookies.find(c => c.name.toLowerCase().includes('refresh'));

  if (!refresh) {
    console.error('\n[ERROR] 未找到 new_api_refresh 刷新令牌 cookie。请把上方 cookie 列表发给我。');
    await browser.close();
    process.exit(1);
  }

  // 当场验证：用完整 cookie 调 refresh 能否换到 access_token
  console.log('\n[INFO] 验证刷新令牌可用性...');
  const rr = await context.request.post(`${BASE}/api/user/auth/refresh`, {
    headers: { Accept: 'application/json, text/plain, */*' }
  });
  let rj = {};
  try { rj = await rr.json(); } catch { rj = { raw: await rr.text() }; }
  const ok = rr.status() === 200 && rj.success === true;
  console.log(`    refresh 响应: HTTP ${rr.status()}  success=${rj.success}`);

  // 再验证 access_token 能否读 /self
  const token = rj.data?.token || rj.data?.access_token || rj.access_token || rj.token || '';
  if (token) {
    const sr = await context.request.get(`${BASE}/api/user/self`, {
      headers: { Accept: 'application/json, text/plain, */*', Authorization: `Bearer ${token}` }
    });
    console.log(`    用新 token 访问 /self: HTTP ${sr.status()} ${sr.status() === 200 ? '✅' : '❌'}`);
  }

  await browser.close();

  if (ok) {
    console.log('\n==============================================================');
    console.log('✅ 刷新令牌验证通过！请把下面这串值存到 GitHub Secret:');
    console.log('    名称: HCNSEC_REFRESH_TOKEN');
    console.log('    值:  (下面引号内的一整串，不含引号)');
    console.log('==============================================================');
    console.log('"""');
    console.log(refresh.value);
    console.log('"""');
    console.log('\n存好后，GitHub Actions 会用它自动刷新并签到。');
  } else {
    console.error('\n[WARN] 刷新接口未返回成功。请确认登录账号有签到权限，并重新登录生成。');
    process.exit(1);
  }
} catch (err) {
  console.error('[ERROR]', err?.message || err);
  await browser.close().catch(() => {});
  process.exit(1);
}
