// ============================================================
// AI Data Analyst Assistant — Netlify Function (API proxy)
// Proxies requests to the Anthropic Claude API and keeps the
// API key off the client. Two modes: 'analyze' and 'chat'.
// ============================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ============================================================
// System prompts
// ============================================================

const ANALYZE_SYSTEM_PROMPT = `You are a senior business data analyst. Your job is to look at a dataset summary and produce an executive briefing for a non-technical business owner.

You MUST respond with a single valid JSON object — no prose, no markdown fences. The schema:

{
  "summary": "A 3-5 sentence executive summary in plain business language. Lead with the most important insight (revenue, top performer, anomaly, trend). Reference real numbers from the data. Avoid technical jargon.",
  "charts": [
    {
      "type": "bar" | "line" | "pie" | "doughnut",
      "title": "Concise chart title",
      "labels": ["label1", "label2", ...],
      "datasets": [
        { "label": "Series name", "data": [number, number, ...] }
      ]
    }
  ],
  "suggestions": ["Short follow-up question 1", "Short follow-up question 2", "Short follow-up question 3", "Short follow-up question 4"]
}

CHART RULES:
- Generate 3 to 4 charts that tell the most interesting story in the data.
- Pick chart types thoughtfully:
  - bar: comparing categories (top products, regions, etc.)
  - line: trends over time (use only when there is a date column)
  - pie / doughnut: composition / share of total (use sparingly, max 1)
- Use real values computed from the sample rows and column statistics provided.
- Limit each chart to at most 12 labels — group small categories as "Other" if needed.
- Round numbers sensibly (no more than 2 decimals).
- Chart titles should be insight-led ("Revenue by Region — West leads"), not descriptive ("Region vs Revenue").
- The "labels" array length MUST match the "data" array length in every dataset.

SUMMARY RULES:
- 3-5 sentences. Plain English. No bullet points.
- Lead with the biggest finding. Quantify it.
- If you spot an anomaly, concentration risk, or trend, call it out.
- Do not hedge with phrases like "the data appears to show". Be direct.

SUGGESTIONS RULES:
- 4 short, specific questions a business owner would actually ask about THIS dataset.
- Each under 12 words. Reference real columns / categories from the data.

Return ONLY the JSON object. No code fences. No commentary before or after.`;

const CHAT_SYSTEM_PROMPT = `You are a senior business data analyst answering follow-up questions about a specific dataset the user has uploaded. The data summary, column statistics, and a sample of rows are provided in the user message.

Rules:
- Answer in plain business English. 2-4 sentences unless the question genuinely demands more.
- Reference specific numbers from the data — never speak in generalities.
- If the answer requires aggregation across the full dataset, compute it from the sample and statistics provided. State your reasoning briefly.
- If the data does not contain enough information to answer confidently, say so directly and suggest what would be needed.
- Do not invent columns or values. Stick to what is in the dataset.
- No markdown headers, no bullet lists unless the answer is genuinely a list. Conversational tone.`;

// ============================================================
// Handler
// ============================================================

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'Server misconfigured: ANTHROPIC_API_KEY is not set.');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonError(400, 'Invalid JSON in request body.');
  }

  const { mode, dataSummary, history } = payload;
  if (!mode || !dataSummary) {
    return jsonError(400, 'Missing required fields: mode, dataSummary.');
  }

  try {
    if (mode === 'analyze') {
      return await runAnalyze(apiKey, dataSummary);
    }
    if (mode === 'chat') {
      if (!Array.isArray(history) || history.length === 0) {
        return jsonError(400, 'Chat mode requires a non-empty history array.');
      }
      return await runChat(apiKey, dataSummary, history);
    }
    return jsonError(400, `Unknown mode: ${mode}`);
  } catch (err) {
    console.error('Handler error:', err);
    return jsonError(500, err.message || 'Unexpected server error.');
  }
};

// ============================================================
// Mode: analyze (initial summary + charts)
// ============================================================

async function runAnalyze(apiKey, dataSummary) {
  const userMessage = buildDataContextMessage(dataSummary) +
    '\n\nProduce the executive briefing now. Return ONLY the JSON object described in your instructions.';

  const response = await callClaude(apiKey, {
    system: ANALYZE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 2500,
    temperature: 0.3,
  });

  const text = extractText(response);
  const parsed = parseJsonOutput(text);

  if (!parsed) {
    return jsonError(502, 'The AI returned an unexpected format. Please try again.');
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      summary: parsed.summary || '',
      charts: Array.isArray(parsed.charts) ? parsed.charts : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    }),
  };
}

// ============================================================
// Mode: chat (follow-up Q&A)
// ============================================================

async function runChat(apiKey, dataSummary, history) {
  // Build conversation. Inject data context as a cached prefix on the first user turn.
  const dataContext = buildDataContextMessage(dataSummary);

  // Convert history into Claude messages. Prefix the first user message with the data context.
  const messages = history.map((m, i) => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (i === 0 && role === 'user') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: dataContext,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: `\n\nQuestion: ${m.content}`,
          },
        ],
      };
    }
    return { role, content: m.content };
  });

  const response = await callClaude(apiKey, {
    system: CHAT_SYSTEM_PROMPT,
    messages,
    max_tokens: 1024,
    temperature: 0.4,
  });

  const reply = extractText(response).trim();

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ reply }),
  };
}

// ============================================================
// Build the structured data context string sent to Claude
// ============================================================

function buildDataContextMessage(dataSummary) {
  const { rowCount, columnCount, columns = [], sampleRows = [] } = dataSummary;

  const colLines = columns.map(c => {
    const parts = [`- ${c.name} (${c.type})`];
    if (c.type === 'number' && c.mean !== undefined) {
      parts.push(`min=${fmt(c.min)}, max=${fmt(c.max)}, mean=${fmt(c.mean)}, sum=${fmt(c.sum)}`);
    } else if (c.type === 'string' && c.topValues) {
      parts.push(`unique=${c.uniqueCount}, top: ` +
        c.topValues.slice(0, 5).map(v => `${v.value}(${v.count})`).join(', '));
    } else if (c.type === 'date' && c.minDate) {
      parts.push(`range: ${c.minDate} to ${c.maxDate}`);
    }
    return parts.join(' — ');
  }).join('\n');

  // Cap sample rows + serialize compactly to keep token usage reasonable.
  const cappedSample = sampleRows.slice(0, 50);

  return `DATASET CONTEXT
Rows: ${rowCount}
Columns: ${columnCount}

Column statistics:
${colLines}

Sample rows (up to 50, JSON):
${JSON.stringify(cappedSample, null, 2)}`;
}

function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return 'n/a';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return Number(n.toFixed(2)).toString();
}

// ============================================================
// Claude API call
// ============================================================

async function callClaude(apiKey, body) {
  const requestBody = { model: MODEL, ...body };
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    let parsedErr;
    try { parsedErr = JSON.parse(errText); } catch (e) {}
    const message = parsedErr?.error?.message || errText || `Anthropic API error ${res.status}`;
    throw new Error(`Claude API: ${message}`);
  }

  return res.json();
}

function extractText(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

// ============================================================
// JSON output parsing — tolerant of stray fences or whitespace
// ============================================================

function parseJsonOutput(text) {
  if (!text) return null;
  // Strip markdown code fences if the model added them despite instructions
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // Find the first {...} block
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (e) {
    console.error('JSON parse failed:', e.message, '\nText was:', cleaned.slice(0, 500));
    return null;
  }
}

// ============================================================
// Error helper
// ============================================================

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}
