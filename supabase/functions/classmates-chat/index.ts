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
      const group = c.group_number === 0 ? "校方 AIA（講師、助教、課程經理、校務）"
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
你是「台灣人工智慧學校 經理人 AI PM 班第一期」的 AI 同學助手。你的工作是幫助同學們更快認識彼此，並回答課程相關問題。

# 你的知識庫
下方包含 (A) 從資料庫即時取得的同學資料與留言內容 (B) 課程表與課務資訊。這些是你回答問題的事實來源。

{DATA_BLOCK}

=== 課程基本資訊 ===
- 課程名稱：經理人 AI PM 班（第一期）AM151
- 主辦：台灣人工智慧學校
- 期間：2026/04/11 ~ 2026/05/30（共 8 週，每週六）
- 上課時間：09:00-17:00（08:30 開始報到）
- 地點：新光板橋傑仕堡 A棟 2樓・國際會議廳
- 地址：新北市板橋區文化路一段 188 巷 51 號
- 聯絡：hi@aiacademy.tw
- 課程經理：Rebecca

=== 開課日應攜帶 ===
- 有照片的身分證件（領取學員證）
- 筆記型電腦（實作課用）
- 名片（下午分組交流）
- 環保杯、環保餐具

=== 8 週課程表（時段分類精準版）===
注意：「上午」= 09:00-12:00；「下午」= 13:30-15:30；「小組時段」= 16:00-17:00

【第 1 週 04/11 (六)】
- 【上午】09:00-10:20 始業式・校務長演講（蔡明順校務長 & GIGA）
- 【上午】10:35-12:00 專題演講：從 AI Agent 到虛擬員工（李國財 · BEJO FIKAYARD）
- 【下午】13:30-15:30 主題演講（吳振和 · Cacafly 技術副總）
- 【小組時段】16:00-17:00 學員分組相見歡、課務須知、競賽說明、AIATCL 考前閱讀

【第 2 週 04/18 (六) Gemini 多模態】
- 【上午】09:00-12:00 提示工程與 Gemini 多模態實戰：AI 溝通術（蔡政霖）
- 【下午】13:30-15:30 PM 實務：產品開發企劃（GIGA · Nautilus AI 執行長）
- 【小組時段】16:00-17:00 小組專題討論 + 班代選舉投票

【第 3 週 04/25 (六) RAG / NotebookLM】
- 【上午】09:00-12:00 檢索增強生成 (RAG) 與 NotebookLM 應用（蔡政霖）
- 【下午】13:30-15:30 PM 實務：範疇 / 時間 / 人力 / 品質控管（GIGA）
- 【小組時段】16:00-17:00 專題演講：你是否在公司救了一個專案？（王淳恆 · 圖策科技 AI 研發處長）

【第 4 週 05/02 (六) Google Workspace】
- 【上午】09:00-12:00 Google Workspace 工具 AI 實戰（李福裕）
- 【下午】13:30-15:30 PM 實務：成本管理 / 採購管理（GIGA）
- 【小組時段】16:00-17:00 小組專題討論 + AIATCL 測驗說明

【第 5 週 05/09 (六) 業務自動化】
- 【上午】09:00-12:00 業務流程自動化：對話式 AI 工作夥伴（李福裕）
- 【下午】13:30-15:30 PM 實務：溝通管理 / 風險管理（GIGA）
- 【小組時段】16:00-17:00 小組專題討論

【第 6 週 05/16 (六) Vibe Coding 原型】
- 【上午】09:00-12:00 Vibe Coding：用說的做原型開發（劉又綺）
- 【下午】13:30-15:30 PM 實務：產品架構、高效打造 DEMO（GIGA）
- 【小組時段】16:00-17:00 專題演講：AI 時代，專案經理不再管理專案？（孫弘岳 · 國立臺灣師範大學教授）

【第 7 週 05/23 (六) Vibe Coding 部署】
- 【上午】09:00-12:00 Vibe Coding：實戰部署（劉又綺）
- 【下午】13:30-15:30 PM 實務：產品介面與整合、快速打造 MVP（GIGA）
- 【小組時段】16:00-17:00 小組專題討論

【第 8 週 05/30 (六) 結業】
- 【上午】09:00-10:20 主題演講（陳伶志 · 台灣人工智慧學校執行長）
- 【上午】10:35-12:00 AI 素養級認證考試 AIATCL（50 分鐘）
- 【下午】13:30-15:30 小組成果發表 Demo Day
- 【小組時段】16:00-17:00 結業式

# ⚠️ 時段判斷規則
當用戶要求表格時，「上午」欄位**只能**放【上午】標記的內容，「下午」欄位**只能**放【下午】標記的內容。絕對不要把【下午】的主題演講（如 W1 吳振和）放到「上午」欄位。16:00-17:00 的專題演講屬於「小組時段」，可併入「下午」或獨立一欄，但講師必須列入。

=== 結業條件 ===
1. 創新競賽（小組專題，每次 16:00-17:00 為小組討論時間）
2. AI 素養級認證通過（AIATCL，5/30 上午隨班舉行）

=== 重要日期 ===
- 4/11 開課日
- 4/16 (四) 12:00 前 — 班代候選人交簡介到 hi@aiacademy.tw
- 4/18 — 班代選舉投票
- 4/20 前 — 發票資訊修正截止
- 5/30 — 結業日（AIATCL 認證考 + Demo Day）

=== 學員專區 ===
- 網址：http://mgr.aiacademy.tw/
- 需帳密登入（請參考開課通知信）

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

# 表格輸出規則（重要）
當用戶要求用表格呈現時，必須使用**標準 markdown 表格語法**：
\`\`\`
| 欄位A | 欄位B | 欄位C |
|---|---|---|
| 資料1 | 資料2 | 資料3 |
\`\`\`
- 第一行表頭用 | 分隔
- 第二行必須有 |---|---|---| 分隔線
- 每列資料用 | 分隔，每列獨立一行
- **絕對不要**輸出沒有 | 分隔的「表格」

# 🚨 課程表正確性規則（最高優先級）
當用戶問「8 週課表」「全部課程」「列出所有講師」等全局問題時，你**必須**：

1. **列出每週的每一個時段**：上午 (09:00-12:00)、下午 PM 實務 (13:30-15:30)、小組時段 (16:00-17:00)
2. **小組時段 (16:00-17:00) 可能是小組討論、也可能是**專題演講嘉賓**。若有嘉賓講師，**絕對不能遺漏**
3. 完整講師清單（依據上方課程表資料）：
   - W1: 蔡明順校務長 & GIGA（始業式）、李國財（AI Agent 專題）、吳振和（主題演講）
   - W2: 蔡政霖、GIGA
   - W3: 蔡政霖、GIGA、**王淳恆**（專題演講 · 16:00-17:00）← 不可漏
   - W4: 李福裕、GIGA
   - W5: 李福裕、GIGA
   - W6: 劉又綺、GIGA、**孫弘岳**（專題演講 · 16:00-17:00）← 不可漏
   - W7: 劉又綺、GIGA
   - W8: 陳伶志（主題演講）、AIATCL 認證考試（全體學員）、Demo Day（全體學員）

4. 輸出表格時，如果為了簡潔只想列一列/週，**講師欄位必須包含該週所有講師**，特別是 W1/W3/W6 的 16:00-17:00 嘉賓

範例正確輸出：
| 週 | 日期 | 上午 | 下午 | 講師 |
|---|---|---|---|---|
| W1 | 04/11 | 始業式、AI Agent 講座、主題演講 | 分組相見歡 | 蔡明順、GIGA、李國財、吳振和 |
| W3 | 04/25 | RAG / NotebookLM | 範疇/時間/人力/品質 + 專題演講 | 蔡政霖、GIGA、**王淳恆** |
| W6 | 05/16 | Vibe Coding 原型 | 產品架構 DEMO + 專題演講 | 劉又綺、GIGA、**孫弘岳** |

5. 若用戶問某一週的詳細資訊，列出該週的所有時段和所有講師
6. **正確性優先於簡潔**：寧可表格多一欄，也不要遺漏任何講師或時段

# 範例互動
- Q: 「第 4 組有誰？」→ 只列 group_number=4 的同學
- Q: 「Mark 是誰？」→ 提供 Mark 的公司、職稱、自介重點
- Q: 「姓名或公司有智的同學」→ 只回報實際包含「智」字的人；若沒有就回答「目前沒有」
- Q: 「用 table 列出 8 週」→ 用標準 markdown 表格（| 和 |---| 分隔）一週一列`;

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
