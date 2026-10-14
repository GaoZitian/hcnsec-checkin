/**
 * test-token.js - 用个人访问令牌(API Token)验证 /self 和 /checkin
 *
 * 用法：
 *   cd src
 *   export HCNSEC_API_TOKEN="*** 面板里创建的令牌值"
 *   node test-token.js
 *
 * 原理：网关接口认 Bearer access_token（长期 API 令牌），不认 session cookie。
 *       用长期令牌就不存在 IP 绑定/刷新失效问题。
 */
const TOKEN = (process.env.HCNSEC_API_TOKEN || '').trim();
if (!TOKEN) {
  console.error('[FATAL] 请先: export HCNSEC_API_TOKEN="***"');
  process.exit(1);
}

const BASE = 'https://api.hcnsec.cn';
const H = {
  Accept: 'application/json, text/plain, */*',
  Authorization: `Bearer ${TOKEN}`,
};

console.log('[INFO] 用 API 令牌验证中... (token len =', TOKEN.length + ')');

// 1) /self 读账户
const r1 = await fetch(`${BASE}/api/user/self`, { headers: H }).catch(e => ({ err: e.message }));
if (!r1.err) {
  const j = await r1.json().catch(() => ({}));
  console.log(`  [1] /self   -> HTTP ${r1.status} ${j.success === false ? j.message : (j.data?.username ? `user=${j.data.username} 余额=${j.data?.quota}` : '')}`);
} else console.log(`  [1] /self   -> 网络错误 ${r1.err}`);

// 2) /checkin 签到
const r2 = await fetch(`${BASE}/api/user/checkin`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
}).catch(e => ({ err: e.message }));
if (!r2.err) {
  const j = await r2.json().catch(() => ({}));
  const msg = j.message || (j.success ? 'OK' : '');
  console.log(`  [2] /checkin-> HTTP ${r2.status} ${msg}`);
  console.log(j.success ? '\n✅ 令牌有效且可签到！把 HCNSEC_API_TOKEN 存进 GitHub Secret 即可。' :
    (msg && /已签到|already/i.test(msg) ? '\n✅ 令牌有效（今日已签到）' : '\n❌ 令牌验证未通过，请确认令牌是否正确 / 该账号是否有签到权限'));
} else console.log(`  [2] /checkin-> 网络错误 ${r2.err}`);
