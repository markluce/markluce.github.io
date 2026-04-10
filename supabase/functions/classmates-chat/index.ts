import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
    if (message.length > 500) {
      return new Response(JSON.stringify({ error: "Message too long (max 500 chars)" }), {
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

    // Fetch classmates + messages from Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    const [classmatesResult, messagesResult] = await Promise.all([
      sb.from("classmates").select("display_name, company, job_title, group_number, intro_text, line_user_id, updated_at"),
      sb.from("member_messages").select("from_display_name, to_member_id, content, updated_at"),
    ]);

    const classmates = (classmatesResult.data || []).filter((c: any) => c.group_number !== 99); // exclude 測試帳號
    const messages = messagesResult.data || [];

    // Build classmates knowledge text
    const classmatesText = classmates.map((c: any, idx: number) => {
      const group = c.group_number === 0 ? "講師/助教"
        : c.group_number ? `第${c.group_number}組` : "未分組";
      const lines: string[] = [];
      lines.push(`【${idx + 1}】${c.display_name}`);
      if (c.company) lines.push(`  公司：${c.company}`);
      if (c.job_title) lines.push(`  職稱：${c.job_title}`);
      lines.push(`  組別：${group}`);
      if (c.intro_text) lines.push(`  自我介紹：${c.intro_text}`);
      return lines.join("\n");
    }).join("\n\n");

    // Build lookup from line_user_id to name
    const idToName: Record<string, string> = {};
    for (const c of classmates) {
      if (c.line_user_id && c.display_name) idToName[c.line_user_id] = c.display_name;
    }

    // Group messages by recipient
    const msgByRecipient: Record<string, string[]> = {};
    for (const m of messages) {
      const recipient = idToName[m.to_member_id];
      if (!recipient) continue; // skip messages to hidden accounts
      if (!msgByRecipient[recipient]) msgByRecipient[recipient] = [];
      msgByRecipient[recipient].push(`${m.from_display_name || "某同學"}：${m.content}`);
    }
    const messagesText = Object.entries(msgByRecipient)
      .map(([name, msgs]) => `【給 ${name} 的留言】\n${msgs.join("\n")}`)
      .join("\n\n");

    const systemPrompt = `# 角色
你是「台灣人工智慧學校 經理人 AI PM 班第一期」的 AI 同學助手。你的工作是幫助同學們更快認識彼此。

# 你的知識庫
下方是從資料庫即時取得的同學資料與留言內容，這些是你要回答問題的唯一事實來源。

=== 同學資料（共 ${classmates.length} 位）===
${classmatesText || "（目前還沒有同學填寫自我介紹）"}

${messagesText ? `\n=== 同學牆留言 ===\n${messagesText}\n` : ""}

# 回答方式
1. 主動、積極地根據上述資料回答問題
2. 回答簡潔（2-4 句話），避免一次列出所有人
3. 如被問到某位同學，提供他的公司、職稱、組別、自我介紹重點
4. 可回答統計問題，例如「科技業有幾位？」「第幾組有幾位？」「誰提過 AI？」
5. 可根據關鍵字搜尋同學，例如「誰做產品管理？」「有沒有做金融的？」
6. 用繁體中文回答（除非用戶用英文提問）
7. 對話語氣友善親切，像在幫同學互相介紹
8. 只有在問題完全無關（例如問天氣、股市）時，才說「這不在我的範圍內」
9. 不要編造資料中沒有的細節——若不知道就誠實說
10. 回答可引用同學姓名並加上相關資訊

# 範例互動
- Q: 「有哪些人做 AI 相關？」→ 列出 2-3 位相關同學，每位簡短一句介紹
- Q: 「第 4 組有誰？」→ 列出第 4 組的同學姓名 + 公司/職稱
- Q: 「Mark 是誰？」→ 提供 Mark 的公司、職稱、自我介紹重點
- Q: 「誰提到 AI PM？」→ 搜尋自我介紹中含相關關鍵字的同學`;

    const safeHistory = history
      .filter((h: any) => h.role === "user" || h.role === "assistant")
      .map((h: any) => ({ role: h.role, content: String(h.content).slice(0, 500) }))
      .slice(-10);

    const aiMessages = [
      { role: "system", content: systemPrompt },
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
        max_tokens: 600,
        temperature: 0.5,
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
    const reply = data.choices?.[0]?.message?.content || "抱歉，我暫時無法回應。";

    // Log to classmates_chat_logs
    try {
      await sb.from("classmates_chat_logs").insert({
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
