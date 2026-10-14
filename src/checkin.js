/**
 * checkin.js - 纯 HTTP 版每日签到（GitHub Actions 用，无浏览器）
 *
 * 原理：
 *   不再依赖跨 IP 会失效的 cookie/storageState。
 *   改用一次性生成的「刷新令牌」(new_api_refresh，JWT 性质、不绑 IP)，
 *   每次运行时用它刷新出最新 access_token 再签到。
 *
 * 环境变量：
 *   HCNSEC_REFRESH_TOKEN - 必填，gen-token.js 生成并验证过的 new_api_refresh 值
 *
 * 用法：
 *   - GitHub Actions：设置 secret HCNSEC_REFRESH_TOKEN 后直接 node checkin.js
 *   - 本地测试：export HCNSEC_REFRESH_TOKEN=... node checkin.js
 */

const HOST = 'api.hcnsec.cn';
const BASE = `https://${HOST}`;
const REFRESH_URL = `${BASE}/api/user/auth/refresh`;
const SELF_URL = `${BASE}/api/user/self`;
const CHECKIN_URL = `${BASE}/api/user/checkin`;

const REFRESH_TOKEN = (process.env.HCNSEC_REFRESH_TOKEN || '').trim();

if (!REFRESH_TOKEN) {
  console.error('[FATAL] 缺少 HCNSEC_REFRESH_TOKEN 环境变量');
  console.error('    请先在本地运行: node gen-token.js');
  console.error('    将生成的刷新令牌值存入 GitHub Secret: HCNSEC_REFRESH_TOKEN');
  process.exit(1);
}

function extractToken(body) {
  if (!body) return '';
  const d = body.data || {};
  return d.token || d.access_token || d.accessToken || body.token || body.access_token || '';
}

async function main() {
  console.log('[INFO] HCNSec daily check-in starting (pure HTTP mode)...');

  // [1/3] 用刷新令牌换最新 access_token
  console.log('[1/3] 刷新 access_token...');
  let rResp = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Cookie: `new_api_refresh=${REFRESH_TOKEN}`,
    },
  });
  let rData = {};
  try { rData = await rResp.json(); } catch { rData = { raw: await rResp.text() }; }

  if (rResp.status() !== 200 || rData.success !== true) {
    console.error(`    ❌ 刷新失败: HTTP ${rResp.status()} ${rData.message || rData.code || ''}`);
    console.error('    刷新令牌已失效，请重新运行 gen-token.js 生成并更新 HCNSEC_REFRESH_TOKEN');
    process.exit(1);
  }

  const accessToken = extractToken(rData);
  if (!accessToken) {
    console.error('    ❌ 刷新响应中没有 access_token:', JSON.stringify(rData).slice(0, 300));
    process.exit(1);
  }
  console.log(`    ✅ 获得 access_token (长度 ${accessToken.length})`);

  const auth = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json, text/plain, */*',
  };

  // [2/3] 校验登录
  console.log('[2/3] 验证登录状态 (/self)...');
  const sResp = await fetch(SELF_URL, { headers: auth });
  const sData = await sResp.json().catch(() => ({}));
  if (sResp.status() !== 200) {
    console.error(`    ❌ 登录验证失败: HTTP ${sResp.status()} ${sData.message || sData.code || ''}`);
    process.exit(1);
  }
  console.log(`    ✅ 登录有效 (username=${sData.data?.username || sData.data?.display_name || 'unknown'})`);

  // [3/3] 签到
  console.log('[3/3] 执行签到...');
  const cResp = await fetch(CHECKIN_URL, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const cData = await cResp.json().catch(async () => ({ raw: await cResp.text() }));

  if (cData.success === true) {
    const extra = cData.data?.quota_awarded !== undefined ? ` 获得额度: ${cData.data.quota_awarded}` : '';
    const date = cData.data?.checkin_date ? ` 日期: ${cData.data.checkin_date}` : '';
    console.log(`[SUCCESS] 签到成功${date}${extra}`);
    process.exit(0);
  }

  const msg = cData.message || '';
  if (/今日已签到|已经签到|already/i.test(msg)) {
    console.log(`[INFO] 今日已签到: ${msg}`);
    process.exit(0);
  }

  console.error(`[FAIL] 签到失败: HTTP ${cResp.status()} ${msg}`);
  process.exit(1);
}

main().catch(err => {
  console.error('[CRITICAL]', err?.stack || err);
  process.exit(1);
});
