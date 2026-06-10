export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const API_KEY = context.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY nao configurada' }), { status: 500, headers: cors });
  }

  try {
    const body = await context.request.json();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    return new Response(JSON.stringify(data), { status: r.status, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
