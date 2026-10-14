/**
 * checkin.js - 纯 API 令牌版每日签到（GitHub Actions 用，无浏览器）
 *
 * 凭据：HCNSEC_API_TOKEN（长期个人访问令牌，Bearer 鉴权，不绑 IP）
 * 原理：网关接口认 Bearer access_token，不认 session cookie。
 *       用长期令牌即可跨 IP 稳定签到，无需 Playwright / 刷新。
 *
 * 用法：
 *   GitHub Actions: 存 secret HCNSEC_API_TOKEN 后 node checkin.js
 *   本地测试:       export HCNSEC_API_TOKEN=*** node checkin.js
 */

const TOKEN = (process.env.HCNSEC_API_TOKEN || '').trim();
if (!TOKEN) {
  console.error('[FATAL] 缺少 HCNSEC_API_TOKEN');
  console.error('    请在面板创建个人令牌，并设为 GitHub Secret: HCNSEC_API_TOKEN');
  process.exit(1);
}

const BASE = 'https://api.hcnsec.cn';
const H = {
  Accept: 'application/json, text/plain, */*',
  Authorization: `Bearer ${TOKEN}`,
};

async function main() {
  console.log('[INFO] HCNSec daily check-in (API token mode)');

  // 1) 校验令牌
  const s = await fetch(`${BASE}/api/user/self`, { headers: H });
  const sj = await s.json().catch(() => ({}));
  if (s.status !== 200) {
    console.error(`[FAIL] 令牌校验失败: HTTP ${s.status} ${sj.message || sj.code || ''}`);
    process.exit(1);
  }
  console.log(`[1/2] 令牌有效: user=${sj.data?.username || sj.data?.display_name || 'unknown'}`);

  // 2) 签到
  const c = await fetch(`${BASE}/api/user/checkin`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const cj = await c.json().catch(async () => ({ raw: await c.text() }));

  if (cj.success === true) {
    const quota = cj.data?.quota_awarded;
    const date = cj.data?.checkin_date ? ` | 日期: ${cj.data.checkin_date}` : '';
    console.log(`[SUCCESS] 签到成功${date}${quota !== undefined ? ` | 获得额度: ${quota}` : ''}`);
    process.exit(0);
  }

  const msg = cj.message || '';
  if (msg && /今日已签到|已经签到|already/i.test(msg)) {
    console.log(`[INFO] 今日已签到: ${msg}`);
    process.exit(0);
  }

  console.error(`[FAIL] 签到失败: HTTP ${c.status} ${msg}`);
  process.exit(1);
}

main().catch(err => {
  console.error('[CRITICAL]', err?.stack || err);
  process.exit(1);
});
