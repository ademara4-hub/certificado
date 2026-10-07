// Recebe { image, mimeType } da página, monta o pedido ao Gemini aqui no
// servidor e devolve { fields } com os dados lidos da etiqueta.
// O prompt e o modelo ficam fixos no servidor para que o endpoint não sirva
// de proxy aberto para a chave da API.

const DEFAULT_MODEL = 'gemini-flash-latest';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const TIPOS = ['Cinta têxtil plana', 'Cinta têxtil redonda', 'Manilha', 'Cabo de aço', 'Corrente', 'Outro'];

const FIELDS = {
  tipo: 'tipo do acessório',
  serie: 'número de série / ID',
  fabricante: 'fabricante',
  op: 'OP ou lote',
  largura: 'largura ou diâmetro',
  comprimento: 'comprimento',
  dt_fabricacao: 'data de fabricação',
  norma: 'norma e material',
  wll_vertical: 'WLL vertical em kg',
  wll_forca: 'WLL força/choker em kg',
  wll_cesto: 'WLL cesto/berço em kg',
  id_inspecao: 'código de inspeção',
  empresa_inspecao: 'empresa de inspeção'
};

const PROMPT =
  'Você é especialista em acessórios de içamento. Leia a etiqueta da foto e preencha os campos do JSON. ' +
  'O campo "tipo" deve ser exatamente um destes: ' + TIPOS.join(', ') + '. ' +
  'Cintas têm tabela WLL com ícones vertical/força/cesto; informe os valores em kg, só números. ' +
  'Campos que não estiverem visíveis na etiqueta devem ser string vazia. Não invente valores.';

const SCHEMA = {
  type: 'OBJECT',
  properties: Object.fromEntries(
    Object.entries(FIELDS).map(([k, desc]) =>
      [k, k === 'tipo' ? { type: 'STRING', enum: TIPOS.concat(['']), description: desc } : { type: 'STRING', description: desc }]
    )
  ),
  required: Object.keys(FIELDS)
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ error: 'Origem não permitida' }, 403);
  }

  const API_KEY = env.GEMINI_API_KEY;
  if (!API_KEY) return json({ error: 'GEMINI_API_KEY não configurada' }, 500);

  let image, mimeType;
  try {
    ({ image, mimeType } = await request.json());
  } catch (e) {
    return json({ error: 'Corpo da requisição inválido' }, 400);
  }
  if (typeof image !== 'string' || !image || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return json({ error: 'Imagem ausente ou inválida' }, 400);
  }
  if (!MIME_TYPES.includes(mimeType)) return json({ error: 'Tipo de imagem não suportado' }, 400);
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: 'Imagem muito grande' }, 413);

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: image } }, { text: PROMPT }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA
    }
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) {
      return json({ error: (data.error && data.error.message) || 'Erro na API do Gemini' }, 502);
    }
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const txt = parts.map(p => p.text || '').join('').trim();
    if (!txt) return json({ error: 'Resposta vazia da IA' }, 502);

    const parsed = JSON.parse(txt);
    const fields = {};
    Object.keys(FIELDS).forEach(k => { fields[k] = typeof parsed[k] === 'string' ? parsed[k].trim() : ''; });
    return json({ fields });
  } catch (e) {
    return json({ error: 'Falha ao ler a etiqueta: ' + e.message }, 502);
  }
}
