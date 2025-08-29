import os
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, APIRouter
from fastapi import Body, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from google.generativeai import GenerativeModel, configure
from google.generativeai.types import GenerationConfig
from googleapiclient.discovery import build
import logging
import secrets
import smtplib
import ssl
from email.message import EmailMessage
import io
from typing import Optional, Tuple
import time
import jwt
from passlib.context import CryptContext
from pymongo import MongoClient

try:
    import pytesseract  # type: ignore[reportMissingImports]
    from PIL import Image  # type: ignore[reportMissingImports]
    import fitz as pymupdf  # type: ignore[reportMissingImports]
except Exception:
    pytesseract = None
    Image = None
    pymupdf = None

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

# Configure Gemini API
configure(api_key=os.getenv("GEMINI_API_KEY"))

app = FastAPI()
router = APIRouter()
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# Allow CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # Local development
        "https://my-own-ai-agent-b4rkwta1p-vinay-kumars-projects-f1559f4a.vercel.app",  # Your old Vercel frontend
        "https://my-own-ai-agent-hxcehl8hx-vinay-kumars-projects-f1559f4a.vercel.app",  # Your new Vercel frontend
        "https://*.vercel.app",  # Any Vercel subdomain
        "https://*.onrender.com",  # Any Render subdomain
        "https://my-own-ai-agent-*.vercel.app",  # Your specific Vercel project pattern
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=86400,  # Cache preflight for 24 hours
)

GOOGLE_CSE_ID = os.getenv("GOOGLE_CSE_ID")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
MONGO_URL = os.getenv("MONGO_URL", "")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "my_ai_agent")
JWT_SECRET = os.getenv("JWT_SECRET", "change_me")
JWT_ISSUER = "my-ai-agent"
JWT_TTL_SECONDS = 60 * 60 * 24 * 7
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587") or 587)
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
SMTP_FROM = os.getenv("SMTP_FROM", "")
APP_URL = os.getenv("APP_URL", "http://localhost:3000")

def _send_email(subject: str, to_email: str, html_body: str, text_body: str | None = None) -> bool:
    try:
        if not (SMTP_HOST and SMTP_USER and SMTP_PASS and SMTP_FROM):
            logger.warning("SMTP not configured; cannot send email")
            return False
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = SMTP_FROM
        msg["To"] = to_email
        if text_body:
            msg.set_content(text_body)
            msg.add_alternative(html_body, subtype="html")
        else:
            msg.set_content(html_body, subtype="html")
        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls(context=context)
            server.login(SMTP_USER, SMTP_PASS)
            server.send_message(msg)
        return True
    except Exception as e:
        logger.error(f"SMTP send error: {e}")
        return False

mongo_client = MongoClient(MONGO_URL) if MONGO_URL else None
db = mongo_client.get_database(MONGO_DB_NAME) if mongo_client is not None else None
users_col = db["users"] if db is not None else None
chats_col = db["chats"] if db is not None else None

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

def _build_content_parts(query: str, attachment: dict | None):
    parts = []
    parts.append(
        "You are a helpful coding assistant. Always respond in Markdown.\n"
        "- When including code, use fenced code blocks with the correct language tag (e.g., ```python, ```html).\n"
        "- For multi-line code, never inline it; use fenced blocks only.\n"
        "- Keep prose concise; if code is primary, start with a short title then the code block.\n"
        "- Do not wrap code in a single paragraph.\n\n"
    )
    parts.append(f"User query: {query}")
    if attachment and attachment.get("data") and attachment.get("mime"):
        try:
            import base64
            # Expect a data URL like: data:<mime>;base64,<payload>
            data_url = attachment["data"]
            if data_url.startswith("data:") and ";base64," in data_url:
                mime = attachment["mime"]
                b64 = data_url.split(",", 1)[1]
                raw = base64.b64decode(b64)
                parts.append({
                    "inline_data": {
                        "mime_type": mime,
                        "data": raw,
                    }
                })
                # OCR preprocessing if available
                ocr_text = _try_ocr_bytes(raw, mime)
                if ocr_text:
                    parts.append("\n\nThe following is text OCR'ed from the attachment (may be imperfect):\n")
                    parts.append(ocr_text[:8000])
                parts.append("Consider the attached file when answering.")
        except Exception as e:
            logger.error(f"Attachment parse error: {e}")
    return parts


def _try_ocr_bytes(data: bytes, mime: str) -> Optional[str]:
    try:
        if not pytesseract or not Image:
            return None
        if mime.startswith("image/"):
            img = Image.open(io.BytesIO(data))
            text = pytesseract.image_to_string(img)
            return text.strip()
        if mime == "application/pdf" and pymupdf is not None:
            text_chunks = []
            with pymupdf.open(stream=data, filetype="pdf") as doc:
                for page in doc:
                    # Prefer embedded text; fallback to raster + OCR
                    t = page.get_text().strip()
                    if t:
                        text_chunks.append(t)
                        continue
                    pix = page.get_pixmap(dpi=200)
                    img = Image.open(io.BytesIO(pix.tobytes("png")))
                    t = pytesseract.image_to_string(img)
                    if t:
                        text_chunks.append(t)
            return "\n\n".join(text_chunks).strip()
    except Exception as e:
        logger.error(f"OCR error: {e}")
    return None


# Helper function for non-streaming query processing
async def process_query_non_streaming(query: str, attachment: dict | None = None):
    search_keywords = ["what is", "latest", "news", "find", "search"]
    needs_search = any(keyword in query.lower() for keyword in search_keywords)

    base_parts = _build_content_parts(query, attachment)
    if needs_search:
        search_results = perform_search(query)
        base_parts.append(f"\n\nSearch results:\n{search_results}\n\nProvide the answer now and include citations as [source: url] where relevant.")

    try:
        model = GenerativeModel("gemini-2.5-flash", generation_config=GenerationConfig(temperature=0.7))
        response = model.generate_content(base_parts)
        if not response.text:
            logger.warning(f"Empty response for query: {query}")
            return "Sorry, I couldn't generate a response. Please try again."
        return response.text
    except Exception as e:
        logger.error(f"Gemini API error: {e}")
        return f"Error processing query: {str(e)}"

# Helper function for streaming query processing
async def process_query_streaming(query: str, attachment: dict | None = None):
    search_keywords = ["what is", "latest", "news", "find", "search"]
    needs_search = any(keyword in query.lower() for keyword in search_keywords)

    base_parts = _build_content_parts(query, attachment)
    if needs_search:
        search_results = perform_search(query)
        base_parts.append(f"\n\nSearch results:\n{search_results}\n\nProvide the answer now and include citations as [source: url] where relevant.")

    try:
        model = GenerativeModel("gemini-2.5-flash", generation_config=GenerationConfig(temperature=0.7))
        stream_response = model.generate_content(base_parts, stream=True)
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
            # Expect either a plain string (legacy) or a JSON string { prompt, image, attachment }
            query = raw
            try:
                import json
                payload = json.loads(raw)
                query = payload.get("prompt", raw)
                image_data_url = payload.get("image")  # deprecated
                attachment = payload.get("attachment")  # { data: dataUrl, mime: string }
            except Exception:
                image_data_url = None
                attachment = None

            # Backward compatibility: map legacy image field to attachment
            if image_data_url and not attachment:
                attachment = {"data": image_data_url, "mime": "image/*"}

            async for chunk in process_query_streaming(query, attachment):
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


@router.post("/suggestions")
async def generate_suggestions(payload: dict = Body(...)):
    """
    Generate short, actionable follow-up suggestions tailored to the given AI response text.
    Request body: { text: string }
    """
    try:
        text = (payload or {}).get("text", "")
        if not text:
            return {"suggestions": []}
        model = GenerativeModel("gemini-2.5-flash", generation_config=GenerationConfig(temperature=0.3))
        prompt = (
            "You are a writing and coding assistant. Given the following assistant response, "
            "propose 3-5 short follow-up prompts the user could click to get better results. "
            "Keep each suggestion under 120 characters, imperative mood, no numbering, no quotes. "
            "If the response includes code, include at least one testing or refactor suggestion.\n\n"
            f"ASSISTANT_RESPONSE:\n{text}\n\n"
            "Return suggestions as a single JSON array of strings only."
        )
        res = model.generate_content(prompt)
        raw = res.text or "[]"
        import json as _json
        try:
            arr = _json.loads(raw)
            if isinstance(arr, list):
                suggestions = [str(s) for s in arr][:5]
            else:
                suggestions = []
        except Exception:
            # Fallback: split lines
            suggestions = [s.strip("- •\t ") for s in raw.splitlines() if s.strip()][:5]
        return {"suggestions": suggestions}
    except Exception as e:
        logger.error(f"suggestions error: {e}")
        return {"suggestions": []}


# ===================== AUTH =====================

# Handle preflight OPTIONS requests for auth endpoints
@router.options("/auth/{path:path}")
async def auth_options(path: str):
    return {"message": "OK"}

def _hash_password(password: str) -> str:
    return pwd_context.hash(password)

def _verify_password(password: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(password, hashed)
    except Exception:
        return False

def _issue_jwt(user_id: str, username: str) -> str:
    now = int(time.time())
    payload = {
        "sub": user_id,
        "name": username,
        "iss": JWT_ISSUER,
        "iat": now,
        "exp": now + JWT_TTL_SECONDS,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def _decode_jwt(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"], issuer=JWT_ISSUER)
    except Exception as e:
        logger.error(f"JWT decode error: {e}")
        return None


@router.post("/auth/signup")
def auth_signup(payload: dict = Body(...)):
    if users_col is None:
        raise HTTPException(status_code=500, detail="Database not configured")
    email = (payload.get("email") or "").strip().lower()
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    if not email or not password or not username:
        raise HTTPException(status_code=400, detail="Missing fields")
    existing = users_col.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    hashed = _hash_password(password)
    doc = {"email": email, "username": username, "password": hashed, "createdAt": int(time.time())}
    users_col.insert_one(doc)
    user_id = str(doc.get("_id"))
    token = _issue_jwt(user_id, username)
    return {"token": token, "user": {"id": user_id, "email": email, "username": username}}


@router.post("/auth/signin")
def auth_signin(payload: dict = Body(...)):
    if users_col is None:
        raise HTTPException(status_code=500, detail="Database not configured")
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    if not email or not password:
        raise HTTPException(status_code=400, detail="Missing fields")
    user = users_col.find_one({"email": email})
    if not user or not _verify_password(password, user.get("password", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    user_id = str(user.get("_id"))
    token = _issue_jwt(user_id, user.get("username") or email)
    return {"token": token, "user": {"id": user_id, "email": email, "username": user.get("username") or email}}


@router.post("/auth/forgot")
def auth_forgot(payload: dict = Body(...)):
    # Generate a password reset token and email a link to the user
    if users_col is None:
        raise HTTPException(status_code=500, detail="Database not configured")
    email = (payload.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Missing email")
    user = users_col.find_one({"email": email})
    # Always respond success to avoid email enumeration, but only send if user exists
    if user:
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + 60 * 60  # 1 hour
        try:
            from bson import ObjectId
            users_col.update_one({"_id": ObjectId(user.get("_id"))}, {"$set": {"resetToken": token, "resetTokenExp": expires}})
        except Exception:
            users_col.update_one({"_id": user.get("_id")}, {"$set": {"resetToken": token, "resetTokenExp": expires}})
        # Use the current frontend URL instead of the old APP_URL
        reset_link = "https://my-own-ai-agent-hxcehl8hx-vinay-kumars-projects-f1559f4a.vercel.app/reset?token={token}"
        subject = "Password reset for My AI Agent"
        html = f"""
        <p>Hello,</p>
        <p>We received a request to reset your password. Click the link below to set a new password:</p>
        <p><a href=\"{reset_link}\">Reset your password</a></p>
        <p>This link will expire in 1 hour. If you did not request this, you can ignore this email.</p>
        """
        text = f"Reset your password: {reset_link}\nThis link expires in 1 hour."
        sent = _send_email(subject, email, html, text)
        if not sent:
            logger.warning("Password reset email not sent; SMTP not configured or error occurred")
    return {"ok": True}


@router.post("/auth/reset")
def auth_reset(payload: dict = Body(...)):
    logger.info(f"Password reset attempt received for token: {payload.get('token', '')[:10]}...")
    if users_col is None:
        logger.error("Database not configured for password reset")
        raise HTTPException(status_code=500, detail="Database not configured")
    token = (payload.get("token") or "").strip()
    new_password = payload.get("password") or ""
    if not token or not new_password:
        logger.warning("Missing token or password in reset request")
        raise HTTPException(status_code=400, detail="Missing token or password")
    user = users_col.find_one({"resetToken": token})
    if not user:
        logger.warning(f"Invalid reset token: {token[:10]}...")
        raise HTTPException(status_code=400, detail="Invalid token")
    exp = int(user.get("resetTokenExp") or 0)
    if exp <= int(time.time()):
        logger.warning(f"Expired reset token: {token[:10]}...")
        raise HTTPException(status_code=400, detail="Token expired")
    hashed = _hash_password(new_password)
    try:
        from bson import ObjectId
        users_col.update_one(
            {"_id": ObjectId(user.get("_id"))},
            {"$set": {"password": hashed}, "$unset": {"resetToken": "", "resetTokenExp": ""}},
        )
    except Exception:
        users_col.update_one(
            {"_id": user.get("_id")},
            {"$set": {"password": hashed}, "$unset": {"resetToken": "", "resetTokenExp": ""}},
        )
    logger.info(f"Password reset successful for user: {user.get('email', 'unknown')}")
    return {"ok": True}


@router.delete("/auth/delete")
def auth_delete(authorization: str | None = Header(default=None)):
    if users_col is None or chats_col is None:
        raise HTTPException(status_code=500, detail="Database not configured")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization.split(" ", 1)[1]
    payload = _decode_jwt(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")
    user_id = payload.get("sub")
    # Delete user and chats
    users_col.delete_one({"_id": users_col.database.client.get_default_database() and None})
    try:
        from bson import ObjectId
        users_col.delete_one({"_id": ObjectId(user_id)})
    except Exception:
        users_col.delete_one({"_id": user_id})
    chats_col.delete_many({"userId": user_id})
    return {"ok": True}

@router.get("/chats")
def list_chats(authorization: str | None = Header(default=None)):
    if chats_col is None:
        raise HTTPException(status_code=500, detail="Database not configured")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization.split(" ", 1)[1]
    payload = _decode_jwt(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")
    user_id = payload.get("sub")
    # We store a single document per user with the full sessions array under "chats"
    doc = chats_col.find_one({"userId": user_id}, {"_id": 0, "chats": 1})
    sessions = doc.get("chats", []) if doc else []
    return {"chats": sessions}


@router.post("/chats")
def save_chats(payload: dict = Body(...), authorization: str | None = Header(default=None)):
    if chats_col is None:
        raise HTTPException(status_code=500, detail="Database not configured")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization.split(" ", 1)[1]
    data = _decode_jwt(token)
    if not data:
        raise HTTPException(status_code=401, detail="Invalid token")
    user_id = data.get("sub")
    chats = payload.get("chats")
    if not isinstance(chats, list):
        raise HTTPException(status_code=400, detail="Invalid body")
    # Filter to only chats that have at least one message (started conversations)
    try:
        filtered_chats = [c for c in chats if isinstance(c, dict) and isinstance(c.get("messages"), list) and len(c.get("messages")) > 0]
    except Exception:
        filtered_chats = []
    # Upsert single doc per user
    from pymongo import UpdateOne
    now = int(time.time())
    doc = {"userId": user_id, "chats": filtered_chats, "updatedAt": now}
    chats_col.update_one({"userId": user_id}, {"$set": doc}, upsert=True)
    return {"ok": True}


@app.get("/")
async def root():
    return {"message": "AI Agent Backend is running!", "status": "healthy"}

@app.get("/health")
async def health_check():
    return {"status": "healthy", "cors_enabled": True, "timestamp": int(time.time())}

app.include_router(router)

if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
