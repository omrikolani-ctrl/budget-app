const crypto = require('crypto');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ACCESS_TOKEN   = process.env.LINE_ACCESS_TOKEN;
const UPSTASH_URL    = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;

// ── Upstash Redis (REST) ───────────────────────────────────────────────────
async function upstash(...args) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  return r.json();
}

// ── LINE signature verification ────────────────────────────────────────────
function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac('SHA256', CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

// ── Thai bank message parser ───────────────────────────────────────────────
function parseThaiBank(text) {
  const t = text.replace(/\r/g, '').trim();

  // Amount: 1,234.56 บาท / THB / ฿
  const amountRe = /([\d,]+\.?\d*)\s*(บาท|THB|฿)/i;
  const amtMatch = t.match(amountRe);
  if (!amtMatch) return null;

  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));
  if (!amount || amount <= 0) return null;

  // Type detection
  const incomeKw  = ['รับ','เข้า','โอนเข้า','รับโอน','ฝาก','รับเงิน','credit','Credit','ได้รับ'];
  const expenseKw = ['จ่าย','ออก','โอนออก','ถอน','ชำระ','debit','Debit','ซื้อ','purchase','โอนเงิน','จากบัญชี'];

  let type = null;
  for (const kw of incomeKw)  { if (t.includes(kw)) { type = 'income';  break; } }
  if (!type)
    for (const kw of expenseKw) { if (t.includes(kw)) { type = 'expense'; break; } }
  if (!type) return null;

  // Description
  let description = type === 'income' ? 'Bank Transfer In' : 'Bank Payment';
  const fromMatch = t.match(/จาก\s+([^\n,]+)/);
  const toMatch   = t.match(/(?:ไปยัง|ถึง|ไปที่)\s+([^\n,]+)/);
  const shopMatch = t.match(/ร้าน\s*([^\n,]+)/);
  if (fromMatch) description = `จาก ${fromMatch[1].trim()}`;
  if (toMatch)   description = `ถึง ${toMatch[1].trim()}`;
  if (shopMatch) description = shopMatch[1].trim();

  // Category guess
  let category = type === 'income' ? 'Other' : 'Other';
  if (type === 'expense') {
    if (/อาหาร|food|coffee|กาแฟ|ร้านอาหาร|eatery|pizza|burger|sushi/i.test(t)) category = 'Food';
    else if (/grab|bolt|แท็กซี่|รถ|bts|mrt|taxi|uber|fuel|น้ำมัน/i.test(t))     category = 'Transport';
    else if (/ค่าไฟ|ค่าน้ำ|ค่าเน็ต|dtac|ais|true|internet|ค่าโทร|phone/i.test(t)) category = 'Bills';
    else if (/mall|shop|สยาม|lotus|bigc|โลตัส|เซ็นทรัล|central|lazada|shopee/i.test(t)) category = 'Shopping';
    else if (/โรงพยาบาล|hospital|clinic|pharmacy|ยา|หมอ|doctor/i.test(t))           category = 'Health';
    else if (/cinema|netflix|spotify|เกม|game|concert/i.test(t))                     category = 'Entertainment';
  } else {
    if (/เงินเดือน|salary|payroll/i.test(t)) category = 'Salary';
    else if (/freelance|งานพิเศษ|project/i.test(t)) category = 'Freelance';
  }

  return {
    id: crypto.randomUUID(),
    type,
    amount,
    category,
    description,
    date: new Date().toISOString().slice(0, 10),
    source: 'line-bot'
  };
}

// ── Reply to LINE ──────────────────────────────────────────────────────────
async function reply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
}

// ── Raw body reader (needed for signature check) ───────────────────────────
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

  if (!verifySignature(rawBody, sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  for (const event of bodyJson.events || []) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text;
    const tx   = parseThaiBank(text);

    if (tx) {
      await upstash('RPUSH', 'budget_pending', JSON.stringify(tx));
      const sign = tx.type === 'income' ? '+' : '−';
      await reply(event.replyToken,
        `✅ Added to budget!\n\n` +
        `${tx.type === 'income' ? '📈 Income' : '📉 Expense'}\n` +
        `💰 ${sign}฿${tx.amount.toLocaleString()}\n` +
        `📂 ${tx.category}\n` +
        `📝 ${tx.description}`
      );
    } else {
      const cmd = text.toLowerCase().trim();
      if (cmd === 'help' || cmd === 'ช่วยเหลือ') {
        await reply(event.replyToken,
          '💰 Budget Bot\n\n' +
          'Forward your bank notifications and I\'ll add them to your budget automatically!\n\n' +
          'Commands:\n• help — this message'
        );
      } else {
        await reply(event.replyToken,
          '🤔 Could not read this as a bank notification.\n\n' +
          'Try forwarding the message directly from your bank\'s LINE OA, or type "help".'
        );
      }
    }
  }

  res.status(200).json({ ok: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
