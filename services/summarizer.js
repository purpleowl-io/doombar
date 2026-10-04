'use strict';
// Email summaries via the Claude API. Haiku-class model by default (config
// email.summaryModel) - three sentences do not need more. Summaries are cached
// by message ID so nothing is summarised twice. Email bodies are never logged.
const secrets = require('../main/secrets');
const { scoped } = require('../main/log');

const log = scoped('summarizer');

// email.summaryContext (optional) says who the reader is, e.g. "The reader runs a small consultancy."
const SYSTEM = `You summarise incoming business email for the reader of this inbox.
Write two or three short sentences in plain text: what the sender wants, any deadline or date mentioned, and what they are asking the reader to do.
No preamble, no bullet points, no quoting. If the email needs no action, say so in the last sentence.`;

const QUOTE_MARKERS = [
  /^On .{5,120} wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/mi,
  /^_{10,}\s*$/m,
  /^From:\s.+\nSent:\s.+/m,
  /^From:\s.+\nTo:\s.+/m,
  /^Le .{5,120} a écrit\s*:\s*$/m,
];
const SIG_MARKERS = [
  /^--\s*$/m,
  /^Sent from my (iPhone|iPad|Galaxy|Android|mobile)/mi,
  /^Get Outlook for (iOS|Android)/mi,
  /^(Best|Kind|Warm) regards,?\s*$/mi,
  /^(Thanks|Thank you|Cheers|Best|Regards|Sincerely),?\s*$/mi,
];

function stripQuotesAndSignature(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  // Drop everything from the first quote marker onwards.
  let cut = t.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  // Remove leading '>' quoted lines that survived.
  t = t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  // Signature: only cut if the marker is in the back half so a short "Thanks," reply is kept.
  for (const re of SIG_MARKERS) {
    const m = re.exec(t);
    if (m && m.index > t.length * 0.4) t = t.slice(0, m.index);
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

class Summarizer {
  constructor({ db, model = 'claude-haiku-4-5', maxInputChars = 12000, context = '' } = {}) {
    this.db = db;
    this.system = context ? `${SYSTEM}\n${context}` : SYSTEM;
    this.model = model;
    this.maxInputChars = maxInputChars;
    this._client = null;
  }

  available() { return !!secrets.get('ANTHROPIC_API_KEY'); }

  client() {
    if (this._client) return this._client;
    const apiKey = secrets.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured (run npm run setup)');
    const Anthropic = require('@anthropic-ai/sdk');
    this._client = new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 });
    return this._client;
  }

  cached(messageId) {
    if (!this.db) return null;
    const row = this.db.get('SELECT summary FROM email_summaries WHERE message_id = ?', messageId);
    return row ? row.summary : null;
  }

  /**
   * @param {{id:string, from:string, subject:string, date?:string, body:string}} msg
   * @returns {Promise<string>}
   */
  async summarize(msg) {
    const hit = this.cached(msg.id);
    if (hit) return hit;

    const body = stripQuotesAndSignature(msg.body);
    const clipped = body.length > this.maxInputChars
      ? body.slice(0, this.maxInputChars) + '\n[… truncated …]'
      : body;
    const prompt = `From: ${msg.from || ''}\nSubject: ${msg.subject || ''}\n${msg.date ? `Date: ${msg.date}\n` : ''}\n${clipped || '(empty body)'}`;

    const Anthropic = require('@anthropic-ai/sdk');
    let response;
    try {
      response = await this.client().messages.create({
        model: this.model,
        max_tokens: 300,
        system: this.system,
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude API key rejected');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Claude API rate limited, try again shortly');
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status}: ${e.message}`);
      throw e;
    }

    if (response.stop_reason === 'refusal') throw new Error('Claude declined to summarise this message');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new Error('empty summary');

    if (this.db) {
      this.db.run(
        'INSERT OR REPLACE INTO email_summaries (message_id, summary, model, created_at) VALUES (?, ?, ?, ?)',
        msg.id, text, this.model, Date.now(),
      );
    }
    log.info(`summarised message ${msg.id} (${response.usage.input_tokens} in / ${response.usage.output_tokens} out)`);
    return text;
  }
}

module.exports = { Summarizer, stripQuotesAndSignature };
