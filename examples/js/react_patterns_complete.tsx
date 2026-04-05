
// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Complete React + TypeScript + Supabase + Tailwind Chat Interface
// MontageDev AI Frontend Example

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import { marked } from "marked";
import hljs from "highlight.js";

// ── Types ───────────────────────────────────────────────────────────────────
interface Conversation {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface Message {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at?: string;
}

interface StreamEvent {
    type: "ping" | "thinking" | "start" | "token" | "tool_use" | "tool_result" | "search" | "done" | "error";
    text?: string;
    message?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    call_id?: string;
    queries?: string[];
    round?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!;
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Markdown renderer with syntax highlighting ──────────────────────────────
function renderMarkdown(content: string): string {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(content) as string;
    return html;
}

function highlightCode(container: HTMLElement): void {
    container.querySelectorAll("pre code").forEach((block) => {
        if (!(block as HTMLElement).dataset.highlighted) {
            hljs.highlightElement(block as HTMLElement);
        }
        // Add copy button
        const pre = block.parentElement!;
        if (!pre.querySelector(".copy-btn")) {
            const btn = document.createElement("button");
            btn.className = "copy-btn";
            btn.textContent = "Copy";
            btn.onclick = () => {
                navigator.clipboard.writeText((block as HTMLElement).innerText);
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy", 2000);
            };
            pre.prepend(btn);
        }
    });
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(
    path: string,
    token: string,
    options: RequestInit = {}
): Promise<Response | null> {
    try {
        return await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                ...options.headers,
            },
        });
    } catch {
        return null;
    }
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [streaming, setStreaming] = useState(false);
    const [toolsEnabled, setToolsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // ── Auth ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setSession(session);
                setToken(session.access_token);
            }
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setToken(session?.access_token ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    // ── Load conversations when token changes ─────────────────────────────────
    useEffect(() => {
        if (token) loadConversations();
    }, [token]);

    // ── Scroll to bottom on new message ──────────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Conversations ─────────────────────────────────────────────────────────
    const loadConversations = useCallback(async () => {
        if (!token) return;
        const res = await apiFetch("/api/conversations/", token);
        if (!res?.ok) return;
        const data = await res.json();
        setConversations(data.conversations ?? []);
    }, [token]);

    const newConversation = useCallback(async (): Promise<string | null> => {
        if (!token) return null;
        const res = await apiFetch("/api/conversations/create/", token, { method: "POST" });
        if (!res?.ok) return null;
        const data = await res.json();
        const conv: Conversation = data.conversation;
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setMessages([]);
        return conv.id;
    }, [token]);

    const selectConversation = useCallback(async (convId: string) => {
        if (!token) return;
        setActiveConvId(convId);
        setMessages([]);
        const res = await apiFetch(`/api/conversations/${convId}/messages/`, token);
        if (!res?.ok) return;
        const data = await res.json();
        setMessages(data.messages ?? []);
    }, [token]);

    // ── Send message ──────────────────────────────────────────────────────────
    const sendMessage = useCallback(async () => {
        if (streaming || !input.trim() || !token) return;

        let convId = activeConvId;
        if (!convId) {
            convId = await newConversation();
            if (!convId) {
                setError("Could not create conversation. Check your connection.");
                return;
            }
        }

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setStreaming(true);
        setError(null);

        abortRef.current = new AbortController();
        let assistantMsg = "";
        let assistantMsgIdx = -1;

        try {
            const res = await apiFetch(
                `/api/conversations/${convId}/send/`,
                token,
                {
                    method: "POST",
                    signal: abortRef.current.signal,
                    body: JSON.stringify({
                        content: userText,
                        model,
                        enable_tools: toolsEnabled,
                    }),
                }
            );

            if (!res) throw new Error("Network error");

            // Check HTTP status before reading as SSE
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try { const ed = await res.json(); errMsg = ed.error ?? errMsg; } catch {}
                if (res.status === 401) {
                    errMsg = "Session expired — refreshing…";
                    await supabase.auth.refreshSession();
                }
                throw new Error(errMsg);
            }

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";

                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    let evt: StreamEvent;
                    try { evt = JSON.parse(part.slice(6)); } catch { continue; }

                    if (evt.type === "ping" || evt.type === "thinking") continue;

                    if (evt.type === "start") {
                        setMessages(prev => {
                            const updated = [...prev, { role: "assistant" as const, content: "" }];
                            assistantMsgIdx = updated.length - 1;
                            return updated;
                        });
                    } else if (evt.type === "token" && evt.text) {
                        assistantMsg += evt.text;
                        setMessages(prev => {
                            if (assistantMsgIdx < 0) return prev;
                            const updated = [...prev];
                            updated[assistantMsgIdx] = { ...updated[assistantMsgIdx], content: assistantMsg };
                            return updated;
                        });
                    } else if (evt.type === "done") {
                        await loadConversations();
                    } else if (evt.type === "error") {
                        setError(evt.message ?? "Unknown error");
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as Error).name !== "AbortError") {
                setError((err as Error).message ?? "Failed to send message");
            }
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [streaming, input, token, activeConvId, model, toolsEnabled, newConversation, loadConversations]);

    const stopStreaming = () => {
        abortRef.current?.abort();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // ── Auth gate ─────────────────────────────────────────────────────────────
    if (!session) {
        return <AuthPage />;
    }

    // ── Main UI ───────────────────────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-100">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col bg-zinc-900 border-r border-zinc-800 shrink-0">
                <div className="p-4 border-b border-zinc-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-sm">M</div>
                        <span className="font-semibold text-sm">MontageDev AI</span>
                    </div>
                    <button
                        onClick={newConversation}
                        className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center gap-2 transition-colors border border-zinc-700"
                    >
                        <span>+</span> New chat
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            onClick={() => selectConversation(conv.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors mb-0.5 ${
                                conv.id === activeConvId
                                    ? "bg-rose-500/20 text-rose-300"
                                    : "hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                            }`}
                        >
                            {conv.title}
                        </button>
                    ))}
                </div>
                <div className="p-3 border-t border-zinc-800">
                    <div className="text-xs text-zinc-500 truncate">{session.user.email}</div>
                    <button
                        onClick={() => supabase.auth.signOut()}
                        className="text-xs text-zinc-600 hover:text-zinc-400 mt-1 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
                {/* Toolbar */}
                <header className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3 shrink-0">
                    <select
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-rose-500"
                    >
                        <option value="llama-3.3-70b-versatile">LLaMA 3.3 70B</option>
                        <option value="llama-3.1-8b-instant">LLaMA 3.1 8B (Fast)</option>
                        <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                        <option value="llama-3.2-11b-vision-preview">Vision 11B</option>
                    </select>
                    <button
                        onClick={() => setToolsEnabled(prev => !prev)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            toolsEnabled
                                ? "bg-rose-500/20 border-rose-500 text-rose-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500"
                        }`}
                    >
                        Tools {toolsEnabled ? "ON" : "OFF"}
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold text-2xl mb-4">M</div>
                            <h1 className="text-2xl font-bold mb-2">MontageDev AI</h1>
                            <p className="text-zinc-500 text-sm max-w-sm">Your AI coding agent — writes code, runs commands, reads files, searches the web.</p>
                        </div>
                    )}
                    <div className="max-w-3xl mx-auto space-y-6">
                        {messages.map((msg, i) => (
                            <MessageBubble key={i} message={msg} />
                        ))}
                        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
                            <ThinkingIndicator />
                        )}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-4 mb-2 px-4 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                        {error}
                        <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 shrink-0">
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2 bg-zinc-800 border border-zinc-700 focus-within:border-rose-500 rounded-2xl px-4 py-3 transition-colors">
                            <textarea
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Message MontageDev…"
                                rows={1}
                                disabled={streaming}
                                className="flex-1 bg-transparent text-sm resize-none outline-none placeholder-zinc-600 max-h-48 overflow-y-auto"
                                style={{ height: "auto" }}
                                onInput={e => {
                                    const el = e.currentTarget;
                                    el.style.height = "auto";
                                    el.style.height = Math.min(el.scrollHeight, 192) + "px";
                                }}
                            />
                            {streaming ? (
                                <button onClick={stopStreaming} className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-500 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0">
                                    ■
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim() || streaming}
                                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-orange-400 disabled:opacity-30 flex items-center justify-center text-white transition-opacity shrink-0"
                                >
                                    ↑
                                </button>
                            )}
                        </div>
                        <p className="text-center text-xs text-zinc-700 mt-2">Enter to send · Shift+Enter for newline</p>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
    const isUser = message.role === "user";
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isUser && contentRef.current) {
            highlightCode(contentRef.current);
        }
    }, [message.content, isUser]);

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="max-w-[80%] bg-rose-500 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                    {message.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">M</div>
            <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 mb-1 font-medium">MontageDev AI</div>
                <div
                    ref={contentRef}
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                />
            </div>
        </div>
    );
}

function ThinkingIndicator() {
    return (
        <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center text-xs font-bold shrink-0">M</div>
            <div className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
            </div>
        </div>
    );
}

function AuthPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                setSuccess("Check your email to confirm your account.");
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-400 flex items-center justify-center font-bold">M</div>
                    <div>
                        <div className="font-bold">MontageDev AI</div>
                        <div className="text-xs text-zinc-500">Powerful AI coding agent</div>
                    </div>
                </div>
                <div className="flex gap-1 bg-zinc-800 rounded-lg p-1 mb-6">
                    {["Sign in", "Sign up"].map((tab, i) => (
                        <button
                            key={tab}
                            onClick={() => setIsSignUp(i === 1)}
                            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                                isSignUp === (i === 1) ? "bg-zinc-700 text-white" : "text-zinc-500"
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <div className="space-y-3">
                    <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleSubmit()}
                        className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm outline-none focus:border-rose-500 transition-colors" />
                    {error && <p className="text-red-400 text-xs">{error}</p>}
                    {success && <p className="text-green-400 text-xs">{success}</p>}
                    <button onClick={handleSubmit} disabled={loading}
                        className="w-full py-2.5 bg-gradient-to-r from-rose-500 to-orange-400 text-white font-semibold rounded-lg text-sm disabled:opacity-50 transition-opacity">
                        {loading ? "…" : isSignUp ? "Create account" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}
