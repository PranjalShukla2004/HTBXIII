// Dev-server helper for the live commentator (ElevenLabs sub-challenge).
// The browser posts what just happened in a run; this asks Gemini for one witty line and
// ElevenLabs for the audio. Keys stay on this machine (read from HTBXIII/.env), never in the page.
// It never talks to the agent backend: it only sees what the dashboard already shows.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { personality, spice } from './src/lib/personalities.ts'
import type { Personality } from './src/lib/personalities.ts'

type Env = Record<string, string | undefined>

const BASE = `You are the live commentator for CopyCat, an app where AI browser agents shop and
fill in websites for the user while everyone watches.

You get one moment from the run (JSON) plus the lines you've already said.
Reply with ONE line to be spoken aloud: 8 to 22 words, one or two short sentences.
- Every line needs a punchline. A plain report of what happened is a failure: twist it with an absurd comparison, mock drama or playful sarcasm.
- React to the specific moment: name the shop, the product, the price when you have them.
- Be witty: gentle roasts of websites, captchas, cookie banners, prices and the agents' hard work.
- Don't repeat a joke or opener you already used. No emojis, hashtags, stage directions or quotes.
- Write in normal sentence case, never all caps, so it reads aloud naturally.
- Keep it PG and kind about real people. Never be mean to the user. Never invent prices or results you weren't given.`

const FALLBACK_VOICE = 'JBFqnCBsd6RMkjVDRZzb'  // George

const prompt = (p: Personality, level: number) =>
  `${BASE}\n\nYour character: ${p.style}. Stay fully in character, but the jokes come first.\nHumour: ${spice(level).rule}`

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

async function writeLine(env: Env, p: Personality, level: number, moment: unknown, said: string[]): Promise<string> {
  const key = env.COMMENTARY_GEMINI_API_KEY || env.GEMINI_API_KEY
  if (!key) throw new Error('no Gemini key')
  // A model the agents don't use, so the jokes never eat into their rate limit.
  const model = env.COMMENTARY_MODEL || 'gemini-3.1-flash-lite'
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(6000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt(p, level) }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify({ moment, already_said: said.slice(-6) }) }] }],
      generationConfig: { temperature: level >= 3 ? 1.25 : 1.05, maxOutputTokens: 80, thinkingConfig: { thinkingLevel: 'minimal' } },
    }),
  })
  if (!r.ok) throw new Error(`gemini ${r.status}`)
  const out = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = out.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? ''
  return text.replace(/^["'“]+|["'”]+$/g, '').replace(/\s+/g, ' ')
}

async function speak(env: Env, p: Personality, text: string, voiceId = p.voiceId): Promise<string | null> {
  const key = env.ELEVENLABS_API_KEY
  if (!key) return null
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'xi-api-key': key, accept: 'audio/mpeg' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      text,
      model_id: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
      voice_settings: { stability: p.voice.stability, similarity_boost: 0.8, style: p.voice.style, speed: p.voice.speed },
    }),
  })
  if (!r.ok) {
    const why = `elevenlabs ${r.status} for ${p.name}'s voice: ${(await r.text()).slice(0, 200)}`
    // If this account can't use a persona's voice, fall back to the default narrator rather than going silent.
    if (voiceId !== FALLBACK_VOICE && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
      console.warn('[commentary]', why, '- using the default voice')
      return speak(env, p, text, FALLBACK_VOICE)
    }
    throw new Error(why)
  }
  return Buffer.from(await r.arrayBuffer()).toString('base64')
}

export function commentary(env: Env): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    try {
      const body = JSON.parse(await readBody(req)) as { moment?: unknown; said?: string[]; persona?: string; spice?: number; sample?: boolean }
      const p = personality(body.persona)
      // "Try it" in the settings menu: the character's sample line, no Gemini call.
      const text = body.sample ? p.sample : await writeLine(env, p, spice(body.spice).level, body.moment, Array.isArray(body.said) ? body.said : [])
      if (!text) return json(res, 204, {})
      let audio: string | null = null
      let voiceError: string | undefined
      try {
        audio = await speak(env, p, text)
      } catch (err) {
        voiceError = String(err)
        console.warn('[commentary]', voiceError)
      }
      json(res, 200, { text, audio, voiceError })
    } catch (err) {
      // Commentary is decoration: fail quietly so a run is never affected.
      json(res, 503, { error: String(err) })
    }
  }
  return {
    name: 'copycat-commentary',
    configureServer(server) {
      server.middlewares.use('/__commentary', (req, res) => void handle(req, res))
    },
    configurePreviewServer(server) {
      server.middlewares.use('/__commentary', (req, res) => void handle(req, res))
    },
  }
}
