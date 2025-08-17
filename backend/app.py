import os
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from google.generativeai import GenerativeModel, configure
from google.generativeai.types import GenerationConfig
from ddgs import DDGS
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

# Helper function for web search
def perform_search(query: str, max_results: int = 3):
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        formatted_results = []
        for idx, result in enumerate(results, 1):
            formatted_results.append(f"**Result {idx}**:\n- **Title**: {result['title']}\n- **Snippet**: {result['body']}\n- **Source**: [{result['href']}]({result['href']})\n")
        return "\n".join(formatted_results) if formatted_results else "No results found."
    except Exception as e:
        logger.error(f"Search error: {e}")
        return "Search unavailable due to an error."

# Helper function for non-streaming query processing
async def process_query_non_streaming(query: str):
    search_keywords = ["what is", "latest", "news", "find", "search"]
    needs_search = any(keyword in query.lower() for keyword in search_keywords)

    if needs_search:
        search_results = perform_search(query)
        prompt = f"User query: {query}\n\nSearch results:\n{search_results}\n\nProvide a concise, markdown-formatted answer based on the search results. Include citations as [source: url]. If no results are relevant, answer conversationally."
    else:
        prompt = f"Answer the user query conversationally: {query}\nUse markdown for formatting."

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
        prompt = f"User query: {query}\n\nSearch results:\n{search_results}\n\nProvide a concise, markdown-formatted answer based on the search results. Include citations as [source: url]. If no results are relevant, answer conversationally."
    else:
        prompt = f"Answer the user query conversationally: {query}\nUse markdown for formatting."

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
            data = await websocket.receive_text()
            async for chunk in process_query_streaming(data):
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
