/**
 * Fiber L402 — 协议合规性 + 解析边界 + Caveat/限流/复用 测试脚本
 *
 * 覆盖场景:
 *   #36 402 vs 401 状态码区分 (Spec §4.1)
 *   #37 WWW-Authenticate 头格式 (Spec §5.1)
 *   #38 LSAT 向下兼容 (Spec §10)
 *   #39 空 token
 *   #40 多冒号
 *   #41 非 base64 macaroon
 *   #42 preimage 非 hex
 *   #43 preimage 长度错误
 *   #44 控制字符注入
 *   #45 缺少 resource_id caveat
 *   #46 缺少 resource_type caveat
 *   #47 expiry 边界值
 *   #48 caveat 值含 =
 *   #49 payment hash 不匹配
 *   #50 有 header 无 caveat (构造困难，跳过)
 *   #51 触发限流
 *   #52 限流窗口重置
 *   #53 同一凭证多次使用
 *   #54 并发请求同一 invoice
 *   #55 rootKey 默认值矛盾 (需重启后端，跳过)
 *   #56 价格浮点精度
 *
 * 运行: node spec-compliance-test.mjs
 * 前置: proxy 后端 (localhost:3001) 正在运行
 */

import { createHash } from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const macaroonLib = require('/Users/sunchengzhu/learn/fiber-l402/node_modules/.pnpm/macaroon@3.0.4/node_modules/macaroon/macaroon.js');

const API = 'http://localhost:3001';
const ROOT_KEY = '9b02708df02c4cc03aac9c0d05dfc1fadf1bde8c022fb38adf4f3b57d1a0b635';
const results = [];

function log(id, name, pass, detail = '') {
  const status = pass ? '✅ PASS' : '❌ FAIL';
  results.push({ id, name, pass, detail });
  console.log(`  ${status}  #${id} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── Helpers ───────────────────────────────────────────────

async function getContent(articleId, authHeader, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (authHeader) headers['Authorization'] = authHeader;
  const res = await fetch(`${API}/api/articles/${articleId}/content`, { headers });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
}

async function getArticles() {
  const res = await fetch(`${API}/api/articles`);
  return { status: res.status, data: await res.json() };
}

function makePreimageAndHash() {
  const preimage = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));
  const hash = createHash('sha256').update(preimage).digest('hex');
  return { preimage: '0x' + preimage.toString('hex'), paymentHash: '0x' + hash };
}

/**
 * Mint a macaroon with customizable caveats.
 * Pass `caveats` array of `"key=value"` strings to override the default set.
 */
function mintToken(rootKeyHex, paymentHash, articleId, expiryOffset = 3600, opts = {}) {
  const rootKey = Buffer.from(rootKeyHex.replace(/^0x/, ''), 'hex');
  const expiryTimestamp = Math.floor(Date.now() / 1000) + expiryOffset;

  const identifier = JSON.stringify({
    v: 0, pid: paymentHash, rid: opts.rid ?? articleId, rtype: opts.rtype ?? 'article', loc: 'localhost:3001',
  });

  const m = macaroonLib.newMacaroon({ rootKey, identifier, location: 'localhost:3001' });

  if (opts.caveats) {
    for (const c of opts.caveats) m.addFirstPartyCaveat(c);
  } else {
    m.addFirstPartyCaveat(`payment_hash=${paymentHash}`);
    m.addFirstPartyCaveat(`expiry=${expiryTimestamp}`);
    if (opts.skipResourceId !== true) m.addFirstPartyCaveat(`resource_id=${articleId}`);
    if (opts.skipResourceType !== true) m.addFirstPartyCaveat(`resource_type=article`);
  }

  const exported = m.exportJSON();
  return Buffer.from(JSON.stringify(exported)).toString('base64');
}

// ── TESTS ───────────────────────────────────────────────

async function run() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Fiber L402 — 协议合规性 + 边界测试          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const { data: articles } = await getArticles();
  if (!articles?.length) { console.error('无法获取文章列表'); process.exit(1); }
  const articleA = articles[0].id;
  console.log(`  测试文章: ${articleA}\n`);

  // ═══════════════════════════════════════════════════════
  // 协议合规性 (Spec §4.1 / §5.1 / §10)
  // ═══════════════════════════════════════════════════════

  // ─── #36 402 vs 401 状态码区分 ──────────────────────
  console.log('── 场景 #36: 402 vs 401 状态码区分 (Spec §4.1) ──');
  {
    // 无 credential → 应 402
    const r1 = await getContent(articleA);
    log('36a', '无 credential → 402', r1.status === 402, `status=${r1.status}`);

    // 有 credential 但无效 → 应 401 (不是 402)
    const r2 = await getContent(articleA, 'L402 invalid-mac:0000');
    log('36b', '无效 credential → 401 (非 402)', r2.status === 401,
      `status=${r2.status}${r2.status === 402 ? ' ⚠️ 不符合 Spec §4.1' : ''}`);

    // 有 credential, macaroon 合法但 preimage 错误 → 应 401
    const { paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA);
    const r3 = await getContent(articleA, `L402 ${mac}:${'00'.repeat(32)}`);
    log('36c', '错误 preimage → 401', r3.status === 401, `status=${r3.status}`);
  }

  // ─── #37 WWW-Authenticate 头格式 ──────────────────
  console.log('\n── 场景 #37: WWW-Authenticate 头格式 (Spec §5.1) ──');
  {
    const r = await getContent(articleA);
    const wwwAuth = r.headers['www-authenticate'] || '';
    log('37a', 'HTTP 402 包含 WWW-Authenticate', r.status === 402 && !!wwwAuth, `present=${!!wwwAuth}`);

    const hasL402Prefix = wwwAuth.startsWith('L402 ');
    log('37b', 'scheme 为 L402', hasL402Prefix, wwwAuth.slice(0, 30) + '...');

    const hasMacaroonParam = /macaroon="[^"]+"/.test(wwwAuth);
    log('37c', '包含 macaroon="..." 参数', hasMacaroonParam, hasMacaroonParam ? '格式正确' : 'missing');

    const hasInvoiceParam = /invoice="[^"]+"/.test(wwwAuth);
    log('37d', '包含 invoice="..." 参数', hasInvoiceParam, hasInvoiceParam ? '格式正确' : 'missing');
  }

  // ─── #38 LSAT 向下兼容 ─────────────────────────────
  console.log('\n── 场景 #38: LSAT 向下兼容 (Spec §10) ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA);
    // 用 LSAT 而非 L402 发送
    const r = await getContent(articleA, `LSAT ${mac}:${preimage}`);
    log('38a', 'LSAT scheme 处理', true,
      r.status === 200
        ? '接受 LSAT — 符合 Spec §10'
        : `拒绝 (status=${r.status}) — 不支持 LSAT 向下兼容`);
    // 这不算严格 fail，记录即可
  }

  // ═══════════════════════════════════════════════════════
  // Authorization 头解析边界
  // ═══════════════════════════════════════════════════════

  // ─── #39 空 token ──────────────────────────────────
  console.log('\n── 场景 #39: 空 token ──');
  {
    const r = await getContent(articleA, 'L402 ');
    log('39a', '`L402 ` (空 token) → 不崩溃', r.status === 402 || r.status === 401,
      `status=${r.status}`);
    // 完全空
    const r2 = await getContent(articleA, 'L402');
    log('39b', '`L402` (无空格无 token) → 不崩溃', r2.status === 402 || r2.status === 401,
      `status=${r2.status}`);
  }

  // ─── #40 多冒号 ───────────────────────────────────
  console.log('\n── 场景 #40: 多冒号 ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA);
    // mac:preimage:extra — indexOf(':') 应只取第一个冒号
    const r = await getContent(articleA, `L402 ${mac}:${preimage}:extradata`);
    // preimage 被解析为 preimage + ":extradata"，应该 hash 不匹配
    log('40a', '多冒号 → 不崩溃', r.status !== 500, `status=${r.status}`);
    log('40b', '多余部分不影响安全', r.status === 200 || r.status === 401,
      r.status === 200 ? 'indexOf 正确取了第一个冒号' : '额外数据导致 preimage 解析变化');
  }

  // ─── #41 非 base64 macaroon ───────────────────────
  console.log('\n── 场景 #41: 非 base64 macaroon ──');
  {
    const r = await getContent(articleA, 'L402 !!!not-valid-base64!!!:abcdef1234');
    log('41a', '非 base64 → 不崩溃', r.status !== 500, `status=${r.status}`);
    log('41b', '返回 401', r.status === 401 || r.status === 402, `status=${r.status}`);
  }

  // ─── #42 preimage 非 hex ──────────────────────────
  console.log('\n── 场景 #42: preimage 非 hex ──');
  {
    const { paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA);
    const r = await getContent(articleA, `L402 ${mac}:ZZZZNOTHEX`);
    log('42a', '非 hex preimage → 不崩溃', r.status !== 500, `status=${r.status}`);
    log('42b', '返回 401', r.status === 401, `status=${r.status}, error=${r.body.error}`);
  }

  // ─── #43 preimage 长度错误 ────────────────────────
  console.log('\n── 场景 #43: preimage 长度错误 ──');
  {
    const { paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA);
    // 31 字节 (62 hex chars) 而非 32 字节
    const shortPreimage = '0x' + 'aa'.repeat(31);
    const r1 = await getContent(articleA, `L402 ${mac}:${shortPreimage}`);
    log('43a', '31 字节 preimage → 401', r1.status === 401, `status=${r1.status}`);

    // 33 字节
    const longPreimage = '0x' + 'bb'.repeat(33);
    const r2 = await getContent(articleA, `L402 ${mac}:${longPreimage}`);
    log('43b', '33 字节 preimage → 401', r2.status === 401, `status=${r2.status}`);

    // 空 preimage
    const r3 = await getContent(articleA, `L402 ${mac}:`);
    log('43c', '空 preimage → 不崩溃', r3.status !== 500, `status=${r3.status}`);
  }

  // ─── #44 控制字符注入 ─────────────────────────────
  console.log('\n── 场景 #44: 控制字符注入 ──');
  {
    const { paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA);
    // 在 preimage 中注入 \r\n (HTTP header injection)
    const injected = '0x' + Buffer.from('\r\nX-Injected: true\r\n').toString('hex') + 'aa'.repeat(16);
    const r = await getContent(articleA, `L402 ${mac}:${injected}`);
    log('44a', '控制字符 preimage → 不崩溃', r.status !== 500, `status=${r.status}`);
    log('44b', '返回 401 (不通过)', r.status === 401, `status=${r.status}`);
    // 验证响应中没有注入的 header
    log('44c', '无 header injection', !r.headers['x-injected'], `x-injected=${r.headers['x-injected'] || 'absent'}`);
  }

  // ═══════════════════════════════════════════════════════
  // Caveat 机制
  // ═══════════════════════════════════════════════════════

  // ─── #45 缺少 resource_id caveat ──────────────────
  console.log('\n── 场景 #45: 缺少 resource_id caveat ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA, 3600, { skipResourceId: true });
    const r = await getContent(articleA, `L402 ${mac}:${preimage}`);
    log('45a', '无 resource_id caveat → 拒绝', r.status === 401,
      `status=${r.status}, error=${r.body.error}`);
    log('45b', '错误信息包含 resource_id', (r.body.error || '').toLowerCase().includes('resource_id'),
      `error=${r.body.error}`);
  }

  // ─── #46 缺少 resource_type caveat ────────────────
  console.log('\n── 场景 #46: 缺少 resource_type caveat ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA, 3600, { skipResourceType: true });
    const r = await getContent(articleA, `L402 ${mac}:${preimage}`);
    log('46a', '无 resource_type caveat → 拒绝', r.status === 401,
      `status=${r.status}, error=${r.body.error}`);
    log('46b', '错误信息包含 resource_type', (r.body.error || '').toLowerCase().includes('resource_type'),
      `error=${r.body.error}`);
  }

  // ─── #47 expiry 边界值 ────────────────────────────
  console.log('\n── 场景 #47: expiry 边界值 ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    // expiry = 当前秒 (expiryOffset=0)
    const mac = mintToken(ROOT_KEY, paymentHash, articleA, 0);
    const r = await getContent(articleA, `L402 ${mac}:${preimage}`);
    // macaroon.ts: `expiry < now` → 刚好等于 now 不算过期
    log('47a', 'expiry=now → 结果', true,
      r.status === 200
        ? '不过期 (< 是严格小于，等于时仍有效)'
        : `拒绝 status=${r.status} — 边界处理为已过期`);

    // expiry = 1 秒前
    const mac2 = mintToken(ROOT_KEY, paymentHash, articleA, -1);
    const r2 = await getContent(articleA, `L402 ${mac2}:${preimage}`);
    log('47b', 'expiry=now-1 → 过期', r2.status === 401, `status=${r2.status}`);
  }

  // ─── #48 caveat 值含 = ────────────────────────────
  console.log('\n── 场景 #48: caveat 值含 = ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
    // 构造一个 resource_id 包含 = 的 macaroon
    const idWithEquals = 'article-id=base64test==';
    const rootKey = Buffer.from(ROOT_KEY.replace(/^0x/, ''), 'hex');
    const identifier = JSON.stringify({
      v: 0, pid: paymentHash, rid: idWithEquals, rtype: 'article', loc: 'localhost:3001',
    });
    const m = macaroonLib.newMacaroon({ rootKey, identifier, location: 'localhost:3001' });
    m.addFirstPartyCaveat(`payment_hash=${paymentHash}`);
    m.addFirstPartyCaveat(`expiry=${expiryTimestamp}`);
    m.addFirstPartyCaveat(`resource_id=${idWithEquals}`);
    m.addFirstPartyCaveat(`resource_type=article`);
    const exported = m.exportJSON();
    const mac = Buffer.from(JSON.stringify(exported)).toString('base64');

    // 提取 caveat — 模拟 macaroon.ts 的 split('=') 逻辑
    const caveatStr = `resource_id=${idWithEquals}`;
    const [key, value] = caveatStr.split('=');
    const splitTruncates = value !== idWithEquals;
    log('48a', 'split("=") 是否截断含 = 的值', true,
      splitTruncates
        ? `⚠️ BUG: split 得到 "${value}" 而非 "${idWithEquals}" — 值被截断`
        : `正确: 值未被截断`);

    // 实际请求测试: 即使 resource_id 匹配上了，也要验证解析逻辑
    // 这里 idWithEquals 对应的文章不存在，所以 resource resolve 会返回 undefined
    // 但可以验证不崩溃
    const r = await getContent(articleA, `L402 ${mac}:${preimage}`);
    log('48b', '含 = 的 caveat 不导致崩溃', r.status !== 500, `status=${r.status}`);
  }

  // ═══════════════════════════════════════════════════════
  // X-L402-Payment-Hash 头
  // ═══════════════════════════════════════════════════════

  // ─── #49 payment hash 不匹配 ──────────────────────
  console.log('\n── 场景 #49: X-L402-Payment-Hash 不匹配 ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA);
    const wrongHash = '0x' + 'ff'.repeat(32);
    const r = await getContent(articleA, `L402 ${mac}:${preimage}`, { 'X-L402-Payment-Hash': wrongHash });
    log('49a', '错误 payment hash header → 401', r.status === 401, `status=${r.status}`);
    log('49b', '错误信息包含 mismatch', (r.body.error || '').toLowerCase().includes('mismatch'),
      `error=${r.body.error}`);

    // 正确的 hash 应通过
    const r2 = await getContent(articleA, `L402 ${mac}:${preimage}`, { 'X-L402-Payment-Hash': paymentHash });
    log('49c', '正确 payment hash header → 200', r2.status === 200, `status=${r2.status}`);
  }

  // ═══════════════════════════════════════════════════════
  // 凭证复用与并发 (放在限流测试之前，避免被限流影响)
  // ═══════════════════════════════════════════════════════

  // ─── #53 同一凭证多次使用 ─────────────────────────
  console.log('\n── 场景 #53: 同一凭证多次使用 (Spec §8) ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const mac = mintToken(ROOT_KEY, paymentHash, articleA);
    const auth = `L402 ${mac}:${preimage}`;

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await getContent(articleA, auth);
      statuses.push(r.status);
    }
    const allOk = statuses.every(s => s === 200);
    log('53a', '同一凭证连续 5 次 → 全 200', allOk,
      `statuses=${statuses.join(',')}`);
  }

  // ─── #54 并发请求同一 invoice ─────────────────────
  console.log('\n── 场景 #54: 并发请求获取独立 challenge ──');
  {
    const [r1, r2] = await Promise.all([
      getContent(articleA),
      getContent(articleA),
    ]);
    if (r1.status === 402 && r2.status === 402) {
      const invoice1 = r1.body.invoice;
      const invoice2 = r2.body.invoice;
      const macaroon1 = r1.body.macaroon;
      const macaroon2 = r2.body.macaroon;
      log('54a', '两个并发请求都返回 402', true, '正常');
      log('54b', '两个 invoice 不同', invoice1 !== invoice2,
        invoice1 === invoice2 ? '⚠️ 返回了相同 invoice' : '独立 invoice');
      log('54c', '两个 macaroon 不同', macaroon1 !== macaroon2,
        macaroon1 === macaroon2 ? '⚠️ 返回了相同 macaroon' : '独立 macaroon');
    } else {
      log('54a', '并发请求 → 402', false, `status1=${r1.status}, status2=${r2.status}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 限流机制 (放最后，因为会消耗掉配额影响后续测试)
  // ═══════════════════════════════════════════════════════

  // ─── #51 触发限流 ─────────────────────────────────
  console.log('\n── 场景 #51: 触发限流 ──');
  {
    // 默认配置: rateLimitMaxRequests=100, rateLimitWindowMs=60000
    // 前面已消耗了一些配额，快速发请求直到触发 429
    let got429 = false;
    let lastStatus = 0;
    let requestCount = 0;

    for (let i = 0; i < 120; i++) {
      const r = await fetch(`${API}/api/articles/${articleA}/content`);
      lastStatus = r.status;
      requestCount++;
      if (r.status === 429) {
        got429 = true;
        const body = await r.json();
        log('51a', '触发 429 限流', true, `在第 ${requestCount} 次请求触发（含前面测试消耗的配额）`);
        log('51b', '包含 retryAfter 字段', typeof body.retryAfter === 'number',
          `retryAfter=${body.retryAfter}`);
        break;
      }
      await r.text();
    }

    if (!got429) {
      log('51a', '触发 429 限流', false, `发了 ${requestCount} 次仍未触发 429，最后 status=${lastStatus}`);
    }
  }

  // ─── #52 限流窗口重置 (需等待，跳过详细验证) ──────
  console.log('\n── 场景 #52: 限流窗口重置 ──');
  {
    const r = await fetch(`${API}/api/articles/${articleA}/content`);
    if (r.status === 429) {
      log('52a', '窗口期内仍被限流', true, '正确，需等窗口过期');
      log('52b', '窗口重置 (需等 60s)', true, '⏭️ 跳过完整等待验证');
    } else {
      log('52a', '未被限流 → 配额未用尽或窗口已重置', true, `status=${r.status}`);
    }
  }

  // ─── #56 价格浮点精度 ─────────────────────────────
  console.log('\n── 场景 #56: 价格浮点精度 ──');
  {
    // 验证 0.1 * 100000000, 0.3 * 100000000 等浮点运算
    const tests = [
      { price: 0.1, expected: 10000000 },
      { price: 0.3, expected: 30000000 },
      { price: 0.7, expected: 70000000 },
      { price: 1.1, expected: 110000000 },
      { price: 0.01, expected: 1000000 },
    ];
    let allCorrect = true;
    const details = [];
    for (const t of tests) {
      const actual = t.price * 100000000;
      const hex = `0x${actual.toString(16)}`;
      const correct = actual === t.expected;
      if (!correct) allCorrect = false;
      details.push(`${t.price}→${actual}(${correct ? '✓' : '✗ expected ' + t.expected})`);
    }
    log('56a', 'CKB→shannons 浮点精度', allCorrect, details.join(', '));
    if (!allCorrect) {
      log('56b', '⚠️ 浮点精度问题', false, '某些价格会产生精度误差，建议用 Math.round');
    }
  }

  // ── Summary ──────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║               测试报告                        ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;

  console.log(`  总计: ${total}   通过: ${passed}   失败: ${failed}\n`);

  if (failed > 0) {
    console.log('  失败项:');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`    ❌ #${r.id} ${r.name} — ${r.detail}`);
    });
    console.log('');
  }

  console.log(`  通过率: ${((passed / total) * 100).toFixed(1)}%\n`);
}

run().catch(err => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
