import os
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from google.generativeai import GenerativeModel, configure
from google.generativeai.types import GenerationConfig
from googleapiclient.discovery import build
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

# Configure Gemini API
configure(api_key=os.getenv("GEMINI_API_KEY"))

app = FastAPI()

# Allow CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://my-ai-agent-frontend.vercel.app"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GOOGLE_CSE_ID = os.getenv("GOOGLE_CSE_ID")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# Helper function for web search via Google Custom Search
def perform_search(query: str, max_results: int = 3):
    if not GOOGLE_API_KEY or not GOOGLE_CSE_ID:
        return "Search unavailable: Google CSE is not configured."
    try:
        service = build("customsearch", "v1", developerKey=GOOGLE_API_KEY)
        res = service.cse().list(q=query, cx=GOOGLE_CSE_ID, num=max_results).execute()
        items = res.get("items", [])
        formatted_results = []
        for idx, item in enumerate(items, 1):
            title = item.get("title", "Untitled")
            snippet = item.get("snippet", "")
            link = item.get("link", "")
            formatted_results.append(
                f"**Result {idx}**:\n- **Title**: {title}\n- **Snippet**: {snippet}\n- **Source**: [{link}]({link})\n"
            )
        return "\n".join(formatted_results) if formatted_results else "No results found."
    except Exception as e:
        logger.error(f"Google CSE error: {e}")
        return "Search unavailable due to an error."

# Helper function for non-streaming query processing
async def process_query_non_streaming(query: str):
    search_keywords = ["what is", "latest", "news", "find", "search"]
    needs_search = any(keyword in query.lower() for keyword in search_keywords)

    if needs_search:
        search_results = perform_search(query)
        prompt = (
            "You are a helpful coding assistant. Always respond in Markdown.\n"
            "- When including code, use fenced code blocks with the correct language tag (e.g., ```python, ```html).\n"
            "- For multi-line code, never inline it; use fenced blocks only.\n"
            "- Keep prose concise; if code is primary, start with a short title then the code block.\n"
            "- Do not wrap code in a single paragraph.\n\n"
            f"User query: {query}\n\n"
            f"Search results:\n{search_results}\n\n"
            "Provide the answer now and include citations as [source: url] where relevant."
        )
    else:
        prompt = (
            "You are a helpful coding assistant. Always respond in Markdown.\n"
            "- When including code, use fenced code blocks with the correct language tag (e.g., ```python, ```html).\n"
            "- For multi-line code, never inline it; use fenced blocks only.\n"
            "- Keep prose concise; if code is primary, start with a short title then the code block.\n"
            "- Do not wrap code in a single paragraph.\n\n"
            f"User query: {query}"
        )

    try:
        model = GenerativeModel("gemini-2.5-flash", generation_config=GenerationConfig(temperature=0.7))
        response = model.generate_content(prompt)
        if not response.text:
            logger.warning(f"Empty response for query: {query}")
            return "Sorry, I couldn't generate a response. Please try again."
        return response.text
    except Exception as e:
        logger.error(f"Gemini API error: {e}")
        return f"Error processing query: {str(e)}"

# Helper function for streaming query processing
async def process_query_streaming(query: str):
    search_keywords = ["what is", "latest", "news", "find", "search"]
    needs_search = any(keyword in query.lower() for keyword in search_keywords)

    if needs_search:
        search_results = perform_search(query)
        prompt = (
            "You are a helpful coding assistant. Always respond in Markdown.\n"
            "- When including code, use fenced code blocks with the correct language tag (e.g., ```python, ```html).\n"
            "- For multi-line code, never inline it; use fenced blocks only.\n"
            "- Keep prose concise; if code is primary, start with a short title then the code block.\n"
            "- Do not wrap code in a single paragraph.\n\n"
            f"User query: {query}\n\n"
            f"Search results:\n{search_results}\n\n"
            "Provide the answer now and include citations as [source: url] where relevant."
        )
    else:
        prompt = (
            "You are a helpful coding assistant. Always respond in Markdown.\n"
            "- When including code, use fenced code blocks with the correct language tag (e.g., ```python, ```html).\n"
            "- For multi-line code, never inline it; use fenced blocks only.\n"
            "- Keep prose concise; if code is primary, start with a short title then the code block.\n"
            "- Do not wrap code in a single paragraph.\n\n"
            f"User query: {query}"
        )

    try:
        model = GenerativeModel("gemini-2.5-flash", generation_config=GenerationConfig(temperature=0.7))
        stream_response = model.generate_content(prompt, stream=True)
        for chunk in stream_response:
            if hasattr(chunk, 'text') and chunk.text:
                yield chunk.text
            else:
                logger.warning(f"Empty chunk for query: {query}, finish_reason: {getattr(chunk, 'finish_reason', 'unknown')}")
                yield "Sorry, I couldn't generate a response chunk. Please try again."
    except Exception as e:
        logger.error(f"Gemini streaming error: {e}")
        yield f"Error: {str(e)}"

# WebSocket endpoint for realtime chat
@app.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            # Expect either a plain string (legacy) or a JSON string { prompt, image } where image is data URL
            query = raw
            try:
                import json
                payload = json.loads(raw)
                query = payload.get("prompt", raw)
                image_data_url = payload.get("image")
            except Exception:
                image_data_url = None

            # If image is provided, include a short instruction to consider the image.
            if image_data_url:
                query = f"{query}\n\nAlso consider the attached image when answering."

            async for chunk in process_query_streaming(query):
                await websocket.send_text(chunk)
            await websocket.send_text("[END]")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        await websocket.send_text(f"Error: {str(e)}")
        await websocket.close()

# HTTP endpoint for testing
@app.get("/chat/{query}")
async def chat(query: str):
    response = await process_query_non_streaming(query)
    return {"response": response}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
