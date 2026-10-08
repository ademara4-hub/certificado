/**
 * Serviço de leitura de etiquetas para o app de Inspeção de Acessórios.
 * Cloudflare Worker: recebe a foto da etiqueta, pergunta ao Gemini e devolve os campos.
 * A chave do Gemini fica guardada como segredo GEMINI_API_KEY (nunca no app).
 */
const ORIGENS = ['https://inspecao-ademar.pages.dev']; // quem pode usar este serviço
// tenta na ordem; os mais rápidos primeiro (leitura de etiqueta não precisa de "raciocínio" longo)
// modelos atuais (out/2026); os 2.0 foram desligados e os 2.5 não abrem para chaves novas
const MODELOS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest'];
const INDISPONIVEIS = new Set(); // lembra modelos que deram 404 enquanto o Worker estiver ativo
const PRAZO_TOTAL = 35000;   // o app desiste em 45 s; o Worker responde antes disso
const PRAZO_CHAMADA = 15000; // cada tentativa no Gemini
const espera = ms => new Promise(r => setTimeout(r, ms));
const MAX_BYTES = 6 * 1024 * 1024;

const PROMPT = `Você lê etiquetas de acessórios de içamento (cintas de poliéster, lingas de corrente, cabos de aço, manilhas, ganchos) fotografadas em campo num porto.
Extraia SOMENTE o que estiver escrito e legível. Nunca invente nem complete por dedução.
Campos:
- plaqueta: código da plaqueta/disco de identificação do cliente (ex.: disco azul UNILINK com "A0534"). Se não houver, vazio.
- descricao: descrição curta em MAIÚSCULAS no padrão "CINTA GRAB TUBULAR 15T X 2,30M FS 7:1" usando o que a etiqueta mostra (modelo, capacidade vertical, comprimento, fator de segurança).
- cmt: capacidade máxima de trabalho na vertical, com T (ex.: "15T"; 30.000 KGF = "30T"; 10.000 kg = "10T").
- comprimento: em metros com M (ex.: "2,30M", "10M").
- fabricante: nome do fabricante (ex.: TRAKKAI, QUALITY FIX DO BRASIL, LEVETEC, POLIFITEMA).
- rast: número de rastreabilidade/OP/lote (ex.: "2079-A"), sem o prefixo "OP".
- pc: peça/quantidade no formato "NN/NN" (ex.: "04/06").
- tipo: um de manilha, cinta, corrente, cabo, gancho, outro.
- etiqueta_legivel: false se a etiqueta estiver rasgada, apagada ou ilegível a ponto de não identificar capacidade e rastreabilidade.
- duvidas: lista com os nomes dos campos que você leu com dúvida.
- observacao: frase curta só se houver algo importante (ex.: "capacidade parcialmente apagada"); senão vazio.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    plaqueta: { type: 'STRING' }, descricao: { type: 'STRING' }, cmt: { type: 'STRING' },
    comprimento: { type: 'STRING' }, fabricante: { type: 'STRING' }, rast: { type: 'STRING' }, pc: { type: 'STRING' },
    tipo: { type: 'STRING', enum: ['manilha', 'cinta', 'corrente', 'cabo', 'gancho', 'outro'] },
    etiqueta_legivel: { type: 'BOOLEAN' },
    duvidas: { type: 'ARRAY', items: { type: 'STRING' } },
    observacao: { type: 'STRING' }
  },
  required: ['plaqueta', 'descricao', 'cmt', 'comprimento', 'fabricante', 'rast', 'pc', 'tipo', 'etiqueta_legivel', 'duvidas']
};

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ORIGENS.includes(origin) ? origin : ORIGENS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', 'Vary': 'Origin'
  };
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) } });

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return json({ erro: 'use POST' }, 405, origin);
    if (!ORIGENS.includes(origin)) return json({ erro: 'origem não autorizada' }, 403, origin);
    if (!env.GEMINI_API_KEY) return json({ erro: 'chave GEMINI_API_KEY não configurada no Worker' }, 500, origin);
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ erro: 'foto grande demais' }, 413, origin);

    let image;
    try { ({ image } = await request.json()); } catch { return json({ erro: 'pedido inválido' }, 400, origin); }
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
    if (!m) return json({ erro: 'imagem inválida' }, 400, origin);

    const corpo = (modelo, semPensar) => JSON.stringify({
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: m[1], data: m[2] } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json', responseSchema: SCHEMA,
        ...(semPensar ? { thinkingConfig: /2\.5/.test(modelo) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' } } : {}) }
    });
    const inicio = Date.now();
    let ultimoErro = '', sobrecarga = false;
    const lista = (env.GEMINI_MODEL ? [env.GEMINI_MODEL, ...MODELOS] : MODELOS).filter(x => !INDISPONIVEIS.has(x));
    for (const modelo of lista) {
      let semPensar = true;
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        const resta = PRAZO_TOTAL - (Date.now() - inicio);
        if (resta < 3000) { sobrecarga = true; break; }
        let r, d;
        try {
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: corpo(modelo, semPensar),
            signal: AbortSignal.timeout(Math.min(PRAZO_CHAMADA, resta - 1000))
          });
          d = await r.json().catch(() => ({}));
        } catch (e) { console.log(JSON.stringify({ modelo, status: 'tempo esgotado', ms: Date.now() - inicio })); sobrecarga = true; ultimoErro = 'o Gemini demorou demais para responder'; break; }
        console.log(JSON.stringify({ modelo, status: r.status, ms: Date.now() - inicio, erro: d?.error?.message }));
        if (r.status === 400 && /thinking/i.test(d?.error?.message || '') && semPensar) { semPensar = false; tentativa--; continue; }
        if (r.status === 404 || r.status === 400 && /not found|not supported/i.test(d?.error?.message || '')) { INDISPONIVEIS.add(modelo); ultimoErro = `modelo ${modelo} indisponível`; break; }
        if (r.status === 503 || r.status === 500 || r.status === 429) {
          // sobrecarga ou limite: espera um pouco, tenta de novo e depois passa para o próximo modelo
          sobrecarga = true; ultimoErro = d?.error?.message || `Gemini respondeu ${r.status}`;
          if (tentativa === 0) await espera(600); continue;
        }
        if (r.status === 401 || r.status === 403) return json({ erro: 'chave do Gemini recusada. Confira o segredo GEMINI_API_KEY no Worker.' }, 502, origin);
        if (!r.ok) return json({ erro: d?.error?.message || `Gemini respondeu ${r.status}` }, 502, origin);
        const txt = d?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        try { return json({ ...JSON.parse(txt), modelo }, 200, origin); }
        catch { ultimoErro = 'resposta da IA em formato inesperado'; break; }
      }
    }
    if (sobrecarga) return json({ erro: 'os servidores do Gemini estão sobrecarregados ou lentos agora. Tente de novo em alguns minutos ou preencha manualmente.' }, 503, origin);
    return json({ erro: ultimoErro || 'nenhum modelo disponível' }, 502, origin);
  }
};
