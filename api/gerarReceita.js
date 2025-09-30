// /api/gerarReceita.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ingredientes, alternativa = false, tipoPrato = 'comida', quantidadePessoas = 1 } = req.body || {};

    if (!ingredientes) return res.status(400).json({ error: 'ingredientes is required' });

    const GROQ_KEY = process.env.GROQ_KEY;
    if (!GROQ_KEY) return res.status(500).json({ error: 'Server misconfiguration' });

    const prompt = `Gere uma receita usando: ${Array.isArray(ingredientes) ? ingredientes.join(', ') : ingredientes}.
Tipo: ${tipoPrato}. Alternativa: ${!!alternativa}. Para ${quantidadePessoas} pessoa(s).`;

    const apiRes = await fetch('https://api.groq.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
        'User-Agent': 'MeuChef-App/1.0'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'Você é um chef brasileiro experiente.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.5,
        top_p: 0.8,
        max_tokens: 1000,
        stream: false
      })
    });

    if (!apiRes.ok) {
      const txt = await apiRes.text();
      return res.status(502).json({ error: 'Upstream API error', details: txt });
    }

    const data = await apiRes.json();
    const content = data?.choices?.[0]?.message?.content ?? null;

    return res.status(200).json({ content, raw: data });
  } catch (err) {
    console.error('Erro na function gerarReceita:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
