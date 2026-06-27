"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getOptionalSession, type AuthSession } from "../../auth/auth-session";
import { fetchAiSuggestions, sendAiMessage } from "../../services/ai-client";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export default function AiChatWidget() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "你好，我是物流 AI 助手。你可以问：订单到哪了，或本月发了多少货。",
    },
  ]);
  const typeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (typeTimerRef.current) {
        window.clearInterval(typeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setSession(getOptionalSession());
  }, []);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    fetchAiSuggestions()
      .then((res) => setSuggestions(res.suggestions))
      .catch((e) => { console.error("suggestions failed", e); setSuggestions([]); });
    return () => ac.abort();
  }, [open]);

  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  const handleSend = async (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || loading) return;
    setLoading(true);
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: `u_${Date.now()}`, role: "user", content: message },
    ]);

    try {
      const result = await sendAiMessage({ message, sessionId });
      setSessionId(result.sessionId);
      const answerId = `a_${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: answerId, role: "assistant", content: "…" },
      ]);
      let current = 0;
      if (typeTimerRef.current) {
        window.clearInterval(typeTimerRef.current);
      }
      typeTimerRef.current = window.setInterval(() => {
        current += 3; // batch 3 chars per tick for smoother long responses
        const nextText = result.answer.slice(0, current);
        setMessages((prev) =>
          prev.map((item) => (item.id === answerId ? { ...item, content: nextText } : item)),
        );
        if (current >= result.answer.length && typeTimerRef.current) {
          window.clearInterval(typeTimerRef.current);
          typeTimerRef.current = null;
        }
      }, 16);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "网络错误，请稍后重试";
      setMessages((prev) => [
        ...prev,
        { id: `e_${Date.now()}`, role: "assistant", content: `请求失败：${messageText}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "fixed",
          right: 24,
          bottom: 24,
          borderRadius: 999,
          border: "none",
          padding: "12px 18px",
          color: "#fff",
          background: "#2563eb",
          cursor: "pointer",
          boxShadow: "0 8px 24px rgba(37, 99, 235, 0.35)",
          zIndex: 50,
        }}
      >
        AI 客服
      </button>

      {open ? (
        <div
          style={{
            position: "fixed",
            right: 24,
            bottom: 80,
            width: 360,
            height: 520,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            display: "flex",
            flexDirection: "column",
            zIndex: 60,
            boxShadow: "0 16px 40px rgba(15, 23, 42, 0.2)",
          }}
        >
          <div style={{ padding: "12px 14px", borderBottom: "1px solid #e5e7eb" }}>
            <strong>订单 AI 助手</strong>
            <div style={{ fontSize: 12, color: "#000000", marginTop: 4 }}>
              数据范围：同公司账号数据
            </div>
            <div style={{ fontSize: 12, color: "#000000", marginTop: 2 }}>
              当前身份：{session?.role} / {session?.userId} / {session?.companyId}
            </div>
          </div>

          <div style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {suggestions.slice(0, 3).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => handleSend(item)}
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 999,
                  padding: "6px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                  background: "#f8fafc",
                  color: "#000000",
                }}
              >
                {item}
              </button>
            ))}
          </div>

          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              background: "#f8fafc",
            }}
          >
            {loading ? (
              <div
                style={{
                  alignSelf: "flex-start",
                  maxWidth: "90%",
                  borderRadius: 10,
                  padding: "8px 10px",
                  fontSize: 13,
                  lineHeight: 1.5,
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                }}
              >
                <span style={{ color: "#000000", marginRight: 6 }}>AI 思考中</span>
                <span className="typing-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : null}
            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "90%",
                  borderRadius: 10,
                  padding: "8px 10px",
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  background: msg.role === "user" ? "#dbeafe" : "#fff",
                  border: "1px solid #e5e7eb",
                }}
              >
                {msg.content}
              </div>
            ))}
          </div>

          <div style={{ padding: 10, borderTop: "1px solid #e5e7eb", display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="例如：我的单号 THCN0001 到哪了？"
                style={{
                  width: "100%",
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  padding: "8px 10px",
                  outline: "none",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSend) {
                    void handleSend();
                  }
                }}
              />
              {input.trim().length > 0 && !loading ? (
                <div style={{ marginTop: 4, color: "#000000", fontSize: 12 }}>输入中...</div>
              ) : null}
            </div>
            <button
              type="button"
              disabled={!canSend}
              onClick={() => handleSend()}
              style={{
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                color: "#fff",
                background: canSend ? "#2563eb" : "#9ca3af",
                cursor: canSend ? "pointer" : "not-allowed",
              }}
            >
              {loading ? "发送中" : "发送"}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
