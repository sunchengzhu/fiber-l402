/**
 * Fiber L402 — P0 验收测试脚本
 *
 * 覆盖场景:
 *   #1 未付费访问文章
 *   #2 获取 invoice
 *   #3 手动支付解锁 (Path A: macaroon + preimage)
 *   #4 付费后凭证可重复使用
 *   #5 跨文章隔离
 *   #6 免费信息泄露检查
 *   #7 跨资源重放攻击
 *
 * 运行: node p0-test.mjs
 * 前置: proxy 后端 (localhost:3001) 正在运行
 */

import { createHash } from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const macaroonLib = require('/Users/sunchengzhu/learn/fiber-l402/node_modules/.pnpm/macaroon@3.0.4/node_modules/macaroon/macaroon.js');

const API = 'http://localhost:3001';
const results = [];

function log(id, name, pass, detail = '') {
  const status = pass ? '✅ PASS' : '❌ FAIL';
  results.push({ id, name, pass, detail });
  console.log(`  ${status}  #${id} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── Helpers ───────────────────────────────────────────────

async function getArticles() {
  const res = await fetch(`${API}/api/articles`);
  return { status: res.status, data: await res.json() };
}

async function getContent(articleId, authHeader) {
  const headers = {};
  if (authHeader) headers['Authorization'] = authHeader;
  const res = await fetch(`${API}/api/articles/${articleId}/content`, { headers });
  const body = await res.json();
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
}

/**
 * 使用 rootKey 本地铸造一个合法的 macaroon + preimage 对。
 * 这样可以在不实际支付的情况下测试 Path A 验证逻辑。
 */
async function mintTestToken(rootKeyHex, paymentHash, articleId) {
  const rootKey = Buffer.from(rootKeyHex.replace(/^0x/, ''), 'hex');
  const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;

  const identifier = JSON.stringify({
    v: 0,
    pid: paymentHash,
    rid: articleId,
    rtype: 'article',
    loc: 'localhost:3001',
  });

  const m = macaroonLib.newMacaroon({
    rootKey,
    identifier,
    location: 'localhost:3001',
  });

  m.addFirstPartyCaveat(`payment_hash=${paymentHash}`);
  m.addFirstPartyCaveat(`expiry=${expiryTimestamp}`);
  m.addFirstPartyCaveat(`resource_id=${articleId}`);
  m.addFirstPartyCaveat(`resource_type=article`);

  const exported = m.exportJSON();
  return Buffer.from(JSON.stringify(exported)).toString('base64');
}

function makePreimageAndHash() {
  // 生成随机 preimage
  const preimage = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));
  const hash = createHash('sha256').update(preimage).digest('hex');
  return {
    preimage: '0x' + preimage.toString('hex'),
    paymentHash: '0x' + hash,
  };
}

async function mintExpiredToken(rootKeyHex, paymentHash, articleId) {
  const rootKey = Buffer.from(rootKeyHex.replace(/^0x/, ''), 'hex');
  const expiredTimestamp = Math.floor(Date.now() / 1000) - 100; // 已过期

  const identifier = JSON.stringify({
    v: 0,
    pid: paymentHash,
    rid: articleId,
    rtype: 'article',
    loc: 'localhost:3001',
  });

  const m = macaroonLib.newMacaroon({
    rootKey,
    identifier,
    location: 'localhost:3001',
  });

  m.addFirstPartyCaveat(`payment_hash=${paymentHash}`);
  m.addFirstPartyCaveat(`expiry=${expiredTimestamp}`);
  m.addFirstPartyCaveat(`resource_id=${articleId}`);
  m.addFirstPartyCaveat(`resource_type=article`);

  const exported = m.exportJSON();
  return Buffer.from(JSON.stringify(exported)).toString('base64');
}

// ── ROOT KEY ────────────────────────────────────────────
// 从 .env 读取（和后端用同一个 key 才能验证通过）
const ROOT_KEY = '9b02708df02c4cc03aac9c0d05dfc1fadf1bde8c022fb38adf4f3b57d1a0b635';

// ── TESTS ───────────────────────────────────────────────

async function run() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Fiber L402 — P0 验收测试                ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // 先获取文章列表，选两篇来测试
  const { status: listStatus, data: articles } = await getArticles();
  if (listStatus !== 200 || !articles.length) {
    console.error('无法获取文章列表，后端是否在运行？');
    process.exit(1);
  }
  const articleA = articles[0].id;
  const articleB = articles[1]?.id || articles[0].id;
  console.log(`  测试文章 A: ${articleA}`);
  console.log(`  测试文章 B: ${articleB}\n`);

  // ─── #1 未付费访问文章 ───────────────────────────────
  console.log('── 场景 #1: 未付费访问文章 ──');
  {
    const { status, data } = await getArticles();
    const art = data.find(a => a.id === articleA);
    const hasPreview = art && art.preview && art.preview.length > 0;
    const noContent = !art.content;
    const hasPrice = typeof art.price === 'number' && art.price > 0;
    log('1a', '文章列表返回 200', status === 200, `status=${status}`);
    log('1b', '包含预览文字', hasPreview, `preview length=${art?.preview?.length || 0}`);
    log('1c', '不含全文 content 字段', noContent, noContent ? '未泄露' : `content length=${art?.content?.length}`);
    log('1d', '包含价格信息', hasPrice, `price=${art?.price}`);
  }

  // ─── #2 获取 invoice ────────────────────────────────
  console.log('\n── 场景 #2: 获取 invoice (402 challenge) ──');
  {
    const { status, body, headers } = await getContent(articleA);
    const hasMacaroon = !!body.macaroon;
    const hasInvoice = !!body.invoice && body.invoice.startsWith('fibt');
    const hasWwwAuth = !!headers['www-authenticate'];
    log('2a', '返回 402 状态码', status === 402, `status=${status}`);
    log('2b', '包含 macaroon', hasMacaroon, hasMacaroon ? `length=${body.macaroon.length}` : 'missing');
    log('2c', '包含 invoice (fibt 开头)', hasInvoice, hasInvoice ? body.invoice.slice(0, 30) + '...' : 'missing or wrong prefix');
    log('2d', 'WWW-Authenticate header', hasWwwAuth, hasWwwAuth ? 'present' : 'missing');
  }

  // ─── #3 手动支付解锁 (Path A) ──────────────────────
  console.log('\n── 场景 #3: 手动支付解锁 (Path A: macaroon + preimage) ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const macaroon = await mintTestToken(ROOT_KEY, paymentHash, articleA);
    const { status, body } = await getContent(articleA, `L402 ${macaroon}:${preimage}`);
    const hasContent = !!body.content && body.content.length > 100;
    log('3a', '合法 token 返回 200', status === 200, `status=${status}`);
    log('3b', '返回全文内容', hasContent, hasContent ? `content length=${body.content.length}` : 'no content');
  }

  // ─── #4 付费后凭证可重复使用 ───────────────────────
  console.log('\n── 场景 #4: 同一凭证重复使用 ──');
  {
    const { preimage, paymentHash } = makePreimageAndHash();
    const macaroon = await mintTestToken(ROOT_KEY, paymentHash, articleA);
    const auth = `L402 ${macaroon}:${preimage}`;
    const r1 = await getContent(articleA, auth);
    const r2 = await getContent(articleA, auth);
    log('4a', '第一次请求 200', r1.status === 200, `status=${r1.status}`);
    log('4b', '第二次请求 200 (凭证可复用)', r2.status === 200, `status=${r2.status}`);
    log('4c', '两次返回相同内容', r1.body.content === r2.body.content, r1.body.content === r2.body.content ? '内容一致' : '内容不一致');
  }

  // ─── #5 跨文章隔离 ──────────────────────────────────
  console.log('\n── 场景 #5: 跨文章隔离 ──');
  if (articleA !== articleB) {
    const { preimage, paymentHash } = makePreimageAndHash();
    const macaroonA = await mintTestToken(ROOT_KEY, paymentHash, articleA);
    // 用文章 A 的 token 访问文章 A — 应该通过
    const rA = await getContent(articleA, `L402 ${macaroonA}:${preimage}`);
    // 用文章 A 的 token 访问文章 B — 应该被拒绝
    const rB = await getContent(articleB, `L402 ${macaroonA}:${preimage}`);
    log('5a', '文章 A 的 token 访问 A → 200', rA.status === 200, `status=${rA.status}`);
    log('5b', '文章 A 的 token 访问 B → 拒绝', rB.status === 401 || rB.status === 402, `status=${rB.status}, error=${rB.body.error}`);
  } else {
    log('5a', '跳过 — 只有一篇文章', false, '需要至少两篇文章');
  }

  // ─── #6 免费信息泄露检查 ────────────────────────────
  console.log('\n── 场景 #6: 免费信息泄露检查 ──');
  {
    const { status, body } = await getContent(articleA);
    const noContentField = !body.content;
    const bodyStr = JSON.stringify(body);
    // 检查 response 中是否包含文章的实际内容关键词
    const noLeakedContent = !bodyStr.includes('# ') || bodyStr.length < 2000;
    log('6a', '无 Authorization 返回 402', status === 402, `status=${status}`);
    log('6b', 'response body 不含 content 字段', noContentField, noContentField ? '未泄露' : `泄露了 ${body.content?.length} 字符`);
    log('6c', 'response body 体积合理 (< 2KB)', bodyStr.length < 2000, `body size=${bodyStr.length}`);
  }

  // ─── #7 跨资源重放攻击 ──────────────────────────────
  console.log('\n── 场景 #7: 跨资源重放攻击 ──');
  if (articleA !== articleB) {
    // 7a: resource_id 不匹配
    const { preimage, paymentHash } = makePreimageAndHash();
    const macaroonA = await mintTestToken(ROOT_KEY, paymentHash, articleA);
    const r7a = await getContent(articleB, `L402 ${macaroonA}:${preimage}`);
    log('7a', 'resource_id 不匹配 → 拒绝', r7a.status !== 200, `status=${r7a.status}, error=${r7a.body.error}`);

    // 7b: 篡改 macaroon (修改 base64 内容)
    const tampered = macaroonA.slice(0, -10) + 'AAAAAAAAAA';
    const r7b = await getContent(articleA, `L402 ${tampered}:${preimage}`);
    log('7b', '篡改 macaroon → 拒绝', r7b.status !== 200, `status=${r7b.status}, error=${r7b.body.error}`);

    // 7c: 错误的 preimage
    const wrongPreimage = '0x' + '00'.repeat(32);
    const r7c = await getContent(articleA, `L402 ${macaroonA}:${wrongPreimage}`);
    log('7c', '错误 preimage → 拒绝', r7c.status !== 200, `status=${r7c.status}, error=${r7c.body.error}`);

    // 7d: 过期 macaroon
    const expiredMacaroon = await mintExpiredToken(ROOT_KEY, paymentHash, articleA);
    const r7d = await getContent(articleA, `L402 ${expiredMacaroon}:${preimage}`);
    log('7d', '过期 macaroon → 拒绝', r7d.status !== 200, `status=${r7d.status}, error=${r7d.body.error}`);
  } else {
    log('7a', '跳过 — 只有一篇文章', false, '需要至少两篇文章');
  }

  // ── Summary ──────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║               测试报告                    ║');
  console.log('╚══════════════════════════════════════════╝\n');

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
