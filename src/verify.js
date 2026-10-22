/**
 * verify.js - 定向诊断：跳过 /self，直接测 /checkin
 * 结果写入 checkin-result.json，避免输出截断
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
const REPORT = fs.existsSync('../checkin-result.json') ? '../checkin-result.json' : './checkin-result.json';

if (!USERNAME || !PASSWORD) { console.error('[FATAL] 缺少凭据'); process.exit(1); }

const log = [];
const rec = (s) => { log.push(s); console.log(s); };

rec('[INFO] 打开浏览器，请完成 Turnstile 验证并登录...');
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[name="username"]', USERNAME).catch(() => {});
  await page.fill('input[name="password"]', PASSWORD).catch(() => {});
  await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').forEach(b => { b.checked = true; b.click(); })).catch(() => {});

  rec('    请完成人机验证并登录（最多等 5 分钟）...');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 300000 });
  rec('    ✅ 登录成功，URL=' + page.url());
  await page.waitForTimeout(3000);

  // 抓页面里任何 token 痕迹
  const probe = await page.evaluate(async (base) => {
    const out = { ls: {}, ss: {}, cookies: document.cookie };
    try { out.ls = Object.fromEntries(Object.entries(localStorage)); } catch {}
    try { out.ss = Object.fromEntries(Object.entries(sessionStorage)); } catch {}
    return out;
  }, BASE);
  rec('[PROBE] localStorage keys: ' + Object.keys(probe.ls));
  rec('[PROBE] sessionStorage keys: ' + Object.keys(probe.ss));
  rec('[PROBE] document.cookie: ' + (probe.cookies || '(空)'));

  // 直接打 /checkin（不带任何手动 header，纯浏览器上下文）
  const chk = await page.evaluate(async (base) => {
    const variants = [
      { name: 'plain', init: { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' } },
    ];
    const res = [];
    for (const v of variants) {
      const r = await fetch(`${base}/api/user/checkin`, v.init).catch(e => ({ err: e.message }));
      const j = await (r.json ? r.json().catch(()=>({raw:'nonjson'})) : {err:r.err});
      res.push({ ...v, status: r.status, body: j });
    }
    return res;
  }, BASE);

  for (const c of chk) {
    rec(`[CHECKIN:${c.name}] HTTP ${c.status} -> ${JSON.stringify(c.body).slice(0,300)}`);
  }

  await browser.close();
  fs.writeFileSync(REPORT, JSON.stringify({ probe, checks: chk }, null, 2));
  rec('[DONE] 详细结果已写入 ' + REPORT);
} catch (err) {
  rec('[ERROR] ' + (err?.message || err));
  await browser.close().catch(() => {});
  process.exit(1);
}
