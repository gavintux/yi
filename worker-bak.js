/**
 * 禪生活 · 易經晨間提點 (ZenLife I-Ching) — Cloudflare Worker 安全代理
 * =========================================================================
 * 用途：
 * 1. 將 GEMINI_API_KEY 隱藏在 Cloudflare 環境變數 (Secret) 中，前端 yilife.html 完全不需帶 Key。
 * 2. 限制 CORS 與 Origin，只允許來自 https://gavintux.github.io 的請求呼叫。
 *
 * 部署步驟（對應您目前的 `yi.gavintux.workers.dev` 畫面）：
 * 1. 點擊畫面右上角的「</> 編輯代碼」按鈕：
 *    - 將裡面預設的程式碼全部刪除，把本檔案 (`worker.js`) 內容完整貼上。
 *    - 點擊右上角的「部署 (Deploy)」儲存程式碼。
 * 2. 回到這個畫面，點選上方導覽列最右邊的「設定 (Settings)」分頁：
 *    - 找到「變數與機密 (Variables and Secrets)」區塊，點選「+ 新增 (Add)」。
 *    - 類型 (Type) 選擇：「機密 (Secret)」
 *    - 變數名稱 (Variable name) 輸入：GEMINI_API_KEY
 *    - 值 (Value) 輸入：您的 Google Gemini API Key (AIzaSy...)
 *    - 點擊部署/儲存後即大功告成！
 */

// 允許呼叫此 Worker 的網域白名單
const ALLOWED_ORIGINS = [
    "https://yi.gavintux.workers.dev",
    "http://yi.gavintux.workers.dev",
    "https://gavintux.github.io",
    "http://gavintux.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:5500",
    "null" // 允許直接雙擊打開本機 yilife.html 檔案測試
];

function getCorsHeaders(origin) {
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
        ? origin
        : "https://yi.gavintux.workers.dev";

    return {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Max-Age": "86400"
    };
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin") || "";
        const corsHeaders = getCorsHeaders(origin);

        // 1. 處理瀏覽器 CORS 預檢請求 (Preflight OPTIONS)
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        // 2. 處理 GET 請求：
        //    - 若您瀏覽 https://yi.gavintux.workers.dev/yilife.html，優先回傳靜態網頁 (ASSETS)
        //    - 若為健康檢查 (?health=1 或 /api/health 或無靜態資源時的根目錄)，回傳 JSON 狀態
        if (request.method === "GET") {
            const isHealthCheck =
                url.pathname === "/api/health" || url.searchParams.has("health");

            if (!isHealthCheck && env.ASSETS && typeof env.ASSETS.fetch === "function") {
                // 讓 Cloudflare Workers Static Assets 直接提供 /yilife.html 等靜態檔案
                return env.ASSETS.fetch(request);
            }

            return new Response(
                JSON.stringify({
                    status: "ok",
                    service: "ZenLife I-Ching Cloudflare Worker Proxy",
                    pageUrl: "https://yi.gavintux.workers.dev/yilife.html",
                    hasApiKeyConfigured: Boolean(env.GEMINI_API_KEY)
                }),
                {
                    status: 200,
                    headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
                }
            );
        }

        // 3. 僅允許 POST 請求進行解卦
        if (request.method !== "POST") {
            return new Response(
                JSON.stringify({ error: "Method Not Allowed" }),
                {
                    status: 405,
                    headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
                }
            );
        }

        // 4. 驗證來源網域 (防止他人拿您的 Worker 網址去別的網站刷流量)
        if (origin && !ALLOWED_ORIGINS.includes(origin)) {
            return new Response(
                JSON.stringify({
                    error: `Forbidden Origin: ${origin}. Only gavintux.github.io is allowed.`
                }),
                {
                    status: 403,
                    headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
                }
            );
        }

        // 5. 檢查 Cloudflare 後端是否已設定 GEMINI_API_KEY
        if (!env.GEMINI_API_KEY) {
            return new Response(
                JSON.stringify({
                    error: "尚未在 Cloudflare Worker 設定 GEMINI_API_KEY 環境變數 (Variables and Secrets)。"
                }),
                {
                    status: 500,
                    headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
                }
            );
        }

        try {
            const body = await request.json();

            // 支援儲存庫內所有其他網頁自訂模型 (透過 URL ?model=xxx 或 body.model 指定，預設為 gemini-2.5-flash)
            const targetModel =
                url.searchParams.get("model") ||
                body.model ||
                "gemini-2.5-flash";

            // 複製 payload 並移除自訂的 model 欄位，保留 contents / systemInstruction / generationConfig / safetySettings 等所有原生參數
            let geminiPayload;
            if (body.contents) {
                geminiPayload = { ...body };
                delete geminiPayload.model;
            } else {
                // 相容簡化格式 `{ prompt: "...", systemInstruction: "..." }`
                geminiPayload = {
                    contents: [
                        {
                            parts: [{ text: String(body.prompt || "") }]
                        }
                    ]
                };
                if (body.systemInstruction) {
                    geminiPayload.systemInstruction = body.systemInstruction;
                }
                if (body.generationConfig) {
                    geminiPayload.generationConfig = body.generationConfig;
                }
            }

            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${env.GEMINI_API_KEY}`;

            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(geminiPayload)
            });

            const data = await geminiResp.json();

            return new Response(JSON.stringify(data), {
                status: geminiResp.status,
                headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json;charset=UTF-8"
                }
            });
        } catch (err) {
            return new Response(
                JSON.stringify({ error: err.message || "Internal Worker Error" }),
                {
                    status: 500,
                    headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
                }
            );
        }
    }
};