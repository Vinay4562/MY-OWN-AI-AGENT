from http.server import BaseHTTPRequestHandler
import json
import os
from dotenv import load_dotenv
import time
import jwt
from passlib.context import CryptContext
from pymongo import MongoClient

load_dotenv()

# Environment variables
MONGO_URL = os.getenv("MONGO_URL", "")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "my_ai_agent")
JWT_SECRET = os.getenv("JWT_SECRET", "change_me")
JWT_ISSUER = "my-ai-agent"
JWT_TTL_SECONDS = 60 * 60 * 24 * 7

# Database connection
mongo_client = MongoClient(MONGO_URL) if MONGO_URL else None
db = mongo_client.get_database(MONGO_DB_NAME) if mongo_client is not None else None
users_col = db["users"] if db is not None else None

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

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

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Set CORS headers
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        
        try:
            # Read request body
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            payload = json.loads(post_data.decode('utf-8'))
            
            if users_col is None:
                response = {"error": "Database not configured"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            email = (payload.get("email") or "").strip().lower()
            password = payload.get("password") or ""
            
            if not email or not password:
                response = {"error": "Missing fields"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            user = users_col.find_one({"email": email})
            if not user or not _verify_password(password, user.get("password", "")):
                response = {"error": "Invalid credentials"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            user_id = str(user.get("_id"))
            token = _issue_jwt(user_id, user.get("username") or email)
            response = {
                "token": token, 
                "user": {
                    "id": user_id, 
                    "email": email, 
                    "username": user.get("username") or email
                }
            }
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            response = {"error": str(e)}
            self.wfile.write(json.dumps(response).encode())
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
