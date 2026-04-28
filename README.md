# AI Data Analyst Assistant

Browser-based tool that turns any CSV into instant insights using the Anthropic Claude API. Upload a file (or try the bundled e-commerce sample) and get a plain-English executive summary, auto-generated charts, and a chat interface to ask follow-up questions about your data.

**Portfolio Project 5 of 5** — built by Cenred (Cj), April 2026.

## What it does

1. Drag-and-drop a CSV (up to 5MB).
2. Client-side parsing with PapaParse — extracts column types, statistics, and a sample.
3. Sends the structured summary to Claude via a Netlify serverless proxy.
4. Renders an executive summary, 3-4 auto-selected Chart.js visualizations, and suggested follow-up questions.
5. Conversational Q&A over the same dataset, with prompt caching on the data context.

## Stack

- **Frontend:** Vanilla JS + HTML + CSS, single file (`index.html`). No build step.
- **CSV parsing:** [PapaParse](https://www.papaparse.com/) via CDN.
- **Charts:** [Chart.js v4](https://www.chartjs.org/) via CDN.
- **AI:** Anthropic Claude (`claude-sonnet-4-6`) — structured JSON output for the analyze step, conversational text for chat.
- **API proxy:** Netlify serverless function (`netlify/functions/chat.js`).
- **Static hosting:** Hostinger.

## Local development

```bash
# install Netlify CLI once
npm install -g netlify-cli

# run dev server with the function emulated
ANTHROPIC_API_KEY=sk-ant-... netlify dev
```

Open http://localhost:8888 and drop a CSV.

## Deployment

1. Push to GitHub.
2. Connect the repo to Netlify (auto-deploy on push).
3. In Netlify site settings, set environment variable `ANTHROPIC_API_KEY`.
4. Upload `index.html` (and the `data/` folder) to Hostinger if hosting the static page separately, and point its API endpoint at the deployed Netlify function URL.

## File structure

```
ai-data-analyst/
  index.html                  ← entire frontend (HTML + CSS + JS)
  netlify.toml                ← Netlify config
  netlify/functions/chat.js   ← serverless API proxy
  data/sample-ecommerce.csv   ← preloaded demo dataset
  package.json                ← Node version pin for the function
  README.md
  .gitignore
```

## Sample dataset

`data/sample-ecommerce.csv` — 80 rows of fictional e-commerce orders with date, product, category, quantity, price, revenue, region, and customer type. Designed to surface a clear Q4 sales spike and concentration in the West region — easy story for the model to narrate.

## Security

The Anthropic API key never ships to the browser. It is read from `process.env.ANTHROPIC_API_KEY` inside the serverless function. CORS is set to `*` so the static page can be hosted on a different origin (e.g. Hostinger) and still call the Netlify function.
