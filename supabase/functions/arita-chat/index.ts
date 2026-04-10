import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `# 角色
你是「Arita 雙語 & TOEIC 學習助手」，一位友善、耐心、專業的英語學習教練。你的任務是幫助台灣學習者提升英語能力並準備 TOEIC 考試。

# 你的能力
1. **TOEIC 原創練習題**：依 TOEIC 官方格式出題（Part 5 單句填空、Part 6 段落填空、Part 7 閱讀理解）
2. **文法教學**：時態、關係子句、分詞構句、被動語態、介系詞、片語動詞等常考觀念
3. **商業詞彙**：會議、差旅、簽約、客服等 TOEIC 高頻字彙，含例句與搭配詞
4. **中英互譯**：提供道地翻譯並解釋
5. **技巧教學**：閱讀掃描/略讀、聽力推理、答題策略
6. **對話練習**：商業英語情境角色扮演

# 互動方式
- 主要用繁體中文解釋，英文例句保留原文
- 答案具體有範例，避免抽象
- 文法教學：先例句 → 再規則 → 再常見錯誤
- 學習者答錯時：鼓勵 → 解釋錯在哪 → 類似題再練
- 回答後主動問「要再一題嗎？」或「要練這個主題嗎？」

# 模式切換（用戶關鍵字）
- 「出題」「練習 Part X」「模擬考」「我要練 TOEIC」→ 出一題，等回答（不先透露答案）
- 「解釋 XXX」「什麼是 XXX」→ 講解該主題
- 「翻譯：...」→ 提供翻譯並解釋
- 「對話練習 XX 情境」→ 角色扮演對話
- 「我的弱點」「檢討」→ 分析學習者狀況

# 題目格式範例（Part 5）
**Q:** The board meeting has been ______ to next Tuesday due to scheduling conflicts.
(A) postponed (B) posted (C) positioned (D) possessed
請回答 A/B/C/D

# 限制
- 只討論英語學習、TOEIC、雙語相關話題
- 遇到無關問題（股票、政治等），禮貌引導回學習
- 不輸出任何官方 TOEIC 試題（版權）— 只出原創題目
- 不編造不存在的單字或用法

# 首次對話開場
若用戶說「hi/hello/你好」，介紹自己並提供選項：
1. 出一題 Part 5 文法題
2. 教 TOEIC 高頻商業單字
3. 練習 email 寫作
4. 中翻英「這份合約需要修改」`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { message, history = [], line_user_id, display_name } = await req.json();

    if (!line_user_id || typeof line_user_id !== "string") {
      return new Response(JSON.stringify({ error: "Login required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (message.length > 1000) {
      return new Response(JSON.stringify({ error: "Message too long (max 1000 chars)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!Array.isArray(history) || history.length > 20) {
      return new Response(JSON.stringify({ error: "Invalid history" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const endpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
    const apiKey = Deno.env.get("AZURE_OPENAI_KEY");
    const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT") || "gpt-4o";

    if (!endpoint || !apiKey) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const safeHistory = history
      .filter((h: any) => h.role === "user" || h.role === "assistant")
      .map((h: any) => ({ role: h.role, content: String(h.content).slice(0, 1000) }))
      .slice(-10);

    const aiMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...safeHistory,
      { role: "user", content: message },
    ];

    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-10-21`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        messages: aiMessages,
        max_tokens: 800,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Azure OpenAI error:", response.status, err);
      return new Response(JSON.stringify({
        error: "AI service error",
        status: response.status,
        details: err.substring(0, 500)
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Sorry, I cannot respond right now.";

    // Log to arita_chat_logs
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, supabaseKey);
      await sb.from("arita_chat_logs").insert({
        line_user_id,
        display_name: display_name || null,
        message,
        reply,
      });
    } catch (logErr) {
      console.error("Log error:", logErr);
    }

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Chat error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
