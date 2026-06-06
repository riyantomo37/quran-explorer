// Cloudflare Worker: penerjemah format Groq/OpenAI <-> Gemini.
// HTML lama tetap kirim {model, messages:[{role,content}], max_tokens} ke /api/groq
// dan tetap baca choices[0].message.content. Worker ini yang menerjemahkan.

const GEMINI_MODEL = 'gemini-2.5-flash';

function jsonError(message, code, status) {
  // HTML lama baca d.error.message -> kirim error sebagai OBJEK, bukan string.
  return new Response(JSON.stringify({ error: { message: message, code: code } }), {
    status: status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Ubah messages[] (format OpenAI/Groq) -> {system_instruction, contents[]} (Gemini).
function toGemini(messages) {
  let systemText = '';
  const raw = [];

  for (const m of (messages || [])) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + m.content;
      continue;
    }
    // Gemini pakai role "user" dan "model" (bukan "assistant").
    const role = (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user';
    raw.push({ role: role, text: m.content });
  }

  // 1) Buang pesan "model" di awal (Gemini tolak contents[] yang diawali model).
  while (raw.length && raw[0].role === 'model') raw.shift();

  // 2) Gabung role yang berurutan sama.
  const merged = [];
  for (const item of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === item.role) {
      last.text += '\n\n' + item.text;
    } else {
      merged.push({ role: item.role, text: item.text });
    }
  }

  // 3) Fallback: kalau kosong, kasih satu user kosong biar request valid.
  if (!merged.length) merged.push({ role: 'user', text: '(tidak ada pesan)' });

  const contents = merged.map(function (x) {
    return { role: x.role, parts: [{ text: x.text }] };
  });

  const body = { contents: contents };
  if (systemText) {
    body.system_instruction = { parts: [{ text: systemText }] };
  }
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Endpoint dipertahankan: /api/groq (cuma label, tak perlu diganti).
    if (url.pathname === '/api/groq') {
      if (request.method !== 'POST') {
        return jsonError('Method not allowed.', 'method_not_allowed', 405);
      }
      if (!env.GEMINI_API_KEY) {
        return jsonError('GEMINI_API_KEY belum diset sebagai runtime secret.', 'no_secret', 500);
      }

      let incoming;
      try {
        incoming = await request.json();
      } catch (e) {
        return jsonError('Body request bukan JSON valid.', 'bad_request', 400);
      }

      const maxTokens = (incoming && incoming.max_tokens) ? incoming.max_tokens : 1024;
      const geminiBody = toGemini(incoming && incoming.messages);
      geminiBody.generationConfig = { maxOutputTokens: maxTokens };

      const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        GEMINI_MODEL + ':generateContent';

      let gRes, gData;
      try {
        gRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY,
          },
          body: JSON.stringify(geminiBody),
        });
        gData = await gRes.json();
      } catch (e) {
        return jsonError('Gagal menghubungi Gemini: ' + e.message, 'upstream_error', 502);
      }

      if (!gRes.ok) {
        const msg = (gData && gData.error && gData.error.message)
          ? gData.error.message : 'Error dari Gemini.';
        const code = (gData && gData.error && gData.error.status)
          ? gData.error.status : 'gemini_error';
        return jsonError(msg, code, gRes.status);
      }

      // Ambil teks dari candidates[0].content.parts[].text
      let reply = '';
      try {
        const parts = gData.candidates[0].content.parts || [];
        reply = parts.map(function (p) { return p.text || ''; }).join('');
      } catch (e) {
        reply = '';
      }

      if (!reply) {
        // Bisa kena safety block / finishReason lain.
        const fr = (gData.candidates && gData.candidates[0] && gData.candidates[0].finishReason)
          ? gData.candidates[0].finishReason : 'unknown';
        return jsonError('Gemini tidak mengembalikan teks (finishReason: ' + fr + ').', 'empty_reply', 502);
      }

      // Bungkus balik ke format Groq/OpenAI yang dibaca HTML lama.
      const out = { choices: [{ message: { role: 'assistant', content: reply } }] };
      return new Response(JSON.stringify(out), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Selain /api/groq -> serahkan ke Static Assets (index.html dll).
    return env.ASSETS.fetch(request);
  },
};
