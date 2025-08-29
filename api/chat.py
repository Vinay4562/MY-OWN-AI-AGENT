import os
from fastapi import FastAPI, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Reuse logic by importing from index.py
from .index import process_query_non_streaming  # type: ignore

app = FastAPI()

# CORS: allow same-origin and typical usage
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"]
)

@app.get("/")
async def chat_query(q: str = ""):
    if not q:
        raise HTTPException(status_code=400, detail="Missing q")
    response = await process_query_non_streaming(q)
    return {"response": response}

@app.post("/")
async def chat_post(payload: dict = Body(...)):
    prompt = (payload or {}).get("prompt") or (payload or {}).get("query") or ""
    attachment = (payload or {}).get("attachment")
    if not isinstance(prompt, str) or not prompt.strip():
        raise HTTPException(status_code=400, detail="Missing prompt")
    response = await process_query_non_streaming(prompt, attachment if isinstance(attachment, dict) else None)
    return {"response": response}


