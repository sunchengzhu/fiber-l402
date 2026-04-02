/**
 * 复现 auto-pay 凭证未持久化问题
 *
 * 逐行模拟 PaymentGate.tsx 的两条路径，用真实 402 challenge 数据，
 * 对比 localStorage 在"取内容失败"时的状态差异。
 *
 * 不需要真实支付：问题不在支付环节，而在支付成功后的持久化时序。
 */

const BACKEND = 'http://localhost:3001';
const ARTICLE_ID = 'make-selfhost-great-again';

// ── 模拟 localStorage ──
class MockLocalStorage {
  constructor(name) { this.name = name; this.store = new Map(); }
  setItem(key, value) { this.store.set(key, value); }
  getItem(key) { return this.store.get(key) || null; }
  dump() {
    if (this.store.size === 0) {
      console.log(`    （空）`);
    } else {
      for (const [k, v] of this.store) {
        const display = v.length > 60 ? v.substring(0, 60) + '...' : v;
        console.log(`    ${k} = ${display}`);
      }
    }
  }
}

// ── 模拟 fetchContent（Path A）── 参照 PaymentGate.tsx L73-L91
async function fetchContent(localStorage, articleId, macaroon, preimage, backendUrl) {
  const response = await fetch(`${backendUrl}/api/articles/${articleId}/content`, {
    headers: { Authorization: `L402 ${macaroon}:${preimage}` },
  });
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  const article = await response.json();
  localStorage.setItem(`l402-content-${articleId}`, article.content);
  return article.content;
}

// ── 模拟 fetchContentWithPaidInvoice（Path B）── 参照 PaymentGate.tsx L93-L118
async function fetchContentWithPaidInvoice(localStorage, articleId, macaroon, paymentHash, backendUrl) {
  const response = await fetch(`${backendUrl}/api/articles/${articleId}/content`, {
    headers: {
      Authorization: `L402 ${macaroon}`,
      ...(paymentHash ? { 'X-L402-Payment-Hash': paymentHash } : {}),
    },
    signal: AbortSignal.timeout(2000),
  });
  if (response.status === 402 || response.status === 401) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || `Payment not settled yet (${response.status})`);
  }
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  const article = await response.json();
  localStorage.setItem(`l402-content-${articleId}`, article.content);
  return true;
}

// ═══════════════════════════════════════════════════
// Step 1: 获取真实的 402 challenge
// ═══════════════════════════════════════════════════
console.log('═══ 复现 auto-pay 凭证未持久化问题 ═══\n');
console.log('Step 1: 获取真实 402 challenge...');

const challengeRes = await fetch(`${BACKEND}/api/articles/${ARTICLE_ID}/content`);
if (challengeRes.status !== 402) {
  console.log(`  预期 402，实际 ${challengeRes.status}。`);
  console.log(`  （如果是 500，可能是 payee 节点不可达。不影响复现：用模拟数据。）\n`);
}

let macaroon, invoice;
if (challengeRes.status === 402) {
  const challenge = await challengeRes.json();
  macaroon = challenge.macaroon;
  invoice = challenge.invoice;
  console.log(`  ✅ macaroon: ${macaroon.substring(0, 40)}...`);
  console.log(`  ✅ invoice:  ${invoice.substring(0, 40)}...`);
} else {
  // payee 不可达时用模拟数据，不影响持久化逻辑的复现
  macaroon = 'SIMULATED_MACAROON_BASE64_DATA';
  invoice = 'fibt_simulated_invoice';
  console.log(`  ⚠️  用模拟数据（payee 不可达），不影响持久化逻辑复现`);
}

// 模拟支付成功后拿到的数据
const FAKE_PREIMAGE = 'a'.repeat(64);
const FAKE_PAYMENT_HASH = 'b'.repeat(64);

// ═══════════════════════════════════════════════════
// Step 2: 模拟手动路径 checkPayment()
//   参照 PaymentGate.tsx L148-L153
// ═══════════════════════════════════════════════════
console.log('\n────────────────────────────────────────');
console.log('场景 A：手动路径 checkPayment() + 取内容失败');
console.log('────────────────────────────────────────');

const storageManual = new MockLocalStorage('手动路径');

console.log('\n  // PaymentGate.tsx L150-L153');
console.log('  // 用户输入 preimage 后，先存凭证再取内容');
console.log('  localStorage.setItem(`l402-${articleId}`, JSON.stringify({macaroon, preimage}))');

// ← 这行在 fetchContent 之前执行
storageManual.setItem(`l402-${ARTICLE_ID}`, JSON.stringify({ macaroon, preimage: FAKE_PREIMAGE }));

console.log('\n  // 然后调用 fetchContent() — 模拟失败（后端重启/网络抖动）');
try {
  await fetchContent(storageManual, ARTICLE_ID, macaroon, FAKE_PREIMAGE, 'http://localhost:39999');
} catch (err) {
  console.log(`  ❌ fetchContent 失败: ${err.message}`);
}

console.log('\n  localStorage 状态:');
storageManual.dump();
console.log('\n  → 凭证已落盘。用户刷新页面时 checkCache() 可以读到凭证重新请求内容。');

// ═══════════════════════════════════════════════════
// Step 3: 模拟 auto-pay 路径 payWithConnectedNode()
//   参照 PaymentGate.tsx L157-L213
// ═══════════════════════════════════════════════════
console.log('\n────────────────────────────────────────');
console.log('场景 B：auto-pay payWithConnectedNode() + 取内容失败');
console.log('────────────────────────────────────────');

const storageAuto = new MockLocalStorage('auto-pay');

console.log('\n  // PaymentGate.tsx L168-L180');
console.log('  // 1. sendPayment() 成功 — 钱已转出');
console.log(`  //    payment_hash = ${FAKE_PAYMENT_HASH.substring(0, 20)}...`);
console.log('  //    status = Success');
console.log('  // 💸 此时 CKB 已经从 payer 节点转到 payee 节点');

console.log('\n  // PaymentGate.tsx L195-L201');
console.log('  // 2. fetchContentWithPaidInvoice() — 模拟失败');
console.log('  //    注意：在这之前，没有任何 localStorage.setItem 调用！');

// 模拟 10 次重试全部失败（PaymentGate.tsx L195-L201）
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await fetchContentWithPaidInvoice(
      storageAuto, ARTICLE_ID, macaroon, FAKE_PAYMENT_HASH,
      'http://localhost:39999' // 模拟后端不可达
    );
  } catch {
    console.log(`  重试 ${attempt + 1}/3: fetch 失败`);
  }
}

console.log('\n  // PaymentGate.tsx L203');
console.log('  // throw new Error("Payment submitted, but unlock confirmation timed out...")');

console.log('\n  localStorage 状态:');
storageAuto.dump();
console.log('\n  → localStorage 完全为空。钱付了，但凭证和内容都没有。');

// ═══════════════════════════════════════════════════
// Step 4: 模拟用户刷新页面 — checkCache()
//   参照 PaymentGate.tsx L49-L65
// ═══════════════════════════════════════════════════
console.log('\n────────────────────────────────────────');
console.log('用户刷新页面 → checkCache()');
console.log('────────────────────────────────────────');

console.log('\n  // PaymentGate.tsx L53-L58');
console.log('  // const contentCache = localStorage.getItem(`l402-content-${articleId}`);');
console.log('  // if (contentCache) { 直接显示 }');
console.log('  // else { const cached = localStorage.getItem(`l402-${articleId}`); }');

console.log('\n  手动路径刷新后:');
const manualContentCache = storageManual.getItem(`l402-content-${ARTICLE_ID}`);
const manualCredCache = storageManual.getItem(`l402-${ARTICLE_ID}`);
if (manualContentCache) {
  console.log(`    l402-content-* 有内容 → 直接显示`);
} else if (manualCredCache) {
  console.log(`    l402-content-* 为空，但 l402-* 有凭证`);
  console.log(`    → 用凭证重新 fetchContent() → 恢复成功 ✅`);
} else {
  console.log(`    什么都没有 → 显示 402`);
}

console.log('\n  auto-pay 路径刷新后:');
const autoContentCache = storageAuto.getItem(`l402-content-${ARTICLE_ID}`);
const autoCredCache = storageAuto.getItem(`l402-${ARTICLE_ID}`);
if (autoContentCache) {
  console.log(`    l402-content-* 有内容 → 直接显示`);
} else if (autoCredCache) {
  console.log(`    l402-content-* 为空，但 l402-* 有凭证 → 恢复`);
} else {
  console.log(`    l402-content-* = null`);
  console.log(`    l402-*         = null`);
  console.log(`    → 没有任何恢复手段 → 显示 402 → 用户必须重新付费 ❌`);
  console.log(`    → 之前付的 CKB 白花了 💸`);
}

// ═══════════════════════════════════════════════════
// Step 5: 逐行代码对比
// ═══════════════════════════════════════════════════
console.log('\n════════════════════════════════════════');
console.log('代码时序对比（PaymentGate.tsx）');
console.log('════════════════════════════════════════');

console.log(`
  手动路径 checkPayment() [L148-L153]:
  ┌────────────────────────────────────────────┐
  │ 1. localStorage.setItem('l402-*', cred)    │ ← 先存凭证
  │ 2. await fetchContent(macaroon, preimage)  │ ← 再取内容（可以失败）
  │    └─ 成功 → setItem('l402-content-*')     │
  └────────────────────────────────────────────┘
  crash window: 1→2 之间极短，而且凭证已存

  auto-pay payWithConnectedNode() [L157-L213]:
  ┌────────────────────────────────────────────┐
  │ 1. sendPayment(invoice)                    │ ← 钱花了
  │ 2. (等待确认 paymentSettled...)             │ ← 长达 30 秒
  │ 3. for 10 次 {                             │
  │      fetchContentWithPaidInvoice(macaroon) │ ← 还在重试
  │      └─ 成功 → setItem('l402-content-*')   │ ← 唯一写入点
  │    }                                       │
  └────────────────────────────────────────────┘
  crash window: 1→3.成功 之间可达数十秒，且无任何凭证写入

  在 auto-pay 中，macaroon 和 paymentHash 始终只在内存里。
  从 sendPayment 成功到 setItem('l402-content-*') 之间，
  如果发生以下任一情况，凭证就丢了：
    - 用户刷新页面
    - 浏览器标签被回收
    - fetchContentWithPaidInvoice 全部失败
    - 网络抖动 / 后端重启 / payee 查账超时
`);

// ═══════════════════════════════════════════════════
// Step 6: 与 about.astro 文案的矛盾
// ═══════════════════════════════════════════════════
console.log('════════════════════════════════════════');
console.log('文案矛盾 — about.astro L36-38');
console.log('════════════════════════════════════════');
console.log(`
  页面声称:
    "Your payment proof is cached locally, so you won't be
     charged again for the same article on the same browser."

  实际行为:
    - 手动路径: ✅ 先存 proof，再取内容 → 文案描述准确
    - auto-pay: ❌ 不存 proof，只存内容 → 一旦内容没拿到，proof 丢失
    - 用户理解: "本地会可靠缓存我的支付证明"
    - 实际情况: auto-pay 的 proof 从不写入 localStorage
`);
