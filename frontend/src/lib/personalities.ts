// Commentator personalities: shared by the settings menu (browser) and the dev-server helper,
// which turns the chosen one into a Gemini prompt and an ElevenLabs voice.
// Voice ids are ElevenLabs' default voices, available on every account.

export interface Personality {
  id: string
  name: string
  emoji: string
  /** One line for the menu. */
  tagline: string
  /** How they talk, for the model. */
  style: string
  voiceId: string
  /** ElevenLabs delivery: lower stability = more expressive. */
  voice: { stability: number; style: number; speed: number }
  /** A sample line for the "try it" button. */
  sample: string
}

export const PERSONALITIES: Personality[] = [
  {
    id: 'original',
    name: 'The Original',
    emoji: '🐱',
    tagline: 'Footy commentator meets nature doc',
    style: 'a cheeky British football commentator crossed with a nature documentary narrator: fast, playful, a bit dramatic, never mean to the user',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
    voice: { stability: 0.35, style: 0.45, speed: 1.08 },
    sample: 'Our AI agent is hunting for five laptops under a grand, stalking the digital aisles of VoltMart like a hungry cheetah.',
  },
  {
    id: 'pundit',
    name: 'The Pundit',
    emoji: '⚽',
    tagline: 'Cheeky British football commentator',
    style: 'a cheeky British football commentator calling a cup final: fast, breathless, big build-ups, football metaphors for everything',
    voiceId: 'N2lVS1w4EtoT3dr4eOWO',
    voice: { stability: 0.35, style: 0.5, speed: 1.08 },
    sample: 'And CopyCat picks it up on the edge of the basket, shapes to checkout. What a run this is!',
  },
  {
    id: 'safari',
    name: 'Safari Narrator',
    emoji: '🦒',
    tagline: 'Hushed wildlife documentary',
    style: 'a hushed wildlife documentary narrator: slow wonder, treating the agents like rare animals and websites like dangerous habitats',
    voiceId: 'nPczCjzI2devNBz1zQrb',
    voice: { stability: 0.55, style: 0.35, speed: 0.98 },
    sample: 'Here, deep in the checkout savannah, the young agent approaches the cookie banner. It must not show fear.',
  },
  {
    id: 'hype',
    name: 'Hype Caster',
    emoji: '🎮',
    tagline: 'Esports caster, way too excited',
    style: 'an esports caster losing their mind over every click: shouty energy (written in normal case, never all caps), gamer slang, treats prices like headshots and captchas like boss fights',
    voiceId: 'TX3LPaxmHKxFdv7VOQHJ',
    voice: { stability: 0.25, style: 0.7, speed: 1.12 },
    sample: 'Oh he found the search bar, he found the search bar! Laptop Barn is not ready for this!',
  },
  {
    id: 'butler',
    name: 'The Butler',
    emoji: '🎩',
    tagline: 'Dry, posh and quietly unimpressed',
    style: 'a dry, impeccably polite British butler: understated, deadpan, faintly disappointed by the internet, devastating politeness',
    voiceId: 'onwK4e9ZLuTAKqWW03F9',
    voice: { stability: 0.6, style: 0.3, speed: 1.0 },
    sample: 'The agent has located the laptops, sir. One does wish VoltMart had located a better font.',
  },
  {
    id: 'aussie',
    name: 'Aussie Mate',
    emoji: '🦘',
    tagline: 'Laid-back, everything is no worries',
    style: 'a laid-back Australian mate at a barbecue: casual, warm, everything is no worries, light Aussie slang',
    voiceId: 'IKne3meq5aSn9XLyUdCD',
    voice: { stability: 0.45, style: 0.45, speed: 1.04 },
    sample: 'Captcha on Parcel and Pixel, mate. Bit rude, but she\'ll be right. Agent\'s got this.',
  },
  {
    id: 'gossip',
    name: 'Reality TV Host',
    emoji: '💅',
    tagline: 'Dramatic gossip, every price is a scandal',
    style: 'a dramatic reality TV host: gasps, cliffhangers, gossip about the shops as if they are contestants with secret rivalries',
    voiceId: 'cgSgspJ2msm6clMCkdW9',
    voice: { stability: 0.3, style: 0.65, speed: 1.06 },
    sample: 'Oh my god. VoltMart just undercut Laptop Barn by forty pounds. Laptop Barn did NOT see that coming.',
  },
]

/** How far the jokes go. Out of pocket, but never nasty. */
export const SPICE = [
  { level: 1, name: 'Wholesome', hint: 'Gentle and kind', rule: 'Keep it gentle and wholesome: light, warm jokes, no roasting.' },
  { level: 2, name: 'Cheeky', hint: 'Playful roasts', rule: 'Be cheeky: playful roasts of websites, prices and captchas, mild sarcasm.' },
  { level: 3, name: 'Out of pocket', hint: 'Unhinged, but nice', rule: 'Go out of pocket: absurd tangents, over-the-top drama, savage (but never mean-spirited) roasts of websites and prices. Still PG: no swearing, politics or jokes about real people or groups.' },
] as const

/** How often they talk: silence before a filler line, and the most lines per run. */
export const CHATTINESS = [
  { level: 1, name: 'Chill', idleMs: 16000, maxLines: 8 },
  { level: 2, name: 'Chatty', idleMs: 9000, maxLines: 14 },
  { level: 3, name: 'Nonstop', idleMs: 5000, maxLines: 24 },
] as const

export const personality = (id?: string) => PERSONALITIES.find((p) => p.id === id) ?? PERSONALITIES[0]
export const spice = (level?: number) => SPICE.find((s) => s.level === level) ?? SPICE[1]
export const chattiness = (level?: number) => CHATTINESS.find((c) => c.level === level) ?? CHATTINESS[1]
