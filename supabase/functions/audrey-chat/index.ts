import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LEVEL_GUIDE: Record<string, string> = {
  beginner: "A1 入門：只用最基礎字彙與簡單句（主詞+動詞+受詞），每句 ≤ 8 字",
  elementary: "A2 基礎：常見日常字彙，簡單連接詞 (and/but/so)，每句 ≤ 12 字",
  intermediate: "B1 中級：可用形容詞、副詞、簡單從屬子句，每句 ≤ 16 字",
};

function buildSystemPrompt(): string {
  return `你是 Audrey，專門為台灣兒童設計 1 分鐘英文朗讀小腳本的 AI。

# 目標
根據孩子的「年齡、程度、興趣關鍵字」，生成一份 80–120 字的英文短腳本 (story / monologue)，
讓家長或孩子在 1 分鐘內完整讀完。內容要有趣、貼近孩子的興趣，避免說教與抽象概念。

# 硬性規則
1. 總字數 80–120 個英文單字 (word count)
2. 切成 6–10 句，每句獨立換行
3. 每一句都要附繁體中文翻譯
4. 避免生僻字、俚語、縮寫
5. 內容要正面、安全、適合兒童
6. 如果使用者給的興趣是中文，請自動翻成對應英文後再使用
7. 挑 4–6 個關鍵字做 vocab 清單（英文單字，不加中文）

# 輸出格式（必須回傳合法 JSON，不要 markdown 圍欄、不要多餘文字）
{
  "title": "英文標題",
  "lines": [
    { "en": "英文句 1", "zh": "中文翻譯 1" },
    { "en": "英文句 2", "zh": "中文翻譯 2" }
  ],
  "vocab": ["word1", "word2", "word3", "word4"]
}`;
}

function buildUserPrompt(age: number, level: string, interest: string): string {
  const levelHint = LEVEL_GUIDE[level] || LEVEL_GUIDE.elementary;
  return `請為以下孩子生成 1 分鐘英文小腳本：
- 年齡：${age} 歲
- 程度：${level} (${levelHint})
- 興趣關鍵字：${interest}

只回傳 JSON，格式依照 system prompt 定義。`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const { age, level, interest, line_user_id, display_name } = body || {};

    if (!line_user_id || typeof line_user_id !== "string") {
      return json({ error: "Login required" }, 401);
    }
    if (!interest || typeof interest !== "string" || interest.length > 100) {
      return json({ error: "Invalid interest" }, 400);
    }
    const ageNum = Number(age);
    if (!Number.isFinite(ageNum) || ageNum < 3 || ageNum > 15) {
      return json({ error: "Invalid age" }, 400);
    }
    const levelStr = typeof level === "string" && LEVEL_GUIDE[level] ? level : "elementary";

    const endpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
    const apiKey = Deno.env.get("AZURE_OPENAI_KEY");
    const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT") || "gpt-4o";
    if (!endpoint || !apiKey) {
      return json({ error: "AI service not configured" }, 500);
    }

    const messages = [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(ageNum, levelStr, interest) },
    ];

    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-10-21`;
    const aiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        messages,
        max_tokens: 900,
        temperature: 0.8,
        response_format: { type: "json_object" },
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("Azure OpenAI error:", aiRes.status, errText);
      return json({ error: "AI service error", details: errText.slice(0, 300) }, 502);
    }

    const aiData = await aiRes.json();
    const raw = aiData.choices?.[0]?.message?.content || "{}";
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("JSON parse failed, raw:", raw);
      return json({ error: "AI returned invalid JSON" }, 502);
    }

    // Optional: log to audrey_chat_logs if table exists
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && supabaseKey) {
        const sb = createClient(supabaseUrl, supabaseKey);
        await sb.from("audrey_chat_logs").insert({
          line_user_id,
          display_name: display_name || null,
          age: ageNum,
          level: levelStr,
          interest,
          title: parsed.title || null,
          script: raw,
        });
      }
    } catch (logErr) {
      console.error("Log error (non-fatal):", logErr);
    }

    return json(parsed, 200);
  } catch (err) {
    console.error("audrey-chat error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
