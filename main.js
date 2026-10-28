'use strict';
/*
 * Scene Draft — Obsidian plugin
 * Beat-drafting workspace ported from NovelForge.
 *
 * Beat shorthand:
 *   NAME: spoken line        dialogue
 *   @ physical action        action beat
 *   [NAME: rough thought]    interiority
 *   ( scene direction )      writer's stage direction
 */
const { Plugin, ItemView, Notice, PluginSettingTab, Setting, MarkdownView, requestUrl } = require('obsidian');

const VIEW_TYPE = 'scene-draft-view';

/* ───────────────────────── Providers ───────────────────────── */

const openaiLike = {
  body: (messages, model, temperature, max_tokens, stream) => ({ model, messages, temperature, max_tokens, stream }),
  chunk: (d) => d.choices?.[0]?.delta?.content || '',
  full: (d) => d.choices?.[0]?.message?.content || '',
};

const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'anthropic/claude-sonnet-4-5',
    hint: 'e.g. anthropic/claude-sonnet-4-5, openai/gpt-4o, google/gemini-2.0-flash-001',
    headers: (k) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${k}`, 'X-Title': 'Scene Draft (Obsidian)' }),
    ...openaiLike,
  },
  anthropic: {
    name: 'Anthropic (direct)',
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-5-5',
    hint: 'e.g. claude-sonnet-5-5, claude-opus-5-5, claude-haiku-5-5',
    headers: (k) => ({
      'Content-Type': 'application/json',
      'x-api-key': k,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: (messages, model, temperature, max_tokens, stream) => ({
      model,
      system: messages.find((m) => m.role === 'system')?.content || '',
      messages: messages.filter((m) => m.role !== 'system'),
      temperature,
      max_tokens,
      stream,
    }),
    chunk: (d) => (d.type === 'content_block_delta' ? d.delta?.text || '' : ''),
    full: (d) => d.content?.[0]?.text || '',
  },
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    hint: 'e.g. gpt-4o, gpt-4o-mini',
    headers: (k) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }),
    ...openaiLike,
  },
  nanogpt: {
    name: 'NanoGPT',
    endpoint: 'https://nano-gpt.com/api/v1/chat/completions',
    defaultModel: 'gpt-4o',
    hint: 'e.g. gpt-4o, claude-3-5-sonnet',
    headers: (k) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${k}`, 'x-api-key': k }),
    ...openaiLike,
  },
  custom: {
    name: 'Custom (OpenAI-compatible)',
    endpoint: '',
    defaultModel: '',
    hint: 'Any OpenAI-compatible server (Ollama, LM Studio, vLLM…). Set the endpoint below.',
    headers: (k) => ({ 'Content-Type': 'application/json', ...(k ? { Authorization: `Bearer ${k}` } : {}) }),
    ...openaiLike,
  },
};

const DEFAULTS = {
  provider: 'openrouter',
  models: {}, // per provider
  keys: {}, // per provider
  customEndpoint: 'http://localhost:11434/v1/chat/completions',
  temperature: 0.9,
  maxTokens: 2000,
  language: '', // blank = auto-detect (Spanish detected from the text)
  charactersFolder: 'Characters',
  contextWords: 400,
  proseMode: 'after', // 'after' | 'replace'
  defaultSceneMode: 'mixed', // 'mixed' | 'dialogue' | 'action'
  drafts: {}, // note path -> { text, location, mode }
};

/* ───────────────────────── Networking ───────────────────────── */

class HttpError extends Error {
  constructor(status, body) {
    super(friendlyError(status, body));
    this.status = status;
  }
}

function friendlyError(status, body) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j.error?.message || j.message || '';
  } catch (_) { /* not JSON */ }
  msg = msg || String(body || '').slice(0, 200);
  if (status === 401 || status === 403) return `Authentication failed (${status}) — check your API key. ${msg}`;
  if (status === 402) return `Insufficient credits (402). ${msg}`;
  if (status === 404) return `Model or endpoint not found (404) — check the model name. ${msg}`;
  if (status === 429) return `Rate limited (429) — try again shortly. ${msg}`;
  return `Request failed (${status}). ${msg}`;
}

/**
 * Streams a chat completion. Uses fetch (true streaming); if fetch fails at the
 * network/CORS level before any text arrived (typical on mobile), falls back to
 * Obsidian's requestUrl (no streaming, but no CORS). Resolves with the full text.
 */
async function complete(settings, messages, onChunk, signal) {
  const cfg = PROVIDERS[settings.provider];
  if (!cfg) throw new Error('Unknown provider: ' + settings.provider);
  const key = (settings.keys[settings.provider] || '').trim();
  if (!key && settings.provider !== 'custom') {
    throw new Error(`No API key for ${cfg.name}. Add it in Settings → Scene Draft.`);
  }
  const model = ((settings.models || {})[settings.provider] || '').trim() || cfg.defaultModel;
  if (!model) throw new Error('No model set. Add one in Settings → Scene Draft.');
  const endpoint = settings.provider === 'custom' ? settings.customEndpoint.trim() : cfg.endpoint;
  if (!endpoint) throw new Error('No endpoint set. Add one in Settings → Scene Draft.');

  const headers = cfg.headers(key);
  const makeBody = (stream) => JSON.stringify(cfg.body(messages, model, settings.temperature, settings.maxTokens, stream));

  let full = '';
  const handle = (line) => {
    line = line.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const t = cfg.chunk(JSON.parse(data));
      if (t) { full += t; onChunk(t, full); }
    } catch (_) { /* malformed event */ }
  };

  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body: makeBody(true), signal });
    if (!res.ok) throw new HttpError(res.status, await res.text());
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(handle);
    }
    if (buf) handle(buf);
    if (!full.trim()) throw new Error('Empty response from the model.');
    return full;
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError') throw e;
    if (e instanceof HttpError) throw e;
    if (full.trim()) return full; // connection dropped mid-stream: keep what we have
    if (e.message === 'Empty response from the model.') throw e;
    const r = await requestUrl({ url: endpoint, method: 'POST', headers, body: makeBody(false), throw: false });
    if (r.status >= 400) throw new HttpError(r.status, r.text);
    const text = cfg.full(r.json);
    if (!text) throw new Error('Empty response from the model.');
    onChunk(text, text);
    return text;
  }
}

/* ───────────────────────── Text helpers ───────────────────────── */

const ES_WORDS = new Set('el la los las de del que y en un una por con para es se lo como pero sus al más ya o fue este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto antes algunos qué unos yo otro otras otra él tanto esa estos mucho nada muchos cual poco ella estar estas algo nosotros mi mis tu te ti'.split(' '));
const EN_WORDS = new Set('the and of to in is that it was for on are with as his they be at one have this from or had by but not what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has her two more him could no than been its who now my made over did down only way find use may just where most know you he i'.split(' '));

function detectSpanish(sample) {
  const s = (sample || '').slice(0, 4000).toLowerCase();
  const toks = s.match(/[a-záéíóúüñ']+/g) || [];
  if (toks.length < 8) return false;
  let es = 0, en = 0;
  for (const t of toks) { if (ES_WORDS.has(t)) es++; if (EN_WORDS.has(t)) en++; }
  es += (s.match(/[¿¡ñáéíóú]/g) || []).length * 0.5;
  return es > en;
}

function isSpanishLang(lang) {
  const l = (lang || '').trim().toLowerCase();
  return /(^|[^a-z])(spanish|espa[ñn]ol|castellano|es-[a-z]{2}|latam\s*spanish)([^a-z]|$)/.test(l) || l === 'es';
}

function langDirective(lang, isEs) {
  if (!lang && !isEs) return '';
  const L = lang || 'español';
  let out = ` Write all generated text in ${L}, regardless of the language used in any instructions, notes, or existing context — unless the user explicitly asks for a different language for that specific request.`;
  if (isEs) {
    out += ` Any English phrases shown elsewhere in these instructions (example sentences, illustrative snippets, craft techniques like "He smiled, small and tight" → "He smiled") are meta-examples of a WRITING TECHNIQUE only — they are never a language cue. Translate the technique, not the words: every action beat, every piece of narration, and every line of dialogue in your actual output must be entirely in ${L}, with zero English words or phrases.`;
    if (!lang || /neutr/i.test(lang)) {
      out += ' Use neutral Spanish (español neutro): "tú" conjugations, no "vos"/voseo, and no regional slang or idioms (Argentine, Mexican, etc.) — unless the user\'s own text or explicit instructions establish a specific regional voice.';
    }
  }
  return out;
}

/** Last ~`words` words of prose before `offset`, cut at paragraph boundaries. */
function contextBefore(text, offset, words) {
  let before = text.slice(0, Math.max(0, offset)).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const paras = before.split(/\n{2,}/);
  const kept = [];
  let count = 0;
  for (let i = paras.length - 1; i >= 0; i--) {
    const n = paras[i].trim().split(/\s+/).filter(Boolean).length;
    if (kept.length && count + n > words) break;
    kept.unshift(paras[i]);
    count += n;
  }
  return kept.join('\n\n').trim();
}

function cleanOutput(text) {
  let t = (text || '').trim();
  const m = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (m) t = m[1].trim();
  return t;
}

/* ───────────────────────── Prompts (ported from NovelForge) ───────────────────────── */

function buildContinueMessages({ draft, recent, location, cast, mode, lang, isEs }) {
  const actionExample = isEs
    ? '@ Salta por el tragaluz, las perlas se derraman bajo la lluvia.'
    : '@ She vaults the skylight, pearls scattering into the rain.';
  const locationBlock = location?.trim()
    ? `\nLOCATION of this scene (use it — every beat must be physically possible here and exploit what this place offers):\n"""\n${location.trim()}\n"""\n`
    : '';
  const castBlock = cast
    ? `\nCharacters in this story (use these names, keep their voices distinct):\n${cast}\n`
    : '';

  const dynamicsExample = isEs
    ? `ILUSTRATIVO solo (nunca reutilices este texto):
  LUCÍA: Me pediste que guardara silencio y lo hice.
  PABLO: Y funcionó. ¿O no?
  LUCÍA: Funcionó para ti.
  DANA: Te está esquivando, Pablo. Lo sabes, ¿no?`
    : `ILLUSTRATIVE only (never reuse this wording):
  LUCY: You told me to keep quiet, and I did.
  PABLO: And it worked. Didn't it?
  LUCY: It worked for you.
  DANA: He's dodging, Pablo. You know that, right?`;

  const dynamicsBlock = `
DIALOGUE DYNAMICS (mandatory — this is what separates sharp dialogue from polite chatter):
- Every line is a MOVE, not a reply: counterattack, deflect, mock, pile on, flip the accusation back, expose the other's dodge, or concede grudgingly WITH a twist ("Fair enough—" followed by a jab). A line that merely answers, informs, or asks politely is a failed line.
- Nobody resolves, agrees cleanly, or gets the satisfying last word that closes the topic — mid-exchange détente is a defect. If the argument seems settled, someone reopens it from a new angle.
- Alliances shift in-flight: a character may back one side and turn on it within the same line.
- Real interruptions: cut a word off mid-sentence and self-correct in place ("she's just—actually, yeah").
- Callbacks: every few lines, weaponize something concrete said earlier in the exchange or the scene — specific objects, promises, past events — never abstract restatements.
- Each speaker argues with a DIFFERENT tactic (cold pragmatism, deflecting humor, wounded grievance, etc. — take it from their voice descriptors).
FORBIDDEN (assistant habits): hedging ("I feel like", "maybe", "sort of"), calmly explaining one's own feelings, "I understand your point", reasonable monologues, diplomatic smoothing-over.`;

  const esBeatRule = isEs
    ? `\n- Every beat's CONTENT (spoken words, action descriptions, and thoughts) must be written entirely in the output language — the NAME: prefix uses the character's name exactly as given, never translated. Action beats and thoughts must read as natural native prose, not word-for-word translation.`
    : '';

  let formatBlock;
  if (mode === 'action') {
    formatBlock = `You are an action writer. You write ONLY raw action beats in the exact format:

@ physical action or movement

RULES:
- ACTION ONLY. Every line starts with "@ " followed by one clear physical action, movement, or beat of physical business.
- Write action in the present descriptive style of a beat sheet (e.g. "${actionExample}"). No spoken dialogue, no prose paragraphs, no scene headers, no camera directions. Never emit bracketed "[NAME: ...]" thought lines or "(...)" direction lines — thoughts and directions are not action.
- Keep beats kinetic and concrete: chases, fights, escapes, pursuits, grabs, leaps, near-misses, environmental interaction. One beat per line.
- Build escalation and momentum: each beat should follow from and raise the stakes of the previous one.
- Do NOT repeat beats already present in the draft.`;
  } else if (mode === 'dialogue') {
    formatBlock = `You are a dialogue writer. You write ONLY raw dialogue lines in the exact format:

NAME: spoken line

RULES:
- Dialogue ONLY. No prose, no narration, no action beats, no scene description, no attributions beyond the NAME prefix, no stage directions, no parentheses. Never emit bracketed "[NAME: ...]" thought lines or "(...)" direction lines — thoughts and directions are not dialogue.
- Keep each character's voice, personality, and speech rhythm distinct and consistent.
- Lines should be short and punchy like real speech — fragments, interruptions, subtext. Avoid monologues unless a character would genuinely deliver one.
- Do NOT repeat lines already present in the exchange.
- One NAME: line per line of dialogue. Do not number, do not add blank commentary.
${dynamicsBlock}

${dynamicsExample}`;
  } else {
    formatBlock = `You are a scene writer. You write ONLY raw scene beats — a precise mix of spoken dialogue, physical action, and interiority — in three exact formats:

NAME: spoken line        (for dialogue)
@ physical action       (for action beats)
[NAME: rough thought]   (for interiority — what this character is thinking, sketched briefly)

RULES:
- Dialogue lines carry ONLY the spoken words (plus the NAME: prefix) — no attributions, no stage directions, no parentheses.
- Action lines start with "@ " and carry ONE clear physical action, movement, or beat of physical business each.
- Thought lines are wrapped in square brackets: "[NAME: ...]" — one clear thought per line, briefly sketched (the writer's prose pass will expand it). Use them when the moment is internal — a realization, doubt, flicker of contempt — not on every line.
- "(...)" parenthetical lines in the draft are the writer's stage directions — follow their spirit when choosing what happens next, but NEVER output "(...)" lines yourself: directions are the writer's format.
- Interleave dialogue, action, and thought as the scene's momentum demands: banter punctuates movement, movement forces reaction, interiority colors what speech and action cannot say. Do not write long runs of any one type unless the scene genuinely calls for it.
- Dialogue here has bite: every spoken line is a move (counter, deflect, mock, pile on) — never a polite reply, no clean resolutions mid-scene, and weaponize concrete callbacks instead of abstractions.
- Keep each character's voice, personality, and speech rhythm distinct and consistent.${esBeatRule}
- Do NOT repeat lines or beats already present in the draft.
- One beat per line. Do not number, do not add blank commentary.`;
  }

  const countHint = mode === 'action' ? (draft ? '3–6' : '3–5') : (draft ? '4–10' : '4–8');
  const noun = mode === 'action' ? 'action beats' : mode === 'dialogue' ? 'dialogue lines' : 'scene beats';

  const system = `${formatBlock}${langDirective(lang, isEs)}\n- Return ONLY the scene beat lines, nothing else.`;
  const user = `Prose currently in the note (scene context — what's happening around the characters right now):
"""
${recent || '(the note has no prose before this point — no scene context yet)'}
"""${locationBlock}${castBlock}
The scene beats so far (continue from the last line):
"""
${draft || "(empty — open the scene with beats that establish what's happening)"}
"""

Write the next ${countHint} ${noun} now:`;

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function buildProseMessages({ draft, recent, location, cast, lang, isEs }) {
  const locationBlock = location?.trim()
    ? `\nLOCATION of this scene (keep every moment physically possible here and exploit what this place offers):\n"""\n${location.trim()}\n"""\n`
    : '';
  const castBlock = cast ? `\nCharacters in this story (keep their voices distinct):\n${cast}\n` : '';

  const esStyle = isEs
    ? `
REGLAS DE ESTILO ESPAÑOL (OBLIGATORIAS):
- Los diálogos se marcan con raya (—) pegada a la primera palabra: —No sabías nada, ¿verdad?
- El verbo de habla, si aparece, va tras otra raya separada por un espacio: —¿Y ahora qué? —preguntó Lucía.
- Nunca uses comillas inglesas para dialogar; la raya es la convención.
- Las acotaciones del narrador van en párrafo aparte, nunca incrustadas en el diálogo salvo como inciso con verbo de habla.
`
    : '';

  const system = `You are a master novelist who converts raw scene beats into finished prose. The beats arrive in a strict shorthand:
- "NAME: spoken line" — dialogue said aloud by NAME
- "@ physical action" — a beat of physical action or business
- "[NAME: rough thought]" — interiority: what NAME is thinking
- "( ... )" — scene direction / atmosphere / staging note

Your job: render that shorthand as vivid, publishable narrative prose.${esStyle}
LOYALTY IS ABSOLUTE:
- Every beat must appear in the prose, in order — every spoken line, every action, every thought, every direction. Never drop or skip beats, never merge two exchanges into one summary line.
- Never invent new plot events, characters, revelations, or resolutions the beats do not contain.

HOW TO RENDER EACH FORMAT:
- Dialogue becomes properly punctuated prose, with attribution ("..." said NAME, or NAME said, "...") — or no attribution at all when the back-and-forth rhythm makes the speaker obvious.
- Action beats become concrete, sensory narration: expand the shorthand into specific physical business (gesture, weight, texture, sound), changing nothing about what happens.
- Thoughts become interiority woven into the narration — free indirect style, or a direct thought consistent with the surrounding voice. Never wrap thoughts in brackets or italics markers.
- Scene directions become atmospheric narration — light, weather, sound, space — grounding the scene without dictating the characters' inner lives.

FORM:
- Paragraph like a novel: a new paragraph for each new speaker, a shift of subject, or a beat of silence.
- Match the voice, tense, and register of the prose excerpt you are given as style reference.
- Output ONLY the prose — no headings, no beat syntax, no markdown, no commentary, no explanation, no quotation of the original beats.`;

  const user = `${langDirective(lang, isEs)}

Style reference — the most recent prose before this point (match its voice, tense, and register; do not repeat or rewrite it):
"""
${recent || '(no prose before this point — write clean, neutral literary prose)'}
"""${locationBlock}${castBlock}
The raw scene beats to transform into prose:
"""
${draft}
"""

Write the finished prose now:`;

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ───────────────────────── Plugin ───────────────────────── */

class SceneDraftPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.lastMd = null;
    this.job = null;

    this.registerView(VIEW_TYPE, (leaf) => new SceneDraftView(leaf, this));
    this.addRibbonIcon('pen-line', 'Scene Draft: open workspace', () => this.openWorkspace(true));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('scene-draft-status');
    this.statusEl.style.display = 'none';
    this.statusEl.onclick = () => this.cancel();

    this.addCommand({
      id: 'selection-to-prose',
      name: 'Turn selected beats into prose',
      editorCallback: (editor, view) => this.cmdProse(editor, view),
    });
    for (const [id, name, mode] of [
      ['continue-mixed', 'Continue beats (mixed)', 'mixed'],
      ['continue-lines', 'Continue beats (dialogue lines only)', 'dialogue'],
      ['continue-action', 'Continue beats (action only)', 'action'],
    ]) {
      this.addCommand({ id, name, editorCallback: (editor, view) => this.cmdContinue(editor, view, mode) });
    }
    this.addCommand({ id: 'open-workspace', name: 'Open workspace (pull selection)', callback: () => this.openWorkspace(true) });
    this.addCommand({ id: 'cancel', name: 'Stop generation', callback: () => this.cancel() });

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      if (!editor.getSelection().trim()) return;
      menu.addSeparator();
      menu.addItem((i) => i.setTitle('Scene Draft: beats → prose').setIcon('pen-line').onClick(() => this.cmdProse(editor, view)));
      menu.addItem((i) => i.setTitle('Scene Draft: continue beats').setIcon('list-plus').onClick(() => this.cmdContinue(editor, view, this.settings.defaultSceneMode)));
      menu.addItem((i) => i.setTitle('Scene Draft: open in workspace').setIcon('panel-right').onClick(() => this.openWorkspace(true)));
    }));

    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf && leaf.view instanceof MarkdownView) {
        this.lastMd = leaf.view;
        this.getPanels().forEach((p) => p.refresh && p.refresh());
      }
    }));
    this.app.workspace.onLayoutReady(() => {
      const v = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (v) this.lastMd = v;
    });

    this.addSettingTab(new SceneDraftSettingTab(this.app, this));
  }

  onunload() {
    this.cancel();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /* settings */
  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, saved);
    this.settings.keys = Object.assign({}, saved.keys);
    this.settings.models = Object.assign({}, saved.models);
    this.settings.drafts = Object.assign({}, saved.drafts);
  }
  async saveSettings() { await this.saveData(this.settings); }

  /* editor targeting */
  targetEditor(notify = true) {
    const v = this.lastMd;
    if (v && v.file && this.app.workspace.getLeavesOfType('markdown').some((l) => l.view === v)) return v.editor;
    const a = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (a) { this.lastMd = a; return a.editor; }
    if (notify) new Notice('Scene Draft: open a note first.');
    return null;
  }

  getPanels() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v) => v && typeof v.setBusy === 'function');
  }

  async openWorkspace(pull) {
    const { workspace } = this.app;
    const md = workspace.getActiveViewOfType(MarkdownView);
    if (md) this.lastMd = md;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view && typeof view.refresh === 'function') {
      view.refresh();
      if (pull) view.pullSelection(true);
    }
  }

  /* source text: selection, or the contiguous block of lines around the cursor */
  getSource(editor) {
    if (editor.getSelection().trim()) {
      return {
        text: editor.getSelection(),
        from: editor.posToOffset(editor.getCursor('from')),
        to: editor.posToOffset(editor.getCursor('to')),
      };
    }
    const cur = editor.getCursor();
    if (!editor.getLine(cur.line).trim()) return null;
    let s = cur.line, e = cur.line;
    while (s > 0 && editor.getLine(s - 1).trim()) s--;
    while (e < editor.lineCount() - 1 && editor.getLine(e + 1).trim()) e++;
    const a = { line: s, ch: 0 };
    const b = { line: e, ch: editor.getLine(e).length };
    return { text: editor.getRange(a, b), from: editor.posToOffset(a), to: editor.posToOffset(b) };
  }

  frontmatterLocation(view) {
    const file = view && view.file;
    if (!file) return '';
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return (fm && fm.location) ? String(fm.location) : '';
  }

  /* cast from the characters folder */
  async getCast() {
    const folder = (this.settings.charactersFolder || '').trim().replace(/^\/+|\/+$/g, '');
    if (!folder) return '';
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder + '/'));
    const lines = [];
    for (const f of files) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
      if (fm.enabled === false) continue;
      const name = String(fm.name || f.basename).trim();
      if (!name) continue;
      const rawTraits = Array.isArray(fm.traits) ? fm.traits : typeof fm.traits === 'string' ? fm.traits.split(',') : [];
      const traits = rawTraits.map((t) => String(t).trim()).filter(Boolean).slice(0, 3);
      let notes = fm.notes ? String(fm.notes) : '';
      if (!notes) {
        const body = (await this.app.vault.cachedRead(f)).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        notes = body;
      }
      notes = notes.replace(/\s+/g, ' ').trim().slice(0, 80);
      const desc = [traits.join(', '), notes].filter(Boolean).join(' — ');
      lines.push(desc ? `- ${name} — ${desc}` : `- ${name}`);
    }
    return lines.join('\n');
  }

  /* message builders (language + cast resolved here) */
  async langInfo(sample) {
    const lang = (this.settings.language || '').trim();
    return { lang, isEs: lang ? isSpanishLang(lang) : detectSpanish(sample) };
  }
  async continueMessages({ draft, recent, location, mode }) {
    const { lang, isEs } = await this.langInfo(`${draft} ${recent}`);
    return buildContinueMessages({ draft, recent, location, cast: await this.getCast(), mode, lang, isEs });
  }
  async proseMessages({ draft, recent, location }) {
    const { lang, isEs } = await this.langInfo(`${draft} ${recent}`);
    return buildProseMessages({ draft, recent, location, cast: await this.getCast(), lang, isEs });
  }

  /* jobs */
  startJob() {
    if (this.job) { new Notice('Scene Draft: a generation is already running.'); return null; }
    const ctrl = new AbortController();
    this.job = { ctrl };
    this.statusEl.setText('✦ Scene Draft: writing… (click to stop)');
    this.statusEl.style.display = '';
    this.getPanels().forEach((p) => p.setBusy(true));
    return ctrl;
  }
  endJob() {
    this.job = null;
    this.statusEl.style.display = 'none';
    this.getPanels().forEach((p) => p.setBusy(false));
  }
  cancel() { if (this.job) this.job.ctrl.abort(); }
  reportError(e, ctrl) {
    if (ctrl.signal.aborted || e.name === 'AbortError') new Notice('Scene Draft: stopped.');
    else new Notice('Scene Draft: ' + (e.message || e), 9000);
  }

  /* generate straight into the note, streaming over [from, to] */
  async streamInto(editor, from, to, prefix, suffix, messages) {
    const ctrl = this.startJob();
    if (!ctrl) return;
    const original = to > from ? editor.getRange(editor.offsetToPos(from), editor.offsetToPos(to)) : '';
    let curLen = to - from;
    let wrote = false;
    const apply = (t) => {
      const out = prefix + t + suffix;
      editor.replaceRange(out, editor.offsetToPos(from), editor.offsetToPos(from + curLen));
      curLen = out.length;
      wrote = true;
    };
    try {
      const final = await complete(this.settings, messages, (_, full) => apply(full), ctrl.signal);
      apply(cleanOutput(final));
    } catch (e) {
      // Replace mode: never lose the user's beats on failure/cancel.
      if (original && wrote) editor.replaceRange(original, editor.offsetToPos(from), editor.offsetToPos(from + curLen));
      this.reportError(e, ctrl);
    } finally {
      this.endJob();
    }
  }

  async generateProse({ editor, beats, ctxEnd, rFrom, rTo, location }) {
    const text = editor.getValue();
    const recent = contextBefore(text, ctxEnd, this.settings.contextWords);
    const messages = await this.proseMessages({ draft: beats, recent, location });
    const insertion = rFrom === rTo;
    const head = text.slice(0, rFrom);
    const prefix = insertion && rFrom > 0 ? (head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n') : '';
    const next = text.charAt(rTo);
    const suffix = insertion && next && next !== '\n' ? '\n\n' : '';
    await this.streamInto(editor, rFrom, rTo, prefix, suffix, messages);
  }

  /* commands */
  async cmdProse(editor, view) {
    const src = this.getSource(editor);
    if (!src) { new Notice('Scene Draft: select your beats (or put the cursor inside a block of beats).'); return; }
    const replace = this.settings.proseMode === 'replace';
    await this.generateProse({
      editor,
      beats: src.text,
      ctxEnd: src.from,
      rFrom: replace ? src.from : src.to,
      rTo: src.to,
      location: this.frontmatterLocation(view),
    });
  }

  async cmdContinue(editor, view, mode) {
    const src = this.getSource(editor);
    if (!src) { new Notice('Scene Draft: select your beats (or put the cursor inside a block of beats).'); return; }
    const text = editor.getValue();
    const recent = contextBefore(text, src.from, this.settings.contextWords);
    const messages = await this.continueMessages({ draft: src.text, recent, location: this.frontmatterLocation(view), mode });
    const next = text.charAt(src.to);
    await this.streamInto(editor, src.to, src.to, '\n', next && next !== '\n' ? '\n' : '', messages);
  }
}

/* ───────────────────────── Workspace panel ───────────────────────── */

class SceneDraftView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.curPath = null;
    this.mode = plugin.settings.defaultSceneMode;
    this.saveTimer = null;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Scene Draft'; }
  getIcon() { return 'pen-line'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('scene-draft-panel');

    this.labelEl = root.createDiv({ cls: 'sd-label' });
    this.locEl = root.createEl('input', { cls: 'sd-location', type: 'text', attr: { placeholder: '📍 Location (optional) — e.g. rooftop, pouring rain' } });
    this.padEl = root.createEl('textarea', {
      cls: 'sd-pad',
      attr: { placeholder: 'Write your scene beats here…\n\nMARA: You were never here.\n@ She slides the envelope across the table.\n[MARA: He knows.]\n( rain hammering the skylight )' },
    });
    this.locEl.addEventListener('input', () => this.save());
    this.padEl.addEventListener('input', () => this.save());

    const modeRow = root.createDiv({ cls: 'sd-row' });
    modeRow.createSpan({ cls: 'sd-muted', text: '➤ Continue writes:' });
    this.modeBtns = {};
    for (const [m, label, tip] of [
      ['dialogue', '💬 Lines', 'Only spoken dialogue lines (NAME: format)'],
      ['action', '⚡ Action', 'Only action beats (@ format)'],
      ['mixed', '🌀 Mixed', 'Dialogue, action and thoughts interleaved'],
    ]) {
      const b = modeRow.createEl('button', { text: label, attr: { title: tip } });
      b.addEventListener('click', () => { if (this.plugin.job) return; this.mode = m; this.paintModes(); this.save(); });
      this.modeBtns[m] = b;
    }

    const r1 = root.createDiv({ cls: 'sd-row' });
    this.continueBtn = r1.createEl('button', { text: '➤ Continue', cls: 'mod-cta sd-grow', attr: { title: 'Have the AI write more raw beats into this pad' } });
    this.proseBtn = r1.createEl('button', { text: '✦ Send as prose', cls: 'sd-grow', attr: { title: 'Turn the whole pad into prose and insert it at the cursor in the note' } });
    this.stopBtn = r1.createEl('button', { text: '■ Stop', cls: 'sd-hidden' });

    const r2 = root.createDiv({ cls: 'sd-row' });
    this.rawBtn = r2.createEl('button', { text: '⤴ Send raw', attr: { title: 'Insert the pad text at the cursor exactly as written' } });
    this.pullBtn = r2.createEl('button', { text: '❝ Pull selection', attr: { title: 'Copy the note selection into the pad' } });
    this.clearBtn = r2.createEl('button', { text: 'Clear' });

    root.createDiv({ cls: 'sd-muted', text: 'Beats stay raw here. Saved per note. Tip: you can also select beats in a note and run the “Turn selected beats into prose” / “Continue beats” commands without opening this panel.' });

    this.continueBtn.addEventListener('click', () => this.onContinue());
    this.proseBtn.addEventListener('click', () => this.onProse());
    this.stopBtn.addEventListener('click', () => this.plugin.cancel());
    this.rawBtn.addEventListener('click', () => this.onRaw());
    this.pullBtn.addEventListener('click', () => this.pullSelection(false));
    this.clearBtn.addEventListener('click', () => {
      if (this.padEl.value && !window.confirm('Clear this draft?')) return;
      this.padEl.value = '';
      this.save();
    });

    this.curPath = null;
    this.refresh();
    this.setBusy(!!this.plugin.job);
  }

  async onClose() { this.flush(); }

  paintModes() {
    for (const [m, b] of Object.entries(this.modeBtns)) b.toggleClass('sd-active', m === this.mode);
  }

  setBusy(busy) {
    if (!this.continueBtn) return;
    [this.continueBtn, this.proseBtn, this.rawBtn, this.pullBtn, this.clearBtn].forEach((b) => { b.disabled = busy; });
    this.stopBtn.toggleClass('sd-hidden', !busy);
  }

  refresh() {
    if (!this.padEl) return;
    const file = this.plugin.lastMd && this.plugin.lastMd.file;
    const path = file ? file.path : '';
    if (path === this.curPath) return;
    this.flush();
    this.curPath = path;
    const d = (path && this.plugin.settings.drafts[path]) || {};
    this.padEl.value = d.text || '';
    this.locEl.value = d.location ?? (file ? this.plugin.frontmatterLocation(this.plugin.lastMd) : '');
    this.mode = d.mode || this.plugin.settings.defaultSceneMode;
    this.labelEl.setText(file ? `Scene Draft — ${file.basename}` : 'Scene Draft — open a note to begin');
    this.paintModes();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 600);
  }
  flush() {
    clearTimeout(this.saveTimer);
    if (!this.curPath || !this.padEl) return;
    const text = this.padEl.value;
    const location = this.locEl.value;
    if (!text.trim() && !location.trim()) delete this.plugin.settings.drafts[this.curPath];
    else this.plugin.settings.drafts[this.curPath] = { text, location, mode: this.mode };
    this.plugin.saveSettings();
  }

  pullSelection(quiet) {
    const ed = this.plugin.targetEditor(!quiet);
    if (!ed) return;
    const sel = ed.getSelection();
    if (!sel.trim()) { if (!quiet) new Notice('Scene Draft: select some text in the note first.'); return; }
    this.padEl.value = this.padEl.value.trim() ? this.padEl.value.replace(/\s*$/, '\n\n') + sel : sel;
    this.save();
  }

  async onContinue() {
    const p = this.plugin;
    const ed = p.targetEditor(false);
    const recent = ed ? contextBefore(ed.getValue(), ed.posToOffset(ed.getCursor('from')), p.settings.contextWords) : '';
    const draft = this.padEl.value.trim();
    const ctrl = p.startJob();
    if (!ctrl) return;
    const base = draft ? draft + '\n' : '';
    try {
      const messages = await p.continueMessages({ draft, recent, location: this.locEl.value, mode: this.mode });
      const final = await complete(p.settings, messages, (_, full) => {
        this.padEl.value = base + full;
        this.padEl.scrollTop = this.padEl.scrollHeight;
      }, ctrl.signal);
      this.padEl.value = base + cleanOutput(final);
    } catch (e) {
      p.reportError(e, ctrl);
    } finally {
      p.endJob();
      this.save();
    }
  }

  async onProse() {
    const beats = this.padEl.value.trim();
    if (!beats) { new Notice('Scene Draft: the pad is empty.'); return; }
    const ed = this.plugin.targetEditor();
    if (!ed) return;
    const off = ed.posToOffset(ed.getCursor('to'));
    await this.plugin.generateProse({ editor: ed, beats, ctxEnd: off, rFrom: off, rTo: off, location: this.locEl.value });
  }

  onRaw() {
    const text = this.padEl.value.trim();
    if (!text) { new Notice('Scene Draft: the pad is empty.'); return; }
    const ed = this.plugin.targetEditor();
    if (!ed) return;
    const full = ed.getValue();
    const off = ed.posToOffset(ed.getCursor('to'));
    const head = full.slice(0, off);
    const gap = off > 0 ? (head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n') : '';
    ed.replaceRange(gap + text, ed.offsetToPos(off));
  }
}

/* ───────────────────────── Settings tab ───────────────────────── */

class SceneDraftSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName('AI provider').addDropdown((d) => {
      for (const [id, cfg] of Object.entries(PROVIDERS)) d.addOption(id, cfg.name);
      d.setValue(s.provider).onChange(async (v) => { s.provider = v; await this.plugin.saveSettings(); this.display(); });
    });

    const cfg = PROVIDERS[s.provider];

    new Setting(containerEl)
      .setName(`${cfg.name} API key`)
      .setDesc('Stored in this vault\'s plugin data (data.json). Keep that file out of any public sync/repo.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder(s.provider === 'custom' ? '(optional)' : 'sk-…')
          .setValue(s.keys[s.provider] || '')
          .onChange(async (v) => { s.keys[s.provider] = v.trim(); await this.plugin.saveSettings(); });
      });

    if (s.provider === 'custom') {
      new Setting(containerEl).setName('Endpoint').setDesc('Full chat-completions URL.').addText((t) =>
        t.setValue(s.customEndpoint).onChange(async (v) => { s.customEndpoint = v.trim(); await this.plugin.saveSettings(); }));
    }

    new Setting(containerEl).setName('Model').setDesc(cfg.hint).addText((t) =>
      t.setPlaceholder(cfg.defaultModel || 'model name')
        .setValue(s.models[s.provider] || '')
        .onChange(async (v) => { s.models[s.provider] = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Temperature').setDesc('Higher = more surprising beats.').addSlider((sl) =>
      sl.setLimits(0, 1.5, 0.05).setValue(s.temperature).setDynamicTooltip()
        .onChange(async (v) => { s.temperature = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Max output tokens').addText((t) =>
      t.setValue(String(s.maxTokens)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (n > 0) { s.maxTokens = n; await this.plugin.saveSettings(); }
      }));

    new Setting(containerEl).setName('Output language')
      .setDesc('Leave blank to auto-detect (Spanish is detected from your text and switches on raya dialogue). Or type e.g. "English", "español rioplatense (voseo)".')
      .addText((t) => t.setPlaceholder('auto').setValue(s.language).onChange(async (v) => { s.language = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Characters folder')
      .setDesc('Notes in this folder are the cast. Optional frontmatter: name, traits (list), notes, enabled: false. Otherwise the file name and the first 80 characters of the note are used. Leave empty to disable.')
      .addText((t) => t.setValue(s.charactersFolder).onChange(async (v) => { s.charactersFolder = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Context words')
      .setDesc('How much prose before your beats is sent as scene context / style reference.')
      .addText((t) => t.setValue(String(s.contextWords)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (n >= 0) { s.contextWords = n; await this.plugin.saveSettings(); }
      }));

    new Setting(containerEl).setName('Beats → prose placement')
      .setDesc('When you run the command on a selection.')
      .addDropdown((d) => d.addOption('after', 'Insert prose after the beats (keep beats)').addOption('replace', 'Replace the beats with prose')
        .setValue(s.proseMode).onChange(async (v) => { s.proseMode = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Default continue mode')
      .setDesc('Used by the right-click “continue beats” item and as the panel default.')
      .addDropdown((d) => d.addOption('mixed', '🌀 Mixed').addOption('dialogue', '💬 Lines').addOption('action', '⚡ Action')
        .setValue(s.defaultSceneMode).onChange(async (v) => { s.defaultSceneMode = v; await this.plugin.saveSettings(); }));
  }
}

module.exports = SceneDraftPlugin;
module.exports.__test = { detectSpanish, contextBefore, cleanOutput, buildContinueMessages, buildProseMessages, complete, PROVIDERS };
