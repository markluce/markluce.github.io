import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Config cache (60s TTL)
let configCache: { prompt: string | null; ts: number } | null = null;
const CONFIG_TTL_MS = 60 * 1000;

async function getCustomPrompt(sb: any): Promise<string | null> {
  const now = Date.now();
  if (configCache && (now - configCache.ts) < CONFIG_TTL_MS) {
    return configCache.prompt;
  }
  try {
    const { data } = await sb.from('bot_configs').select('system_prompt').eq('bot_name', 'classmates').maybeSingle();
    const prompt = (data?.system_prompt && data.system_prompt.trim()) ? data.system_prompt : null;
    configCache = { prompt, ts: now };
    return prompt;
  } catch (e) {
    console.error('getCustomPrompt error:', e);
    return null;
  }
}

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
        : c.group_number === 10 ? "課程經理/校務"
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

    // Default instructions template — uses {DATA_BLOCK} placeholder
    const DEFAULT_TEMPLATE = `# 角色
你是「台灣人工智慧學校 經理人 AI PM 班第一期」的 AI 同學助手。你的工作是幫助同學們更快認識彼此。

# 你的知識庫
下方是從資料庫即時取得的同學資料與留言內容，這些是你要回答問題的唯一事實來源。

{DATA_BLOCK}

# 回答方式
1. 主動、積極地根據上述資料回答問題
2. **仔細閱讀每位同學的姓名、公司、職稱、自介全文**，逐字比對關鍵字
3. 回答簡潔（2-4 句話），避免一次列出所有人
4. 被問到某位同學時，提供他的公司、職稱、組別、自我介紹重點
5. 可回答統計問題（「幾位？」）、組別問題、關鍵字搜尋
6. 用繁體中文回答
7. **如果找不到符合條件的同學，明確回答「目前沒有同學的姓名或公司包含這個字」，絕對不要隨便給出不相關的答案**
8. 只有問完全無關話題（天氣、股市）時，才說「這不在我範圍內」
9. 不要編造資料中沒有的細節
10. 每次回答都要針對用戶的「當下問題」回答，不要被之前的對話脈絡誤導

# 搜尋類問題處理步驟
當用戶說「找姓名/公司包含 X 的」或「有哪些姓名/公司有 X 字」時：
1. 逐一檢查每位同學的姓名、公司字串
2. 只回報**確實包含**該字元的同學
3. 若無任何符合，直接回答「目前沒有」，不要硬湊答案
4. 不要把「AI 相關」「產品管理」等其他主題混進搜尋結果

# 範例互動
- Q: 「第 4 組有誰？」→ 只列 group_number=4 的同學
- Q: 「Mark 是誰？」→ 提供 Mark 的公司、職稱、自介重點
- Q: 「姓名或公司有智的同學」→ 只回報實際包含「智」字的人；若沒有就回答「目前沒有」`;

    // Build data block from live DB
    const dataBlock = `=== 同學資料（共 ${classmates.length} 位）===
${classmatesText || "（目前還沒有同學填寫自我介紹）"}

${messagesText ? `\n=== 同學牆留言 ===\n${messagesText}\n` : ""}`;

    // Use custom template from DB if set, else default; inject data
    const customTemplate = await getCustomPrompt(sb);
    const template = customTemplate || DEFAULT_TEMPLATE;
    const systemPrompt = template.includes('{DATA_BLOCK}')
      ? template.replace('{DATA_BLOCK}', dataBlock)
      : template + '\n\n' + dataBlock;

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
