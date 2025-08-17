# My AI Agent

A fully functional AI-powered chat application with a FastAPI backend and a React frontend. The backend uses the Gemini AI API for conversational responses and integrates with `ddgs` for web searches to provide answers with citations. The frontend features a sleek Tailwind CSS interface with real-time streaming responses.

## Features
- **Conversational AI**: Powered by Gemini 2.5 Flash for natural, markdown-formatted responses.
- **Web Search**: Integrates `ddgs` for search-based queries with formatted citations (e.g., `[source: url]`).
- **Real-time Streaming**: Uses WebSocket for streaming AI responses.
- **Sleek UI**: Built with React and Tailwind CSS, featuring blue user bubbles and gray AI bubbles.
- **Cross-Origin Support**: CORS-enabled for seamless frontend-backend communication.

## Prerequisites
- **Python 3.13+**: For the backend.
- **Node.js 18+**: For the frontend.
- **Yarn**: Preferred package manager for the frontend.
- **Gemini AI API Key**: Obtain from [Google AI Studio](https://aistudio.google.com/app/apikey).

## Setup

### Backend Setup
1. **Navigate to the backend directory**:
   ```bash
   cd backend
   ```
2. **Create and activate a virtual environment**:
   ```bash
   python -m venv venv
   .\venv\Scripts\activate  # Windows
   source venv/bin/activate  # macOS/Linux
   ```
3. **Install dependencies**:
   ```bash
   pip install fastapi uvicorn python-dotenv google-generativeai ddgs
   ```
4. **Set up environment variables**:
   Create a `.env` file in `backend/`:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
   Obtain the key from [Google AI Studio](https://aistudio.google.com/app/apikey).
5. **Run the backend**:
   ```bash
   uvicorn app:app --reload
   ```
   The server runs on `http://localhost:8000`. Test with:
   ```bash
   curl http://localhost:8000/chat/test
   ```

### Frontend Setup
1. **Navigate to the frontend directory**:
   ```bash
   cd frontend
   ```
2. **Install Yarn (if not installed)**:
   ```bash
   npm install -g yarn
   ```
3. **Clean dependencies**:
   Remove any conflicting lock files and modules:
   ```bash
   del yarn.lock package-lock.json
   rmdir /s /q node_modules
   ```
4. **Install dependencies**:
   ```bash
   yarn add react react-dom react-markdown tailwindcss postcss autoprefixer @tailwindcss/forms
   ```
   If `@types/react-markdown` fails to install due to 404 errors, create `src/types/react-markdown.d.ts`:
   ```ts
   declare module 'react-markdown';
   ```
   Update `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "es5",
       "lib": ["dom", "dom.iterable", "esnext"],
       "allowJs": true,
       "skipLibCheck": true,
       "esModuleInterop": true,
       "allowSyntheticDefaultImports": true,
       "strict": true,
       "module": "esnext",
       "moduleResolution": "node",
       "resolveJsonModule": true,
       "isolatedModules": true,
       "noEmit": true,
       "jsx": "react-jsx"
     },
     "include": ["src", "src/types"]
   }
   ```
5. **Run the frontend**:
   ```bash
   yarn start
   ```
   Open `http://localhost:3000` in your browser.

## Usage
1. **Open the frontend**: Visit `http://localhost:3000`.
2. **Interact with the AI**:
   - **Conversational queries**: Enter "Tell me a joke" to get a conversational response.
   - **Search-based queries**: Enter "What’s new in AI agents?" to get markdown-formatted responses with citations.
3. **Features**:
   - Responses stream in real-time via WebSocket.
   - User messages appear in blue bubbles (right), AI responses in gray bubbles (left).
   - Markdown rendering (if `react-markdown` is used) for bold, links, and citations.

## Project Structure
```
MY AI AGENT/
├── backend/
│   ├── app.py               # FastAPI backend with Gemini API and ddgs
│   ├── .env                # Environment variables (GEMINI_API_KEY)
│   └── venv/               # Python virtual environment
├── frontend/
│   ├── src/
│   │   ├── App.tsx         # Main React component
│   │   ├── index.css       # Tailwind CSS styles
│   │   └── types/          # TypeScript declarations (e.g., react-markdown.d.ts)
│   ├── package.json        # Frontend dependencies
│   ├── tailwind.config.js  # Tailwind CSS configuration
│   └── tsconfig.json       # TypeScript configuration
└── README.md               # This file
```

## Troubleshooting
- **Backend: `PermissionDeniedError` (403)**:
  - Ensure the `GEMINI_API_KEY` in `.env` is valid.
  - Verify API key limits in [Google AI Studio](https://aistudio.google.com/app/apikey).
  - Test with:
    ```bash
    python -c "import google.generativeai as genai; genai.configure(api_key='your_key'); model=genai.GenerativeModel('gemini-2.5-flash'); print(model.generate_content('test').text)"
    ```
- **Backend: `duckduckgo_search` warning**:
  - Ensure `ddgs` is installed (`pip install ddgs`).
  - Verify `app.py` uses `from duckduckgo_search import DDGS`.
- **Frontend: `Cannot find module '@tailwindcss/forms'`**:
  - Run `yarn add @tailwindcss/forms`.
  - If it fails, remove from `tailwind.config.js`:
    ```js
    module.exports = {
      content: ["./src/**/*.{js,jsx,ts,tsx}"],
      theme: { extend: {} },
      plugins: [],
    };
    ```
- **Frontend: `TS2307: Cannot find module 'react-markdown'`**:
  - Create `src/types/react-markdown.d.ts` with `declare module 'react-markdown';`.
  - Alternatively, use the fallback `App.tsx` without `react-markdown` (see project history).
- **Network issues (404 errors for npm/Yarn)**:
  - Switch to a personal Wi-Fi or hotspot.
  - Test connectivity: `curl https://registry.npmjs.org/@tailwindcss/forms`.
  - Manually download packages (e.g., https://registry.npmjs.org/@tailwindcss/forms/-/forms-0.5.9.tgz) and install:
    ```bash
    yarn add ./forms-0.5.9.tgz
    ```

## Enhancements
- **Chat History**:
  Add to `frontend/src/App.tsx`:
  ```tsx
  useEffect(() => {
    const saved = localStorage.getItem('messages');
    if (saved) setMessages(JSON.parse(saved));
  }, []);
  useEffect(() => {
    localStorage.setItem('messages', JSON.stringify(messages));
  }, [messages]);
  ```
- **Animations**:
  ```bash
  yarn add framer-motion
  ```
  ```tsx
  import { motion } from 'framer-motion';
  // In messages map:
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    key={idx}
    className={`max-w-lg ${msg.role === 'user' ? 'ml-auto bg-blue-600' : 'mr-auto bg-gray-700'} p-3 rounded-lg`}
  >
    <ReactMarkdown>{msg.content}</ReactMarkdown>
  </motion.div>
  ```
- **Voice Input**: Add Web Speech API for voice queries.
- **Deployment**:
  - Backend: Deploy to Vercel.
  - Frontend: Deploy to Netlify.

## Contributing
Contributions are welcome! Please submit a pull request or open an issue on the project repository.

## License
MIT License. See [LICENSE](LICENSE) for details.