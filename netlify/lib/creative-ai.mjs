const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;

export function copyHasUrl(text = '') {
  URL_RE.lastIndex = 0;
  return URL_RE.test(String(text || ''));
}

export function stripUrls(text = '') {
  URL_RE.lastIndex = 0;
  return String(text || '')
    .replace(URL_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function normalizeSafetyText(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SENSITIVE_RULES = [
  ['politica', /\b(eleicao|eleicoes|presidente|governo|governador|prefeito|senador|deputado|partido|congresso|stf|politic[ao]s?)\b/],
  ['tragedia', /\b(morreu|morte|morto|falecimento|trag(ed|edi)a|acidente fatal|desastre|vitima|vitimas)\b/],
  ['crime', /\b(assassin|homicid|crime|prisao|preso|sequestro|estupro|roubo|tiroteio|atentado|terroris)\w*/],
  ['guerra', /\b(guerra|bombardeio|invasao militar|conflito armado|missil|ataque militar)\b/],
  ['adulto', /\b(porn|sexo explicito|conteudo adulto|nudez explicita)\w*/],
  ['drogas', /\b(cocaina|crack|heroina|metanfetamina|trafico de drogas)\b/],
  ['apostas', /\b(cassino|bet esportiva|aposta esportiva|jogo de azar)\b/]
];

export function sensitiveReasons(text = '') {
  const normalized = normalizeSafetyText(text);
  return SENSITIVE_RULES.filter(([, re]) => re.test(normalized)).map(([name]) => name);
}

export async function moderateText({ apiKey, text, timeout = 12000, fetchImpl = fetch }) {
  if (!apiKey || !String(text || '').trim()) return { checked: false, flagged: false, categories: [] };
  const response = await fetchImpl('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'omni-moderation-latest', input: String(text) }),
    signal: AbortSignal.timeout(timeout)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || `Moderation API retornou HTTP ${response.status}`);
  const result = json?.results?.[0] || {};
  const categories = Object.entries(result.categories || {}).filter(([, value]) => Boolean(value)).map(([key]) => key);
  return { checked: true, flagged: Boolean(result.flagged), categories, checkedAt: new Date().toISOString() };
}

function cleanSourceUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:') return '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

export function extractWebEvidence(response) {
  const seen = new Set();
  const sources = [];
  const add = (url, title = '') => {
    const clean = cleanSourceUrl(url);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    let domain = '';
    try { domain = new URL(clean).hostname.replace(/^www\./, ''); } catch {}
    sources.push({ url: clean, domain, title: String(title || '').slice(0, 180) });
  };
  const visit = value => {
    if (!value) return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value !== 'object') return;
    if (value.type === 'url_citation' && value.url) add(value.url, value.title);
    if (value.type === 'citation' && value.url) add(value.url, value.title);
    if (Array.isArray(value.annotations)) {
      for (const annotation of value.annotations) {
        if (annotation?.url) add(annotation.url, annotation.title);
        if (annotation?.url_citation?.url) add(annotation.url_citation.url, annotation.url_citation.title);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(response?.output || response);
  return sources.slice(0, 6);
}

export function buildImagePrompt({ type, topic = '', category = '' } = {}) {
  const common = [
    'Square 1:1 social media artwork, premium commercial art direction, clean contemporary composition.',
    'Predominantly white background, polished studio lighting, subtle depth, crisp detail.',
    'Do not render any words, letters, numbers, logos, watermarks, UI, captions or brand marks.',
    'Leave generous negative space for typography that will be overlaid later by software.',
    'Avoid clutter and avoid a synthetic stock-image look.'
  ];
  if (type === 'sale') {
    return [
      ...common,
      `Create only an elegant advertising BACKGROUND for a personalized-gifts product in the category: ${category || 'geek personalized gifts'}.`,
      'IMPORTANT: do not include the product itself, mugs, buttons, shirts, frames or any sellable object. The real product photo will be composited later.',
      'Use subtle geek-inspired geometric energy, soft mint accents and restrained collectible-culture atmosphere, without copyrighted characters or franchise logos.'
    ].join(' ');
  }
  if (type === 'hype') {
    return [
      ...common,
      `Editorial geek-culture visual inspired by the mood of this current topic: ${topic || 'current geek entertainment conversation'}.`,
      'Use abstract cinematic shapes, light, motion and thematic visual cues only. Do not reproduce recognizable copyrighted characters, actors, logos or key art.',
      'Dynamic enough to stop scrolling, but keep the center-left area readable for text overlay.'
    ].join(' ');
  }
  return [
    ...common,
    `Friendly community-engagement visual inspired by: ${topic || 'geek community conversation, nostalgia and fandom choices'}.`,
    'Use playful abstract objects, speech-bubble energy, cards, stars and collectible-culture cues without recognizable copyrighted characters or logos.',
    'Warm, inviting and designed to encourage comments.'
  ].join(' ');
}

export async function generateImageBuffer({
  apiKey,
  prompt,
  model = 'gpt-image-2',
  quality = 'low',
  size = '1024x1024',
  timeout = 150000,
  fetchImpl = fetch
}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada para geração de imagem.');
  const response = await fetchImpl('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, quality, output_format: 'webp', background: 'opaque' }),
    signal: AbortSignal.timeout(timeout)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || `Images API retornou HTTP ${response.status}`);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('A Images API não retornou dados de imagem.');
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length < 1024) throw new Error('Imagem gerada veio vazia ou inválida.');
  return { buffer, model, quality: json.quality || quality, size: json.size || size };
}
