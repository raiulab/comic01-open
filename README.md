# Comic01 Open

A local-first workflow for planning, generating, editing, and exporting four-panel comics.

The public edition contains only application code and neutral example settings. Character art,
private story bibles, generated images, databases, and generation history are intentionally kept
outside the repository.

## Features

- Calendar-based episode management
- Configurable series concept and visual style
- Character reference registration
- Four-panel structure suggestions
- Gemini or OpenAI image generation
- Panel regeneration and masked inpainting
- Speech-text overlay fallback without another generation request
- Vertical or 2x2 image export

## Stack

- React 18, Vite, and Tailwind CSS
- Node.js and Express
- SQLite
- Sharp and node-canvas
- Google Gemini and optional OpenAI image APIs

## Quick start

Requirements: Node.js 22 or later, npm, and the native prerequisites required by
`canvas` on your platform.

```bash
npm install
cp .env.example .env
# Add at least GOOGLE_API_KEY to .env
npm run dev:server
```

In a second terminal:

```bash
npm run dev
```

Open <http://localhost:5173>. The API server listens on port `8000` by default.

## Checks

```bash
npm test
npm run build
```

Tests cover prompt normalization, structure templates, and speech extraction. API calls are not
performed by the test suite.

## Configuration

- `config/series-concept.json`: neutral sample series settings
- `config/image-style.json`: selectable visual-style prompts
- `config/serif-font.json`: optional local font path for speech overlays

Runtime content is stored in ignored directories:

- `db/`
- `uploads/`
- `generated/`
- `output/`

Do not commit private characters, unpublished story settings, API responses, or generated media.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GOOGLE_API_KEY` | Gemini generation and suggestions |
| `OPENAI_API_KEY` | Optional OpenAI image provider |
| `PERPLEXITY_API_KEY` | Optional suggestion provider |
| `IMAGE_PROVIDER` | `gemini` or `openai` |
| `IMAGE_MODEL` | Provider-specific image model |
| `PORT` | API port; defaults to `8000` |

Provider usage may incur charges. Review the selected provider's current pricing and terms before
running generation requests.

## Repository policy

This repository is the reusable application engine, not a content archive. The included concept
is a fictional neutral fixture for local evaluation. Bring your own characters and story settings
through ignored runtime storage.

## License

Code is licensed under the MIT License. Third-party packages, fonts, models, and generated content
remain subject to their respective licenses and service terms. No private character or story IP is
licensed by this repository.
