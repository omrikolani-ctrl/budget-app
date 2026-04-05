const crypto = require('crypto');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ACCESS_TOKEN   = process.env.LINE_ACCESS_TOKEN;
const UPSTASH_URL    = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;

// ── Upstash Redis ──────────────────────────────────────────────────────────
async function upstash(...args) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  return r.json();
}

// ── LINE signature verification ────────────────────────────────────────────
function verifySignature(rawBody, signature) {
  const hash = crypto.createHmac('SHA256', CHANNEL_SECRET).update(rawBody).digest('base64');
  return hash === signature;
}

// ── Category map ───────────────────────────────────────────────────────────
const CAT_ALIASES = {
  food:          'Food',    lunch: 'Food',   dinner: 'Food', breakfast: 'Food',
  coffee: 'Food', eat: 'Food', อาหาร: 'Food', กาแฟ: 'Food',
  transport:     'Transport', grab: 'Transport', taxi: 'Transport', bts: 'Transport',
  mrt: 'Transport', uber: 'Transport', fuel: 'Transport', gas: 'Transport', รถ: 'Transport',
  bills:         'Bills',   bill: 'Bills',  electric: 'Bills', water: 'Bills',
  internet: 'Bills', phone: 'Bills', ค่าไฟ: 'Bills', ค่าน้ำ: 'Bills',
  shopping:      'Shopping', shop: 'Shopping', mall: 'Shopping', lazada: 'Shopping',
  shopee: 'Shopping', เสื้อผ้า: 'Shopping',
  health:        'Health',  hospital: 'Health', clinic: 'Health', doctor: 'Health',
  pharmacy: 'Health', ยา: 'Health', หมอ: 'Health',
  entertainment: 'Entertainment', movie: 'Entertainment', cinema: 'Entertainment',
  netflix: 'Entertainment', spotify: 'Entertainment', game: 'Entertainment',
  salary:        'Salary',  เงินเดือน: 'Salary', payroll: 'Salary',
  freelance:     'Freelance', project: 'Freelance',
  other:         'Other',   อื่นๆ: 'Other'
};

function guessCategory(text, type) {
  const lower = text.toLowerCase();
  for (const [alias, cat] of Object.entries(CAT_ALIASES)) {
    if (lower.includes(alias)) return cat;
  }
  return type === 'income' ? 'Other' : 'Other';
}

// ── Manual command parser: "-500 food lunch at mall" / "+30000 salary" ─────
function parseManual(text) {
  const t = text.trim();
  // Must start with + or - followed by a number
  const match = t.match(/^([+\-])\s*([\d,]+\.?\d*)\s*(.*)?$/);
  if (!match) return null;

  const sign   = match[1];
  const amount = parseFloat(match[2].replace(/,/g, ''));
  const rest   = (match[3] || '').trim();
  if (!amount || amount <= 0) return null;

  const type = sign === '+' ? 'income' : 'expense';

  // First word of rest = possible category, remainder = description
  const words = rest.split(/\s+/).filter(Boolean);
  let category    = guessCategory(rest, type);
  let description = rest || (type === 'income' ? 'Income' : 'Expense');

  return {
    id: crypto.randomUUID(),
    type, amount, category, description,
    date: new Date().toISOString().slice(0, 10),
    source: 'line-bot'
  };
}

// ── Thai bank message parser ───────────────────────────────────────────────
function parseThaiBank(text) {
  const t = text.replace(/\r/g, '').trim();

  // Amount with บาท / THB / ฿
  const amtMatch = t.match(/([\d,]+\.?\d*)\s*(บาท|THB|฿)/i);
  if (!amtMatch) return null;

  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));
  if (!amount || amount <= 0) return null;

  const incomeKw  = ['รับ','เข้า','โอนเข้า','รับโอน','ฝาก','รับเงิน','credit','ได้รับ','เงินเข้า'];
  const expenseKw = ['จ่าย','ออก','โอนออก','ถอน','ชำระ','debit','ซื้อ','purchase','โอนเงิน','จากบัญชี','เงินออก'];

  let type = null;
  for (const kw of incomeKw)  { if (t.includes(kw)) { type = 'income';  break; } }
  if (!type)
    for (const kw of expenseKw) { if (t.includes(kw)) { type = 'expense'; break; } }
  if (!type) return null;

  let description = type === 'income' ? 'Bank Transfer In' : 'Bank Payment';
  const fromMatch = t.match(/จาก\s*:?\s*([^\n,]+)/);
  const toMatch   = t.match(/(?:ไปยัง|ถึง|ไปที่|ที่)\s*:?\s*([^\n,]+)/);
  const shopMatch = t.match(/ร้าน\s*([^\n,]+)/);
  if (shopMatch) description = shopMatch[1].trim();
  else if (toMatch) description = `ถึง ${toMatch[1].trim()}`;
  else if (fromMatch) description = `จาก ${fromMatch[1].trim()}`;

  const category = guessCategory(t, type);

  return {
    id: crypto.randomUUID(),
    type, amount, category, description,
    date: new Date().toISOString().slice(0, 10),
    source: 'line-bot'
  };
}

// ── Reply ──────────────────────────────────────────────────────────────────
async function reply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
}

const HELP_MSG =
`💰 Budget Bot – Commands:

➕ Add expense:
-500 food lunch
-1200 transport grab
-800 bills electric

➕ Add income:
+30000 salary
+5000 freelance project

Categories:
food, transport, bills, shopping, health, entertainment, salary, freelance, other

Or forward any bank notification and I'll parse it automatically!`;

// ── Raw body ───────────────────────────────────────────────────────────────
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── Handler ────────────────────────────────────────────────────────────────
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody  = await readRawBody(req);
  const bodyJson = JSON.parse(rawBody);
  const sig      = req.headers['x-line-signature'];

  if (!verifySignature(rawBody, sig)) return res.status(401).json({ error: 'Invalid signature' });

  for (const event of bodyJson.events || []) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text.trim();
    const cmd  = text.toLowerCase();

    if (cmd === 'help' || cmd === 'ช่วยเหลือ' || cmd === 'h') {
      await reply(event.replyToken, HELP_MSG);
      continue;
    }

    // Try manual command first (+/- prefix), then bank message
    const tx = parseManual(text) || parseThaiBank(text);

    if (tx) {
      await upstash('RPUSH', 'budget_pending', JSON.stringify(tx));
      const sign = tx.type === 'income' ? '+' : '−';
      const fmt  = n => n.toLocaleString('th-TH');
      await reply(event.replyToken,
        `✅ Added!\n\n` +
        `${tx.type === 'income' ? '📈' : '📉'} ${tx.type === 'income' ? 'Income' : 'Expense'}\n` +
        `💰 ${sign}฿${fmt(tx.amount)}\n` +
        `📂 ${tx.category}\n` +
        `📝 ${tx.description}\n\n` +
        `Open your budget app and tap 🤖 Sync to see it.`
      );
    } else {
      await reply(event.replyToken,
        `🤔 Didn't understand that.\n\nTry:\n-500 food lunch\n+30000 salary\n\nOr type "help" for all commands.`
      );
    }
  }

  res.status(200).json({ ok: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
