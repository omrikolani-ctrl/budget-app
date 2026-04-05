const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SYNC_SECRET   = process.env.SYNC_SECRET;

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-sync-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.headers['x-sync-secret'] !== SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    const result = await upstash('LRANGE', 'budget_pending', '0', '-1');
    const txns = (result.result || []).map(s => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);
    return res.status(200).json({ transactions: txns });
  }

  if (req.method === 'DELETE') {
    await upstash('DEL', 'budget_pending');
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
