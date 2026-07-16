// api/transcribe.js
// Receives a short audio clip from the app and returns the transcribed text.
// Request  (POST, JSON):  { audio: "<base64>", mime: "audio/webm" }
// Response (JSON):        { text: "the spoken words" }
//
// The OpenAI key is read from the OPENAI_API_KEY environment variable and never
// leaves the server, so it is never exposed to users' browsers.

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { audio, mime } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'No audio provided' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY' });
    }

    const buffer = Buffer.from(audio, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Empty audio' });

    // Pick a sensible file extension from the recorded audio type.
    const type = (mime || 'audio/webm').toLowerCase();
    const ext =
      type.includes('mp4') || type.includes('m4a') || type.includes('aac') ? 'm4a' :
      type.includes('ogg') ? 'ogg' :
      type.includes('mpeg') || type.includes('mp3') ? 'mp3' :
      'webm';

    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), `audio.${ext}`);
    // whisper-1 works on every OpenAI account. To halve the cost once you've
    // confirmed it all works, change the model below to: gpt-4o-mini-transcribe
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', 'en'); // remove this line if you want auto language detection

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Transcription failed', detail: detail.slice(0, 300) });
    }

    const data = await r.json();
    return res.status(200).json({ text: (data.text || '').trim() });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
