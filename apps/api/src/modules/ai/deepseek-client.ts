import type { DeepSeekClient } from "./ai-types";

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class HttpDeepSeekClient implements DeepSeekClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor() {
    this.endpoint =
      process.env.DEEPSEEK_API_BASE_URL ?? "https://api.deepseek.com/chat/completions";
    this.model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    this.apiKey = process.env.DEEPSEEK_API_KEY;
  }

  async summarizeWithContext(input: {
    question: string;
    context: string;
  }): Promise<string> {
    // Fallback keeps V1 usable when key is not configured.
    if (!this.apiKey) {
      return "系统暂未配置 DeepSeek API Key。请联系管理员配置后使用 AI 客服功能。";
    }

    const payload = {
      model: this.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你是湘泰物流AI客服助手。只能依据给定上下文回答，不允许编造。若信息不足，明确说明信息不足。",
        },
        {
          role: "user",
          content: `问题：${input.question}\n\n上下文：${input.context}`,
        },
      ],
    };

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as DeepSeekResponse & { error?: { message?: string } };
    if (!response.ok) {
      const msg = data?.error?.message ?? data?.message ?? `HTTP ${response.status}`;
      if (response.status === 401) throw new Error("DeepSeek API Key 无效或已过期，请检查 .env 中的 DEEPSEEK_API_KEY。");
      if (response.status === 402) throw new Error("DeepSeek 账户余额不足或未开通计费，请到平台充值。");
      throw new Error(`DeepSeek 请求失败：${msg}`);
    }

    return data.choices?.[0]?.message?.content?.trim() ?? "未获取到有效回复。";
  }
}
