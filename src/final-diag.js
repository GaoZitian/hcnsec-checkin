/**
 * final-diag.js - 决定性诊断：抓取站点前端自己发出的真实请求
 *
 * 不再假设。直接监听前端登录时和后续调用时，浏览器实际发出的
 * /api/user/login 响应体（含 access_token）和认证请求的 Authorization 头。
 * 前端用什么，什么就能用。
 */
import { chromium } from 'playwright';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

for (const p of ['.env.local', '.env', '../.env.local', '../.env']) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

const BASE = 'https://api.hcnsec.cn';
const USERNAME = process.env.HCNSEC_USERNAME;
const PASSWORD = process.env.HCNSEC_PASSWORD;
if (!USERNAME || !PASSWORD) { console.error('[FATAL] 缺少凭据'); process.exit(1); }

const rec = (s) => { console.log(s); };
const capture = { loginBody: null, loginStatus: null, authHeaders: {}, apiCalls: [] };

console.log('[INFO] 打开浏览器，请完成 Turnstile 验证并登录...');
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

// 关键：拦截所有 /api/user/ 请求，抓请求头 + 响应体
page.on('response', async (resp) => {
  const url = resp.url();
  if (!url.includes('/api/user/')) return;
  const method = resp.request().method();
  const req = resp.request();
  const auth = req.headers()['authorization'];
  const path = url.replace(BASE, '');
  try {
    const body = await resp.json().catch(() => null);
    if (url.includes('/api/user/login')) {
      capture.loginStatus = resp.status();
      capture.loginBody = body;
      rec(`[LOGIN] status=${resp.status()} keys=${body ? Object.keys(body.data || body) : 'null'}`);
      if (body) {
        for (const k of Object.keys(body.data || {})) {
          if (/token|key|secret/i.test(k)) rec(`  [LOGIN] data.${k} = ${(body.data[k]||'').toString().slice(0,40)}... (len=${(body.data[k]||'').toString().length})`);
        }
      }
    } else if (auth) {
      capture.authHeaders[path] = auth;
      rec(`[AUTH-REQ] ${method} ${path} Authorization=${auth.slice(0,30)}...`);
    }
    capture.apiCalls.push({ method, path, status: resp.status(), hasAuth: !!auth });
  } catch {}
});

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[name="username"]', USERNAME).catch(() => {});
  await page.fill('input[name="password"]', PASSWORD).catch(() => {});
  await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').forEach(b => { b.checked = true; b.click(); })).catch(() => {});

  rec('    请完成人机验证并登录（最多等 5 分钟）...');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 300000 });
  rec('    ✅ 登录成功');

  // 让前端自行发起后续 API 调用（进控制台）
  await page.goto(`${BASE}/console/token`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 现在用抓到的真实 Authorization 头测试 checkin
  const allAuths = Object.values(capture.authHeaders);
  const token = allAuths.length ? allAuths[0].replace(/^Bearer\s+/i, '').trim() : null;

  if (token) {
    rec(`\n[TEST] 用前端真实 token 测试 /checkin (len=${token.length})`);
    const r = await context.request.post(`${BASE}/api/user/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Authorization: `Bearer ${token}` },
      data: {}
    });
    rec(`[TEST] /checkin -> HTTP ${r.status()}: ${JSON.stringify(await r.json().catch(()=>({}))).slice(0,200)}`);
  } else {
    rec('\n[TEST] 未捕获到前端 Authorization 头');
  }

  rec('\n[SUMMARY] 捕获的 API 调用:');
  for (const c of capture.apiCalls) rec(`  ${c.method} ${c.path} -> ${c.status} (auth=${c.hasAuth})`);

  await browser.close();
} catch (err) {
  rec('[ERROR] ' + (err?.message || err));
  await browser.close().catch(() => {});
}
