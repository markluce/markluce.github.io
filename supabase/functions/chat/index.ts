import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  // CORS preflight
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
    const { message, history = [] } = await req.json();

    // Input validation
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

    // Azure OpenAI config from secrets
    const endpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
    const apiKey = Deno.env.get("AZURE_OPENAI_KEY");
    const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT") || "gpt-4o";

    if (!endpoint || !apiKey) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch classmates data from Supabase (service role bypasses RLS)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    const [classmatesResult, messagesResult] = await Promise.all([
      sb.from("classmates").select("display_name, company, job_title, group_number, intro_text, line_user_id"),
      sb.from("member_messages").select("from_display_name, to_member_id, content"),
    ]);

    const classmates = classmatesResult.data || [];
    const messages = messagesResult.data || [];

    // Build classmates knowledge
    const classmatesText = classmates.map((c: any) => {
      const group = c.group_number === 0 ? "講師/助教"
        : c.group_number === 99 ? "測試帳號"
        : c.group_number ? `第${c.group_number}組` : "未分組";
      const parts = [c.display_name];
      if (c.company) parts.push(c.company);
      if (c.job_title) parts.push(c.job_title);
      parts.push(group);
      if (c.intro_text) parts.push(`自介：${c.intro_text}`);
      return parts.join(" | ");
    }).join("\n");

    // Build a lookup from line_user_id to display_name
    const idToName: Record<string, string> = {};
    for (const c of classmates) {
      if (c.line_user_id && c.display_name) idToName[c.line_user_id] = c.display_name;
    }

    // Build messages knowledge grouped by recipient
    const msgByRecipient: Record<string, string[]> = {};
    for (const m of messages) {
      const recipientName = idToName[m.to_member_id] || "unknown";
      if (!msgByRecipient[recipientName]) msgByRecipient[recipientName] = [];
      msgByRecipient[recipientName].push(`${m.from_display_name}：${m.content}`);
    }
    const messagesText = Object.entries(msgByRecipient)
      .map(([name, msgs]) => `給 ${name} 的留言：\n${msgs.join("\n")}`)
      .join("\n\n");

    const systemPrompt = `你是「台灣人工智慧學校 經理人 AI PM 班」的 AI 助手。

你的角色：友善、簡潔地回答訪客關於同學的問題。幫助同學們更快認識彼此。

=== 同學資料（共 ${classmates.length} 位）===
${classmatesText || "目前還沒有同學資料"}

${messagesText ? `=== 同學留言 ===\n${messagesText}` : ""}

規則：
1. 只回答與 AI PM 班同學相關的問題
2. 如果問到不相關的話題，禮貌地引導回同學介紹
3. 回答簡短（2-3句話），不要一次列出所有人
4. 如果被問到某位同學，提供他/她的公司、職稱、組別、自我介紹等資訊
5. 可以回答統計性問題，例如「有幾個人來自科技業？」
6. 用繁體中文回答，除非訪客用英文提問
7. 不要編造不在資料中的內容
8. 每次回答結尾可提供 1-2 個延伸建議`;

    // Sanitize history — only allow role "user" and "assistant"
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
        max_tokens: 400,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Azure OpenAI error:", err);
      return new Response(JSON.stringify({ error: "AI service error" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "抱歉，我暫時無法回應。";

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
