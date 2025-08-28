## MY AI AGENT

An end-to-end AI chat application with a FastAPI backend (Gemini) and a React + Tailwind frontend. It supports realtime streaming over WebSockets, Markdown rendering (with fenced code blocks), chat history with rename/delete, copy-to-clipboard, and in-place prompt editing that regenerates the paired AI response.

Streaming is implemented via WebSockets with incremental token rendering, automatic reconnection with exponential backoff, and a Stop control to cancel an in-progress response.

### Features
- **Realtime streaming** responses via WebSocket (token-by-token)
- **Markdown rendering** with fenced code blocks (inline and block styles)
- **Chat history drawer** (left side) with create, select, **rename**, and **delete**
- **Copy** any message (code or text) with one click
- **Edit** any previous user prompt in-place; the AI response beneath it is regenerated
- **Search-aware prompting** (optional) using Google search results when relevant

### Tech Stack
- Backend: FastAPI, Google Gemini (`google-generativeai`), Google Search
- Frontend: React (CRA), TypeScript, TailwindCSS, `react-markdown`

### Prerequisites
- Node.js 18+ and Yarn (or npm)
- Python 3.10+
- A Google Gemini API key
- Google Custom Search: API key and CSE ID

### Project Structure
```
MY AI AGENT/
  backend/
    app.py
    requirements.txt
    vercel.json
  frontend/
    src/...
    package.json
    tailwind.config.js
    vercel.json
  README.md (this file)
```

### Backend Setup
1. Create and populate `.env` in `backend/`:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   GOOGLE_API_KEY=your_google_api_key_here
   GOOGLE_CSE_ID=your_cse_id_here
   ```
2. Install dependencies and run the API:
   ```bash
   cd backend
   pip install -r requirements.txt
   uvicorn app:app --host 0.0.0.0 --port 8000 --reload
   ```
   OCR prerequisites:
   - Install Tesseract OCR on your system and ensure the `tesseract` binary is on PATH.
     - Windows: download installer from `https://github.com/UB-Mannheim/tesseract/wiki` and reboot shell.
     - macOS: `brew install tesseract`.
     - Linux (Debian/Ubuntu): `sudo apt-get install tesseract-ocr`.
   - For PDFs, we use PyMuPDF to read embedded text and rasterize pages for OCR fallback.
3. Endpoints
   - WebSocket: `ws://localhost:8000/ws/chat`
   - Test (HTTP): `GET http://localhost:8000/chat/{query}`

Notes:
- Backend enforces Markdown output with fenced code blocks for better rendering.
- CORS is configured for `http://localhost:3000` and the provided Vercel domain.

### Frontend Setup
1. Install and run:
   ```bash
   cd frontend
   yarn
   yarn start
   ```
2. Logo assets
   - Place images in `frontend/public/` with these names:
     - `jenny-logo.png` and retina `jenny-logo@2x.png`
     - `jenny-logo-dark.png` and retina `jenny-logo-dark@2x.png` (for dark mode)
   - The app will automatically pick light/dark and high-res variants.

3. WebSocket URL is resolved dynamically at runtime:
   - Default: same origin as the frontend (`ws://host/ws/chat` or `wss://host/ws/chat`).
   - Override by setting `REACT_APP_WS_URL` at build time or `window._WS_URL` at runtime.
   - Example: `REACT_APP_WS_URL=wss://api.example.com/ws/chat yarn build`.

4. Controls
   - The UI shows “Thinking…” during generation and provides a Stop button to cancel the stream.
   - On network interruptions, the client auto-reconnects with exponential backoff.

### Usage Tips
- Open the left "History" menu to switch sessions, rename, or delete.
- Hover a message to copy it; for user prompts, you can also edit them in-place.
- Editing a user prompt regenerates only the AI message directly beneath it.

### Deploy
- Backend: `backend/vercel.json` is included; you can deploy to Vercel or your preferred host supporting FastAPI. Ensure WebSocket upgrades are allowed.
- Frontend: `frontend/vercel.json` is included for Vercel static hosting. Use `REACT_APP_WS_URL` to point to your backend WebSocket (use `wss://` on HTTPS sites).

### Troubleshooting
- If code shows as one paragraph, ensure the backend is running and that responses include fenced code blocks. The backend prompt template already enforces this.
- WebSocket connection errors: verify the backend is reachable, origin/CORS are correct, and use `wss://` from HTTPS pages. You can temporarily set `window._WS_URL = 'ws://localhost:8000/ws/chat'` in the browser console to override.
- Gemini auth errors: confirm `GEMINI_API_KEY` is set and valid.

### License
This project is provided as-is, without warranty. Adapt and use it as you like.


