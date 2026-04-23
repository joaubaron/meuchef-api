// /api/gerarReceita.js
export default async function handler(req, res) {
  // Adicionar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ingredientes, alternativa = false, tipoPrato = 'comida', quantidadePessoas = 1 } = req.body || {};

    if (!ingredientes) return res.status(400).json({ error: 'ingredientes is required' });

    const GROQ_KEY = process.env.GROQ_KEY;
    if (!GROQ_KEY) return res.status(500).json({ error: 'Server misconfiguration' });

    // PROMPT CORRETO - específico para o formato que o frontend espera
    const prompt = `Você é um chef brasileiro. Gere uma receita em formato JSON válido, sem texto adicional, markdown ou HTML.

O JSON DEVE ter EXATAMENTE estes campos:
{
  "titulo": "Nome da Receita",
  "ingredientes": "- ingrediente 1\\n- ingrediente 2",
  "modoDePreparo": "1. Primeiro passo\\n2. Segundo passo\\n3. Terceiro passo",
  "tempoDePreparo": "30 minutos",
  "rendimento": "${quantidadePessoas} porções",
  "dicasDoChef": "- Dica 1\\n- Dica 2",
  "acompanhamento": "- Acompanhamento 1\\n- Acompanhamento 2",
  "guarnicao": "- Guarnição 1\\n- Guarnição 2",
  "categoria": "${tipoPrato === 'drink' ? 'drink' : 'doce'}"
}

REGRAS:
- Use unidades brasileiras (xícaras, colheres, gramas, ml)
- Ingredientes devem começar com hífen (-)
- Modo de preparo deve ter passos numerados (1., 2., 3.)
- Para ${quantidadePessoas} pessoas
- Responda APENAS o JSON, sem mais nada

Receita baseada em: ${Array.isArray(ingredientes) ? ingredientes.join(', ') : ingredientes}`;

    const apiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
        'User-Agent': 'MeuChef-App/1.0'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'Você é um chef brasileiro. Responda apenas com JSON válido.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.5,
        top_p: 0.8,
        max_tokens: 1400,
        stream: false
      })
    });

    if (!apiRes.ok) {
      const txt = await apiRes.text();
      return res.status(502).json({ error: 'Upstream API error', details: txt });
    }

    const data = await apiRes.json();
    let content = data?.choices?.[0]?.message?.content ?? null;

    // Limpar possíveis marcações markdown
    if (content) {
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }

    return res.status(200).json({ content });
    
  } catch (err) {
    console.error('Erro na function gerarReceita:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
