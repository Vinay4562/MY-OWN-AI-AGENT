import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';

type CodeRendererProps = {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>;

type LinkRendererProps = {
  href?: string;
  children?: React.ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>;

type ChatMessage = { role: 'user' | 'ai'; content: string; attachment?: { data: string; mime: string } };
type ChatSession = {
  id: string;
  title: string;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
  messages: ChatMessage[];
};

const STORAGE_KEY = 'chat_sessions_v1';

function generateSessionId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}_${random}`;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [streamTargetIndex, setStreamTargetIndex] = useState<number | null>(null);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [includeAttachment, setIncludeAttachment] = useState<boolean>(true);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filePdfInputRef = useRef<HTMLInputElement>(null);
  const streamTargetIndexRef = useRef<number | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);
  const intentionalClose = useRef(false);
  const outboundQueue = useRef<string[]>([]);
  const typingBufferRef = useRef<string>('');
  const typingTimerRef = useRef<number | null>(null);
  const endAfterBufferRef = useRef(false);
  const followUpAddedRef = useRef(false);
  const [serverSuggestions, setServerSuggestions] = useState<Record<number, string[]>>({});
  const [suggestionsEnabled, setSuggestionsEnabled] = useState<boolean>(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [previousTheme, setPreviousTheme] = useState<'dark' | 'light' | null>(() => {
    const prev = localStorage.getItem('theme_previous');
    return prev === 'light' || prev === 'dark' ? prev : null;
  });
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('theme_preference');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<{ username?: string; email?: string } | null>(null);
  const [isAuthOpen, setIsAuthOpen] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('auth_token');
    } catch {
      return true;
    }
  });
  const [authMode, setAuthMode] = useState<'signin' | 'signup' | 'forgot'>('signin');
  const [authEmail, setAuthEmail] = useState<string>('');
  const [authPassword, setAuthPassword] = useState<string>('');
  const [authUsername, setAuthUsername] = useState<string>('');
  const [authLoading, setAuthLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string>('');
  const [toasts, setToasts] = useState<Array<{ id: number; type: 'success' | 'error'; text: string }>>([]);

  function addToast(type: 'success' | 'error', text: string) {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev, { id, type, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }
  const typingDelayMsRef = useRef<number>((window as any)._TYPING_DELAY_MS ?? 2);
  const typingCharsPerTickRef = useRef<number>((window as any)._TYPING_CHARS_PER_TICK ?? 20);
  // Speed controls (can be overridden via window._TYPING_DELAY_MS / window._TYPING_CHARS_PER_TICK)
  const TYPING_DELAY_MS = typingDelayMsRef.current; // lower is faster
  const TYPING_CHARS_PER_TICK = typingCharsPerTickRef.current; // higher is faster
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Apply theme to document
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme_preference', theme);
  }, [theme]);

  // Reset route handled in index.tsx to avoid conditional hooks here

  useEffect(() => {
    streamTargetIndexRef.current = streamTargetIndex;
  }, [streamTargetIndex]);

  useEffect(() => {
    // Load auth session
    try {
      const t = localStorage.getItem('auth_token');
      const u = localStorage.getItem('auth_user');
      if (t) setAuthToken(t);
      if (u) setAuthUser(JSON.parse(u));
    } catch {}
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const createNewChat = useCallback(() => {
    const id = generateSessionId();
    const now = new Date().toISOString();
    const newSession: ChatSession = {
      id,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setSessions((prev) => {
      const next = [newSession, ...prev];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setCurrentSessionId(id);
    setMessages([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist chats per user in backend when authenticated
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!authToken) return;
    const apiBase = resolveApiBaseUrl();
    // On load, fetch server chats and replace local sessions
    (async () => {
      try {
        const res = await fetch(`${apiBase}/chats`, { headers: { Authorization: `Bearer ${authToken}` } });
        if (!res.ok) return;
        const data = await res.json();
        const server = Array.isArray(data?.chats) ? data.chats : [];
        // Load server chats into history, but start a fresh chat active by default
        setSessions(server);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(server)); } catch {}
        // Create a brand new chat as the active one
        createNewChat();
        // Persist updated list (including the new empty chat) to server after a tick
        setTimeout(() => {
          try {
            const payload = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            fetch(`${apiBase}/chats`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
              body: JSON.stringify({ chats: payload })
            }).catch(() => {});
          } catch {}
        }, 0);
      } catch {}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, createNewChat]);

  function signOut() {
    try {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
    } catch {}
    setAuthToken(null);
    setAuthUser(null);
    setIsSettingsOpen(false);
    setIsAuthOpen(true);
    addToast('success', 'Signed out successfully');
  }

  async function submitAuthForm() {
    try {
      setAuthLoading(true);
      setAuthError('');
      const apiBase = resolveApiBaseUrl();
      let url = '';
      let body: any = {};
      if (authMode === 'signin') {
        url = `${apiBase}/auth/signin`;
        body = { email: authEmail, password: authPassword };
      } else if (authMode === 'signup') {
        url = `${apiBase}/auth/signup`;
        body = { email: authEmail, password: authPassword, username: authUsername || authEmail.split('@')[0] };
      } else {
        url = `${apiBase}/auth/forgot`;
        body = { email: authEmail };
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Request failed');
      }
      const data = await res.json();
      if (authMode === 'forgot') {
        setAuthError('If the email exists, a reset link has been sent.');
        addToast('success', 'Reset link sent if the email exists');
        setAuthLoading(false);
        return;
      }
      const token = data?.token as string;
      const user = data?.user as any;
      if (!token || !user) throw new Error('Invalid response');
      setAuthToken(token);
      setAuthUser({ username: user?.username, email: user?.email });
      try {
        localStorage.setItem('auth_token', token);
        localStorage.setItem('auth_user', JSON.stringify({ username: user?.username, email: user?.email }));
      } catch {}
      setIsAuthOpen(false);
      setAuthEmail(''); setAuthPassword(''); setAuthUsername('');
      addToast('success', authMode === 'signup' ? 'Account created' : 'Signed in');
    } catch (e: any) {
      setAuthError(e?.message || 'Something went wrong');
      addToast('error', e?.message || 'Something went wrong');
    } finally {
      setAuthLoading(false);
    }
  }

  function resolveWebSocketUrl(): string {
    const override = (window as any)._WS_URL || process.env.REACT_APP_WS_URL;
    if (override) return override as string;
    const isHttps = window.location.protocol === 'https:';
    const proto = isHttps ? 'wss' : 'ws';
    // Local dev convenience: if running frontend on :3000, default backend to :8000
    if ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port === '3000') {
      return `${proto}://localhost:8000/ws/chat`;
    }
    // Connect directly to Render backend for WebSocket streaming
    return 'wss://ai-agent-backend-vh0h.onrender.com/ws/chat';
  }

  function resolveApiBaseUrl(): string {
    const isOnVercel = /\.vercel\.app$/i.test(window.location.hostname);
    const override = (window as any)._API_URL || process.env.REACT_APP_API_URL;
    if (override) return override as string;
    const isHttps = window.location.protocol === 'https:';
    const httpProto = isHttps ? 'https' : 'http';
    if ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port === '3000') {
      return `${httpProto}://localhost:8000`;
    }
    // On Vercel, prefer dedicated Render backend
    if (isOnVercel) return 'https://ai-agent-backend-vh0h.onrender.com';
    return '';
  }

  function scheduleReconnect() {
    if (intentionalClose.current) return; // do not reconnect if closed by user
    const attempt = reconnectAttempts.current;
    const delay = Math.min(30000, 1000 * Math.pow(2, attempt)); // 1s,2s,4s,... max 30s
    if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = window.setTimeout(() => {
      reconnectAttempts.current = attempt + 1;
      connectWebSocket();
    }, delay);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const connectWebSocket = useCallback(() => {
    try {
      if (ws.current && (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING)) {
        return;
      }
      const url = resolveWebSocketUrl();
      const socket = new WebSocket(url);
      ws.current = socket;

      socket.onopen = () => {
        reconnectAttempts.current = 0;
        // Flush any queued messages
        try {
          while (outboundQueue.current.length > 0 && socket.readyState === WebSocket.OPEN) {
            const next = outboundQueue.current.shift();
            if (next != null) socket.send(next);
          }
        } catch {}
      };

      socket.onmessage = (event: MessageEvent) => {
        const text = typeof event.data === 'string' ? event.data : '';
        if (!text) return;
        if (text === '[END]') {
          setIsLoading(false);
          setStreamTargetIndex(null);
          maybeAppendFollowUp();
          return;
        }
        // Append chunk to the active AI message being streamed
        setMessages((prev) => {
          const idx = streamTargetIndexRef.current;
          if (idx === null || idx >= prev.length) return prev;
          const curr = prev[idx];
          if (!curr || curr.role !== 'ai') return prev;
          const updated = [...prev];
          updated[idx] = { role: 'ai', content: (curr.content || '') + text };
          return updated;
        });
      };

      socket.onerror = () => {
        try { socket.close(); } catch {}
      };

      socket.onclose = () => {
        if (!intentionalClose.current) scheduleReconnect();
      };
    } catch (e) {
      // Fall back silently; HTTP path will cover
      console.warn('WebSocket connect error; falling back to HTTP');
    }
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      intentionalClose.current = true;
      ws.current?.close();
    };
  }, [connectWebSocket]);

  // Load sessions on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ChatSession[];
        setSessions(parsed);
        if (parsed.length > 0) {
          setCurrentSessionId(parsed[0].id);
          setMessages(parsed[0].messages || []);
        } else {
          createNewChat();
        }
      } catch {
        createNewChat();
      }
    } else {
      createNewChat();
    }
  }, []);

  // Persist current session on messages change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!currentSessionId) return;
    setSessions((prev) => {
      const now = new Date().toISOString();
      const updated = prev.map((s) =>
        s.id === currentSessionId
          ? {
              ...s,
              messages,
              updatedAt: now,
              title:
                s.title && s.title !== 'New chat'
                  ? s.title
                  : messages.find((m) => m.role === 'user')?.content?.slice(0, 40) || 'New chat',
            }
          : s
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      // Also push to server if signed in
      if (authToken) {
        const apiBase = resolveApiBaseUrl();
        fetch(`${apiBase}/chats`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ chats: updated })
        }).catch(() => {});
      }
      return updated;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentSessionId]);

  function selectSession(id: string) {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    setCurrentSessionId(id);
    setMessages(session.messages || []);
    setIsHistoryOpen(false);
    setEditingIndex(null);
    setStreamTargetIndex(null);
  }

  function renameSession(id: string) {
    const session = sessions.find((s) => s.id === id);
    const initial = session?.title || '';
    const nextTitle = window.prompt('Rename chat', initial);
    if (nextTitle === null) return; // cancelled
    const trimmed = nextTitle.trim();
    if (!trimmed) return;
    setSessions((prev) => {
      const updated = prev.map((s) => (s.id === id ? { ...s, title: trimmed } : s));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function deleteSession(id: string) {
    if (!window.confirm('Delete this chat? This cannot be undone.')) return;
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
    if (id === currentSessionId) {
      if (remaining.length > 0) {
        const nextId = remaining[0].id;
        const next = remaining.find((s) => s.id === nextId);
        if (next) {
          setCurrentSessionId(nextId);
          setMessages(next.messages || []);
        }
      } else {
        createNewChat();
      }
    }
  }

  async function sendOrQueue(payload: string) {
    try {
      // Extract the actual message content
      let messageContent = payload;
      let attachment = null;
      
      // Check if payload is JSON with attachment
      try {
        const parsed = JSON.parse(payload);
        if (parsed.prompt) {
          messageContent = parsed.prompt;
          attachment = parsed.attachment;
        }
      } catch {
        // Payload is just a string, use as is
      }

      // Add AI message placeholder
      const aiIndex = messages.length;
      setMessages((prev) => [...prev, { role: 'ai', content: '' }]);
      setStreamTargetIndex(aiIndex);

      // Try WebSocket first for streaming
      const payloadToSend = attachment ? JSON.stringify({ prompt: messageContent, attachment }) : messageContent;
      let usedWebSocket = false;
      try {
        connectWebSocket();
        // Only use WebSocket if it is already OPEN. If it's CONNECTING, fall back to HTTP immediately
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(payloadToSend);
          usedWebSocket = true;
        }
      } catch {}

      if (!usedWebSocket) {
        // Fallback to HTTP with timeout and multi-endpoint strategy
        const apiBase = resolveApiBaseUrl();
        const isRenderBackend = !!apiBase && /onrender\.com$/i.test(new URL(apiBase).hostname);
        const chatUrlBase = apiBase ? `${apiBase}/chat` : '/api/chat';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        const postBody = attachment ? { prompt: messageContent, attachment } : { prompt: messageContent };

        const fetchWithTimeout = async (input: RequestInfo, init: RequestInit, ms = 15000) => {
          const ctrl = new AbortController();
          const t = window.setTimeout(() => ctrl.abort(), ms);
          try {
            const res = await fetch(input, { ...init, signal: ctrl.signal });
            return res;
          } finally {
            window.clearTimeout(t);
          }
        };

        let data: any = null;
        try {
          if (isRenderBackend) {
            // Render backend expects GET /chat/{query}
            const getResp = await fetchWithTimeout(`${apiBase}/chat/${encodeURIComponent(messageContent)}`, { method: 'GET', headers });
            if (!getResp.ok) throw new Error(`HTTP ${getResp.status}: ${getResp.statusText}`);
            data = await getResp.json();
          } else {
            let response = await fetchWithTimeout(chatUrlBase, { method: 'POST', headers, body: JSON.stringify(postBody) });
            if (!response.ok) {
              const getResp = await fetchWithTimeout(`${chatUrlBase}?q=${encodeURIComponent(messageContent)}`, { method: 'GET', headers });
              if (!getResp.ok) throw new Error(`HTTP ${getResp.status}: ${getResp.statusText}`);
              data = await getResp.json();
            } else {
              data = await response.json();
            }
          }
        } catch (e) {
          // If same-origin fails/timeouts, try direct Render backend as a fallback
          try {
            const fallbackBase = 'https://ai-agent-backend-vh0h.onrender.com';
            // Use the Render path-param endpoint directly
            const get2 = await fetchWithTimeout(`${fallbackBase}/chat/${encodeURIComponent(messageContent)}`, { method: 'GET', headers });
            if (!get2.ok) throw new Error(`HTTP ${get2.status}: ${get2.statusText}`);
            data = await get2.json();
          } catch (e2) {
            // Ultimately give a user-facing error
            setMessages((prev) => {
              const updated = [...prev];
              const idx = Math.min(aiIndex, updated.length - 1);
              if (idx >= 0 && updated[idx]?.role === 'ai') {
                updated[idx] = { role: 'ai', content: 'Sorry, I could not reach the chat service. Please try again.' };
              }
              return updated;
            });
            setIsLoading(false);
            setStreamTargetIndex(null);
            return;
          }
        }

        const aiResponse = data?.response || data?.answer || data?.text || data?.message || data?.output || 'Sorry, I encountered an error processing your request.';
        setMessages((prev) => {
          const updated = [...prev];
          const idx = Math.min(aiIndex, updated.length - 1);
          if (idx >= 0 && updated[idx]?.role === 'ai') {
            updated[idx] = { role: 'ai', content: aiResponse };
          }
          return updated;
        });
        setIsLoading(false);
        setStreamTargetIndex(null);
        maybeAppendFollowUp();
      }

    } catch (error) {
      console.error('Chat request failed:', error);
      console.error('Error details:', {
        name: (error as any).name,
        message: (error as any).message,
        stack: (error as any).stack
      });
      
      // Update AI message with error
      setMessages((prev) => {
        const updated = [...prev];
        const aiIndex = updated.length - 1;
        if (aiIndex >= 0 && updated[aiIndex]?.role === 'ai') {
          updated[aiIndex] = { role: 'ai', content: 'Sorry, I encountered an error. Please try again.' };
        }
        return updated;
      });

      setIsLoading(false);
      setStreamTargetIndex(null);
    }
  }

  const sendMessage = async () => {
    if (!input.trim()) return;

    const payload = attachedImage && includeAttachment
      ? JSON.stringify({ prompt: input, attachment: { data: attachedImage, mime: guessMimeFromDataUrl(attachedImage) } })
      : input;

    if (editingIndex !== null) {
      const aiIndex = editingIndex + 1;
      setMessages((prev) => {
        const updated = [...prev];
        if (updated[editingIndex] && updated[editingIndex].role === 'user') {
          updated[editingIndex] = { role: 'user', content: input, attachment: attachedImage && includeAttachment ? { data: attachedImage, mime: guessMimeFromDataUrl(attachedImage) } : undefined };
        }
        if (aiIndex < updated.length && updated[aiIndex] && updated[aiIndex].role === 'ai') {
          updated[aiIndex] = { role: 'ai', content: '' };
        } else {
          const before = updated.slice(0, aiIndex);
          const after = updated.slice(aiIndex);
          return [...before, { role: 'ai', content: '' }, ...after];
        }
        return updated;
      });
      setIsLoading(true);
      setStreamTargetIndex(aiIndex);
      followUpAddedRef.current = false;
      setEditingIndex(null);
      await sendOrQueue(payload);
      setInput('');
      setAttachedImage(null);
      setIncludeAttachment(true);
      setIsAttachMenuOpen(false);
      return;
    }

    setMessages((prev) => [...prev, { role: 'user', content: input, attachment: attachedImage && includeAttachment ? { data: attachedImage, mime: guessMimeFromDataUrl(attachedImage) } : undefined }]);
    setIsLoading(true);
    followUpAddedRef.current = false;
    await sendOrQueue(payload);
    setInput('');
    setAttachedImage(null);
    setIncludeAttachment(true);
    setIsAttachMenuOpen(false);
  };

  function stopStreaming() {
    setIsLoading(false);
    setStreamTargetIndex(null);
    // Prevent auto-reconnect for this user-initiated stop; reopen lazily on next send
    intentionalClose.current = true;
    // Clear any queued messages so they don't send after reconnect
    outboundQueue.current = [];
    // Clear typewriter buffers and timer
    typingBufferRef.current = '';
    endAfterBufferRef.current = false;
    if (typingTimerRef.current !== null) {
      window.clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    try { ws.current?.close(); } catch {}
    // After a brief moment, allow future reconnects
    window.setTimeout(() => { intentionalClose.current = false; }, 200);
  }

  function isLikelyCode(text: string | undefined): boolean {
    if (!text) return false;
    if (text.includes('```')) return true;
    const codeHints = [/;\s*$/m, /^\s*(function|class|def|const|let|var)\b/m, /<\/?[a-zA-Z][^>]*>/m];
    return codeHints.some((re) => re.test(text));
  }

  function maybeAppendFollowUp() {
    if (followUpAddedRef.current) return;
    const target = streamTargetIndexRef.current;
    let aiContent = '';
    setMessages((prev) => {
      let content = '';
      if (target !== null && target < prev.length && prev[target]?.role === 'ai') {
        content = prev[target].content;
      } else {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === 'ai') { content = prev[i].content; break; }
        }
      }
      aiContent = content;
      if (!isLikelyCode(content)) return prev;
      followUpAddedRef.current = true;
      const followUp = { role: 'ai' as const, content: 'Above is the code you asked. Do you want it cleaner or need any changes?' };
      return [...prev, followUp];
    });
    // Also ask server for tailored suggestions
    window.setTimeout(() => {
      try {
        const idx = (streamTargetIndexRef.current !== null) ? streamTargetIndexRef.current : (messages.length - 1);
        const text = aiContent;
        if (!suggestionsEnabled) return;
        const apiBase = resolveApiBaseUrl();
        fetch(`${apiBase}/suggestions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        }).then(r => r.json()).then((res) => {
          const suggs: string[] = Array.isArray(res?.suggestions) ? res.suggestions : [];
          setServerSuggestions((prev) => ({ ...prev, [idx]: suggs }));
        }).catch(() => {});
      } catch {}
    }, 0);
  }

  function hasLinks(text: string | undefined): boolean {
    if (!text) return false;
    return /(https?:\/\/|www\.)/i.test(text);
  }

  function buildSuggestions(aiText: string): string[] {
    const suggestions: string[] = [];
    if (isLikelyCode(aiText)) {
      suggestions.push(
        'Refactor the above code for readability and add comments.',
        'Optimize the above code for performance and explain the changes.',
        'Provide unit tests for the above code.'
      );
    } else {
      suggestions.push(
        'Rewrite the above answer with a concise summary and bullet points.',
        'Explain the above answer step-by-step for a beginner.',
        'Provide real-world examples and edge cases for the above answer.'
      );
    }
    if (hasLinks(aiText)) {
      suggestions.push('Add citations with short annotations for each link.');
    }
    if (aiText && aiText.length > 1200) {
      suggestions.push('Summarize the above answer in under 5 bullets.');
    }
    return suggestions.slice(0, 4);
  }

  function copyMessage(content: string, index: number) {
    const write = async () => {
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = content;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          document.execCommand('copy');
        } finally {
          document.body.removeChild(ta);
        }
      }
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 1200);
    };
    void write();
  }

  function editPrompt(index: number) {
    const content = messages[index]?.content || '';
    setInput(content);
    setEditingIndex(index);
    // focus and move caret to end
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const el = inputRef.current;
      if (el) {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  }

  function onPickImage() {
    setIsAttachMenuOpen((v) => !v);
  }

  function onImageSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setAttachedImage(dataUrl);
      setIncludeAttachment(true);
      setIsAttachMenuOpen(false);
    };
    reader.readAsDataURL(file);
    // reset input value so re-selecting the same file triggers change
    e.currentTarget.value = '';
  }

  function guessMimeFromDataUrl(dataUrl: string): string {
    const m = /^data:([^;]+);base64,/.exec(dataUrl);
    return m?.[1] || 'application/octet-stream';
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  // Full-page Auth experience
  if (isAuthOpen) {
    return (
      <div className="min-h-screen w-full relative overflow-hidden bg-gradient-to-br from-blue-200 via-white to-blue-200 dark:from-black dark:via-neutral-950 dark:to-black text-gray-900 dark:text-white">
        <div className="absolute -top-32 -left-32 w-[40rem] h-[40rem] rounded-full bg-blue-400/20 blur-3xl animate-pulse" />
        <div className="absolute -bottom-40 -right-40 w-[46rem] h-[46rem] rounded-full bg-blue-600/10 blur-3xl animate-pulse" />
        <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-md">
            <div className="flex items-center justify-center gap-3 mb-6">
              <picture>
                <source srcSet="/jenny-logo-dark.png 1x, /jenny-logo-dark@2x.png 2x" media="(prefers-color-scheme: dark)" />
                <source srcSet="/jenny-logo.png 1x, /jenny-logo@2x.png 2x" media="(prefers-color-scheme: light)" />
                <img src="/jenny-logo.png" srcSet="/jenny-logo@2x.png 2x" alt="Jenny logo" className="w-12 h-12 rounded-full shadow-lg animate-[spin_6s_linear_infinite] [animation-direction:reverse]" />
              </picture>
              <div className="text-3xl font-extrabold tracking-tight">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-purple-500">Jenny</span>
                <span className="ml-2 text-2xl font-bold opacity-80">AI</span>
              </div>
            </div>
            <div className="text-center text-sm mb-6 opacity-80">
              {authMode === 'signin' ? 'Welcome back. Sign in to continue.' : authMode === 'signup' ? 'Create your account to get started.' : 'We will send a reset link if the email exists.'}
            </div>
            <div className="bg-white/70 dark:bg-neutral-900/80 backdrop-blur border border-gray-200 dark:border-blue-900/50 rounded-xl p-5 shadow-xl">
              <div className="space-y-4">
                {authMode === 'signup' && (
                  <div>
                    <label className="block text-xs mb-1 text-gray-700 dark:text-blue-200">Username</label>
                    <input value={authUsername} onChange={(e)=>setAuthUsername(e.target.value)} className="w-full p-3 rounded-lg bg-white dark:bg-neutral-800 border border-gray-300 dark:border-blue-900/50" placeholder="Your name" />
                  </div>
                )}
                <div>
                  <label className="block text-xs mb-1 text-gray-700 dark:text-blue-200">Email</label>
                  <input type="email" value={authEmail} onChange={(e)=>setAuthEmail(e.target.value)} className="w-full p-3 rounded-lg bg-white dark:bg-neutral-800 border border-gray-300 dark:border-blue-900/50" placeholder="you@example.com" />
                </div>
                {authMode !== 'forgot' && (
                  <div>
                    <label className="block text-xs mb-1 text-gray-700 dark:text-blue-200">Password</label>
                    <input type="password" value={authPassword} onChange={(e)=>setAuthPassword(e.target.value)} className="w-full p-3 rounded-lg bg-white dark:bg-neutral-800 border border-gray-300 dark:border-blue-900/50" placeholder="Password" />
                  </div>
                )}
                {authError && <div className="text-sm text-red-500">{authError}</div>}
                <div className="flex items-center justify-end gap-3">
                  {authMode === 'signin' && (
                    <button className="text-xs text-gray-700 dark:text-blue-300 underline" onClick={()=>setAuthMode('forgot')}>Forgot password?</button>
                  )}
                  <button disabled={authLoading} onClick={submitAuthForm} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white disabled:opacity-60 transition-colors">
                    {authMode === 'signin' ? 'Sign in' : authMode === 'signup' ? 'Sign up' : 'Send reset link'}
                  </button>
                </div>
                <div className="text-xs text-gray-700 dark:text-blue-300 text-center">
                  {authMode === 'signin' ? (
                    <>Don’t have an account? <button className="underline" onClick={()=>setAuthMode('signup')}>Sign up</button></>
                  ) : (
                    <>Already have an account? <button className="underline" onClick={()=>setAuthMode('signin')}>Sign in</button></>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* Toasts */}
        <div className="fixed bottom-4 right-4 z-40 space-y-2">
          {toasts.map((t) => (
            <div key={t.id} className={`${t.type==='success'?'bg-green-600':'bg-red-600'} text-white px-3 py-2 rounded shadow`}>{t.text}</div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-white text-gray-900 dark:bg-black dark:text-white">
      {/* History Drawer */}
      {authToken && (
        <div
          className={`fixed inset-y-0 left-0 w-72 bg-gray-100 dark:bg-black border-r border-gray-200 dark:border-blue-900/50 transform transition-transform duration-200 ease-in-out z-30 ${
            isHistoryOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
        <div className="p-4 border-b border-gray-200 dark:border-blue-900/50 flex items-center justify-between">
          <div className="font-semibold">History</div>
          <button className="text-sm text-gray-700 dark:text-gray-300 hover:text-black dark:hover:text-white" onClick={() => setIsHistoryOpen(false)}>
            Close
          </button>
        </div>
        <div className="p-3">
          <button onClick={createNewChat} className="w-full mb-3 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded">
            + New Chat
          </button>
          <div className="space-y-2 overflow-y-auto max-h-[calc(100vh-160px)] pr-1">
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => selectSession(s.id)}
                className={`w-full text-left p-3 rounded bg-gray-200 dark:bg-neutral-900 hover:bg-gray-300 dark:hover:bg-neutral-800 cursor-pointer ${currentSessionId === s.id ? 'ring-2 ring-blue-500' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium truncate">{s.title || 'Untitled'}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-300">{new Date(s.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="p-2 bg-gray-300 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded"
                      onClick={(e) => { e.stopPropagation(); renameSession(s.id); }}
                      aria-label="Rename chat"
                      title="Rename"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                        <path d="M21.731 2.269a2.625 2.625 0 0 0-3.714 0l-1.157 1.157 3.714 3.714 1.157-1.157a2.625 2.625 0 0 0 0-3.714zM18.127 8.127l-3.714-3.714-9.9 9.9a5.25 5.25 0 0 0-1.32 2.214l-.74 2.592a.75.75 0 0 0 .92.92l2.593-.74a5.25 5.25 0 0 0 2.213-1.32l9.948-9.852z" />
                      </svg>
                    </button>
                    <button
                      className="p-2 bg-red-600 hover:bg-red-500 rounded"
                      onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                      aria-label="Delete chat"
                      title="Delete"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M9 3.75A2.25 2.25 0 0 1 11.25 1.5h1.5A2.25 2.25 0 0 1 15 3.75V4.5h3.75a.75.75 0 0 1 0 1.5H5.25a.75.75 0 0 1 0-1.5H9v-.75zM6.75 7.5h10.5l-.63 11.003a3 3 0 0 1-2.994 2.747H10.374a3 3 0 0 1-2.994-2.747L6.75 7.5zm3.75 2.25a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 .75-.75zm4.5 0a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 .75-.75z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        </div>
      )}

      {/* Overlay for mobile */}
      {authToken && isHistoryOpen && <div className="fixed inset-0 bg-black/20 dark:bg-black/60 z-20 lg:hidden" onClick={() => setIsHistoryOpen(false)} />}

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        <header className="p-4 bg-gray-100 dark:bg-neutral-950 flex items-center gap-3 border-b border-gray-200 dark:border-blue-900/50">
          {authToken && (
            <button className="px-3 py-2 bg-gray-200 dark:bg-neutral-900 hover:bg-gray-300 dark:hover:bg-neutral-800 rounded" onClick={() => setIsHistoryOpen((v) => !v)}>
              ☰ History
            </button>
          )}
          <div className="flex-1 flex items-center justify-center gap-2">
            <picture>
              <source srcSet="/jenny-logo-dark.png 1x, /jenny-logo-dark@2x.png 2x" media="(prefers-color-scheme: dark)" />
              <source srcSet="/jenny-logo.png 1x, /jenny-logo@2x.png 2x" media="(prefers-color-scheme: light)" />
              <img src="/jenny-logo.png" srcSet="/jenny-logo@2x.png 2x" alt="Jenny logo" className="w-8 h-8 rounded-full shadow object-cover" />
            </picture>
            <div className="text-center font-bold text-xl text-gray-900 dark:text-blue-300">Jenny</div>
          </div>
          <div className="flex items-center gap-3 relative">
            {authToken ? (
              <div className="relative group">
                <button 
                  type="button" 
                  className="w-10 h-10 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110 cursor-pointer animate-pulse border-2 border-transparent hover:border-white/20" 
                  title="Settings" 
                  aria-label="Settings" 
                  onClick={() => setIsSettingsOpen((v) => !v)}
                >
                  {(authUser?.username || authUser?.email || 'U').charAt(0).toUpperCase()}
                </button>
                <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-gray-900 dark:bg-gray-800 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-50">
                  {authUser?.username || authUser?.email || 'User'}
                  <div className="absolute bottom-full right-4 w-0 h-0 border-l-4 border-r-4 border-b-4 border-transparent border-b-gray-900 dark:border-b-gray-800"></div>
                </div>
              </div>
            ) : null}
            {!authToken && (
              <button type="button" className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white" onClick={()=>{ setIsAuthOpen(true); setAuthMode('signin'); }}>Sign in</button>
            )}
            {isSettingsOpen && (
              <div className="absolute right-0 top-12 bg-white dark:bg-neutral-950 border border-gray-200 dark:border-blue-900/50 rounded shadow-lg w-72 p-3 z-20 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-700 dark:text-blue-200">Theme</div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => { setPreviousTheme(theme); localStorage.setItem('theme_previous', theme); setTheme('light'); }} className={`px-2 py-1 text-xs rounded ${theme==='light'?'bg-blue-600 text-white':'bg-gray-200 hover:bg-gray-300 text-gray-900'}`}>Light</button>
                    <button type="button" onClick={() => { setPreviousTheme(theme); localStorage.setItem('theme_previous', theme); setTheme('dark'); }} className={`px-2 py-1 text-xs rounded ${theme==='dark'?'bg-blue-600 text-white':'bg-neutral-900 hover:bg-neutral-800 text-blue-200'}`}>Dark</button>
                  </div>
                </div>
                {previousTheme && (
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-700 dark:text-blue-200">Previous theme</div>
                    <button type="button" onClick={() => { const prev = previousTheme; setPreviousTheme(theme); localStorage.setItem('theme_previous', theme); setTheme(prev); }} className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300 dark:bg-neutral-900 dark:hover:bg-neutral-800">Switch to {previousTheme}</button>
                  </div>
                )}
                <div>
                  <div className="text-sm text-gray-700 dark:text-blue-200 mb-1">Typing speed</div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-500 dark:text-blue-300 w-28">Delay (ms)</label>
                    <input type="number" min={0} max={50} defaultValue={typingDelayMsRef.current} onChange={(e)=>{ typingDelayMsRef.current = Math.max(0, Number(e.target.value)||0); }} className="w-20 bg-white dark:bg-neutral-900 rounded p-1 text-sm border border-gray-300 dark:border-blue-900/50" />
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <label className="text-xs text-gray-500 dark:text-blue-300 w-28">Chars/tick</label>
                    <input type="number" min={1} max={200} defaultValue={typingCharsPerTickRef.current} onChange={(e)=>{ typingCharsPerTickRef.current = Math.max(1, Number(e.target.value)||1); }} className="w-20 bg-white dark:bg-neutral-900 rounded p-1 text-sm border border-gray-300 dark:border-blue-900/50" />
                  </div>
                  <div className="text-xs text-gray-500 dark:text-blue-300 mt-2">New speed applies on next stream.</div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-700 dark:text-blue-200">Suggestions</div>
                  <label className="text-xs text-gray-700 dark:text-blue-200 flex items-center gap-2">
                    <input type="checkbox" className="accent-blue-500" checked={suggestionsEnabled} onChange={(e) => setSuggestionsEnabled(e.target.checked)} />
                    Enabled
                  </label>
                </div>
                <div className="border-t border-gray-200 dark:border-blue-900/50 my-2" />
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-700 dark:text-blue-200">Profile</div>
                  <div className="text-right">
                    <div className="text-xs text-gray-700 dark:text-blue-200">
                      {authUser?.username || authUser?.email || 'Guest'}
                    </div>
                    {authToken && authUser?.email ? (
                      <div className="text-[11px] text-gray-500 dark:text-blue-300">{authUser.email}</div>
                    ) : null}
                  </div>
                </div>
                {authToken ? (
                  <div className="flex justify-end">
                    <button type="button" onClick={signOut} className="px-3 py-1 text-sm bg-red-600 hover:bg-red-500 rounded mr-2">Sign out</button>
                    <button
                      type="button"
                      onClick={async ()=>{
                        if (!window.confirm('Delete your account and all chats? This cannot be undone.')) return;
                        try {
                          const apiBase = resolveApiBaseUrl();
                          const res = await fetch(`${apiBase}/auth/delete`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
                          if (!res.ok) throw new Error('Failed to delete account');
                          // Clear local state and redirect to sign in screen with toast
                          signOut();
                          setIsAuthOpen(true);
                          addToast('success', 'Account deleted successfully');
                        } catch (e:any) {
                          addToast('error', e?.message || 'Failed to delete account');
                        }
                      }}
                      className="px-3 py-1 text-sm bg-red-800 hover:bg-red-700 rounded"
                    >
                      Delete account
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-gray-500 dark:text-blue-300">Sign in to access profile options.</div>
                    <button type="button" className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white" onClick={()=>{ setIsAuthOpen(true); setAuthMode('signin'); setIsSettingsOpen(false); }}>Sign in</button>
                  </div>
                )}
                <div className="flex justify-end">
                  <button type="button" className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-neutral-900 dark:hover:bg-neutral-800 rounded" onClick={()=>setIsSettingsOpen(false)}>Close</button>
                </div>
              </div>
            )}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-6">
              <div className="flex items-center gap-3 mb-8">
                <picture>
                  <source srcSet="/jenny-logo-dark.png 1x, /jenny-logo-dark@2x.png 2x" media="(prefers-color-scheme: dark)" />
                  <source srcSet="/jenny-logo.png 1x, /jenny-logo@2x.png 2x" media="(prefers-color-scheme: light)" />
                  <img src="/jenny-logo.png" srcSet="/jenny-logo@2x.png 2x" alt="Jenny logo" className="w-16 h-16 rounded-full shadow-lg" />
                </picture>
                <div className="text-4xl font-bold text-gray-900 dark:text-white">
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-purple-500">Jenny</span>
                  <span className="ml-2 text-3xl font-bold text-gray-700 dark:text-gray-300">AI</span>
                </div>
              </div>
              <div className="max-w-md">
                <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-3">How can I help you today?</h2>
                <p className="text-gray-600 dark:text-gray-400 text-lg">Ask me anything - I'm here to assist with coding, writing, analysis, and more.</p>
              </div>
            </div>
          ) : (
            <>
                            {messages.map((msg, idx) => (
                <div key={idx} className={`relative group max-w-lg ${msg.role === 'user' ? 'ml-auto bg-blue-600 text-white' : 'mr-auto bg-gray-100 dark:bg-gray-700'} p-3 rounded-lg`}>
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {msg.role === 'user' && (
                  <button
                    className="bg-gray-200 hover:bg-gray-300 dark:bg-gray-800/70 dark:hover:bg-gray-800 text-gray-900 dark:text-white p-1.5 rounded"
                    onClick={() => editPrompt(idx)}
                    aria-label="Edit prompt"
                    title="Edit prompt"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path d="M21.731 2.269a2.625 2.625 0 0 0-3.714 0l-1.157 1.157 3.714 3.714 1.157-1.157a2.625 2.625 0 0 0 0-3.714zM18.127 8.127l-3.714-3.714-9.9 9.9a5.25 5.25 0 0 0-1.32 2.214l-.74 2.592a.75.75 0 0 0 .92.92l2.593-.74a5.25 5.25 0 0 0 2.213-1.32l9.948-9.852z" />
                    </svg>
                  </button>
                )}
                <button
                  className="bg-gray-200 hover:bg-gray-300 dark:bg-gray-800/70 dark:hover:bg-gray-800 text-gray-900 dark:text-white p-1.5 rounded"
                  onClick={() => copyMessage(msg.content, idx)}
                  aria-label="Copy message"
                  title={copiedIndex === idx ? 'Copied!' : 'Copy'}
                >
                  {copiedIndex === idx ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M10.28 15.22a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06l2.47 2.47 5.47-5.47a.75.75 0 0 1 1.06 1.06l-6 6z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path d="M8.25 4.5A2.25 2.25 0 0 1 10.5 2.25h6A2.25 2.25 0 0 1 18.75 4.5v6a2.25 2.25 0 0 1-2.25 2.25h-6A2.25 2.25 0 0 1 8.25 10.5v-6z" />
                      <path d="M3 9.75A2.25 2.25 0 0 1 5.25 7.5h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 0-.75.75v6A2.25 2.25 0 0 0 6.75 18h6a.75.75 0 0 1 0 1.5h-6A3.75 3.75 0 0 1 3 15.75v-6z" />
                    </svg>
                  )}
                </button>
              </div>
              <ReactMarkdown
                components={{
                  code({ inline, className, children, ...props }: CodeRendererProps) {
                    if (inline) {
                      return (
                        <code className="bg-gray-100 dark:bg-gray-800/80 px-1.5 py-0.5 rounded" {...props}>{children}</code>
                      );
                    }
                    return (
                      <pre className="bg-gray-100 dark:bg-black/60 p-3 rounded-md overflow-x-auto">
                        <code className={className} {...props}>{children}</code>
                      </pre>
                    );
                  },
                  a({ href, children, ...props }: LinkRendererProps) {
                    return (
                      <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-300 underline" {...props}>
                        {children}
                      </a>
                    );
                  }
                }}
              >
                {msg.content}
              </ReactMarkdown>
              {msg.attachment && (
                <div className="mt-2">
                  {msg.attachment.mime.includes('pdf') ? (
                    <div className="w-16 h-16 flex items-center justify-center bg-gray-200 dark:bg-gray-800/70 rounded text-xs">PDF</div>
                  ) : (
                    <img src={msg.attachment.data} alt="attachment" className="w-24 h-24 object-cover rounded border border-gray-700" />
                  )}
                </div>
              )}
              {msg.role === 'ai' && suggestionsEnabled && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {buildSuggestions(msg.content).map((sug, i) => (
                    <button
                      key={i}
                      className="text-xs px-2 py-1 bg-gray-200 hover:bg-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700 rounded border border-gray-300 dark:border-gray-700"
                      onClick={() => setInput(sug)}
                      type="button"
                      title="Use suggestion"
                    >
                      {sug}
                    </button>
                  ))}
                  {(serverSuggestions[idx] || []).map((sug, i) => (
                    <button
                      key={`srv-${i}`}
                      className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-900 dark:bg-blue-900/60 dark:hover:bg-blue-800 rounded border border-blue-300 dark:border-blue-800"
                      onClick={() => setInput(sug)}
                      type="button"
                      title="Use suggestion"
                    >
                      {sug}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {isLoading && (
            <div className="text-center flex items-center justify-center gap-3">
              <span>Thinking...</span>
              <button onClick={stopStreaming} className="px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-sm">Stop</button>
            </div>
          )}
          {attachedImage && (
            <div className={`relative group max-w-lg ${'ml-auto bg-blue-600 text-white'} p-3 rounded-lg`}>
              <div className="mb-2 whitespace-pre-wrap">{input || '(write your message...)'}</div>
              <div className="flex items-center gap-3">
                {guessMimeFromDataUrl(attachedImage).includes('pdf') ? (
                  <div className="w-16 h-16 flex items-center justify-center bg-blue-900/60 rounded text-xs">PDF</div>
                ) : (
                  <img src={attachedImage} alt="attachment" className="w-20 h-20 object-cover rounded border border-blue-300" />
                )}
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" className="accent-blue-200" checked={includeAttachment} onChange={(e) => setIncludeAttachment(e.target.checked)} />
                  Include
                </label>
                <button className="text-xs bg-blue-700 hover:bg-blue-800 px-2 py-1 rounded" onClick={() => { setAttachedImage(null); setIncludeAttachment(true); }}>Remove</button>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
            </>
          )}
        </div>
                        <form onSubmit={async (e) => { e.preventDefault(); await sendMessage(); }} className="p-4 bg-gray-100 dark:bg-gray-800 flex items-center gap-2 relative">
          <input
            type="file"
            accept="image/*"
            ref={fileInputRef}
            className="hidden"
            onChange={onImageSelected}
          />
          <input
            type="file"
            accept="application/pdf"
            ref={filePdfInputRef}
            className="hidden"
            onChange={onImageSelected}
          />
          <button type="button" onClick={onPickImage} className="px-3 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded" title="Attach" aria-label="Attach">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path d="M17.657 6.343a4 4 0 0 0-5.657 0L4.222 14.12a3 3 0 1 0 4.243 4.243l6.01-6.01a2 2 0 1 0-2.828-2.828l-5.303 5.303a.75.75 0 1 1-1.06-1.06l5.303-5.303a3.5 3.5 0 1 1 4.95 4.95l-6.01 6.01a4.5 4.5 0 1 1-6.364-6.364l7.778-7.778a5.5 5.5 0 1 1 7.778 7.778l-6.364 6.364a.75.75 0 0 1-1.06-1.06l6.364-6.364a4 4 0 0 0 0-5.657z" />
            </svg>
          </button>
          {isAttachMenuOpen && (
            <div className="absolute bottom-16 left-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-2 z-10">
              <button className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded" onClick={() => fileInputRef.current?.click()}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M4.5 5.25A2.25 2.25 0 0 1 6.75 3h10.5A2.25 2.25 0 0 1 19.5 5.25v13.5A2.25 2.25 0 0 1 17.25 21H6.75A2.25 2.25 0 0 1 4.5 18.75V5.25Zm3 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm9.75 8.25-4.5-6-3 4.5-2.25-3-3.75 4.5h13.5Z"/></svg>
                Attach Image
              </button>
              <button className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded" onClick={() => filePdfInputRef.current?.click()}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M6 2.25A2.25 2.25 0 0 0 3.75 4.5v15A2.25 2.25 0 0 0 6 21.75h12A2.25 2.25 0 0 0 20.25 19.5V8.621a2.25 2.25 0 0 0-.659-1.591l-3.621-3.62A2.25 2.25 0 0 0 14.379 2.75H6ZM13.5 3.75v3.75a.75.75 0 0 0 .75.75h3.75"/></svg>
                Attach PDF
              </button>
            </div>
          )}
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 p-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-transparent rounded-l-lg focus:outline-none text-gray-900 dark:text-white"
            placeholder={editingIndex !== null ? 'Edit your prompt...' : 'Ask anything...'}
            ref={inputRef}
          />
          <button type="submit" className="bg-blue-600 p-2 rounded-r-lg text-white">{editingIndex !== null ? 'Update' : 'Send'}</button>
        </form>
      </div>

      {/* Auth Modal */}
      {isAuthOpen && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm bg-white dark:bg-neutral-900 rounded shadow-lg p-4 border border-gray-200 dark:border-blue-900/50">
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold text-gray-900 dark:text-blue-200">
                {authMode === 'signin' ? 'Sign in' : authMode === 'signup' ? 'Sign up' : 'Forgot password'}
              </div>
              <button className="text-sm px-2 py-1 bg-gray-200 hover:bg-gray-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 rounded" onClick={()=>setIsAuthOpen(false)}>Close</button>
            </div>
            <div className="space-y-3">
              {(authMode === 'signup') && (
                <div>
                  <label className="block text-xs mb-1 text-gray-700 dark:text-blue-200">Username</label>
                  <input value={authUsername} onChange={(e)=>setAuthUsername(e.target.value)} className="w-full p-2 rounded bg-white dark:bg-neutral-800 border border-gray-300 dark:border-blue-900/50" placeholder="Your name" />
                </div>
              )}
              <div>
                <label className="block text-xs mb-1 text-gray-700 dark:text-blue-200">Email</label>
                <input type="email" value={authEmail} onChange={(e)=>setAuthEmail(e.target.value)} className="w-full p-2 rounded bg-white dark:bg-neutral-800 border border-gray-300 dark:border-blue-900/50" placeholder="you@example.com" />
              </div>
              {authMode !== 'forgot' && (
                <div>
                  <label className="block text-xs mb-1 text-gray-700 dark:text-blue-200">Password</label>
                  <input type="password" value={authPassword} onChange={(e)=>setAuthPassword(e.target.value)} className="w-full p-2 rounded bg-white dark:bg-neutral-800 border border-gray-300 dark:border-blue-900/50" placeholder="Password" />
                </div>
              )}
              {authError && <div className="text-sm text-red-500">{authError}</div>}
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-600 dark:text-blue-300">
                  {authMode === 'signin' && (
                    <button className="underline" onClick={()=>setAuthMode('forgot')}>Forgot password?</button>
                  )}
                </div>
                <button disabled={authLoading} onClick={submitAuthForm} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-white disabled:opacity-60">
                  {authMode === 'signin' ? 'Sign in' : authMode === 'signup' ? 'Sign up' : 'Send reset link'}
                </button>
              </div>
              <div className="text-xs text-gray-600 dark:text-blue-300">
                {authMode === 'signin' ? (
                  <>Don't have an account? <button className="underline" onClick={()=>setAuthMode('signup')}>Sign up</button></>
                ) : (
                  <>Already have an account? <button className="underline" onClick={()=>setAuthMode('signin')}>Sign in</button></>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-40 space-y-2">
        {toasts.map((t) => (
          <div key={t.id} className={`${t.type==='success'?'bg-green-600':'bg-red-600'} text-white px-3 py-2 rounded shadow`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
};

export default App;