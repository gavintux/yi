// 允許呼叫此 Worker 的網域白名單
const ALLOWED_ORIGINS = [
    "https://yi.gavintux.workers.dev",
    "http://yi.gavintux.workers.dev",
    "https://gavintux.github.io",
    "http://gavintux.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:5500",
    "null"
];

function getCorsHeaders(origin) {
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : "https://yi.gavintux.workers.dev";
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

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method === "GET") {
            const isHealthCheck = url.pathname === "/api/health" || url.searchParams.has("health");
            if (!isHealthCheck && env.ASSETS && typeof env.ASSETS.fetch === "function") {
                return env.ASSETS.fetch(request);
            }
            return new Response(
                JSON.stringify({
                    status: "ok",
                    service: "ZenLife I-Ching Cloudflare Worker Proxy",
                    pageUrl: "https://yi.gavintux.workers.dev/",
                    hasApiKeyConfigured: Boolean(env.GEMINI_API_KEY)
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" } }
            );
        }

        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
                status: 405,
                headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
            });
        }

        if (origin && !ALLOWED_ORIGINS.includes(origin)) {
            return new Response(JSON.stringify({ error: `Forbidden Origin: ${origin}` }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
            });
        }

        if (!env.GEMINI_API_KEY) {
            return new Response(JSON.stringify({ error: "尚未在 Cloudflare Worker 設定 GEMINI_API_KEY 環境變數。" }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
            });
        }

        try {
            const body = await request.json();
            const targetModel = url.searchParams.get("model") || body.model || "gemini-2.5-flash";

            let geminiPayload;
            if (body.contents) {
                geminiPayload = { ...body };
                delete geminiPayload.model;
            } else {
                geminiPayload = {
                    contents: [{ parts: [{ text: String(body.prompt || "") }] }]
                };
                if (body.systemInstruction) geminiPayload.systemInstruction = body.systemInstruction;
                if (body.generationConfig) geminiPayload.generationConfig = body.generationConfig;
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
                headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
            });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message || "Internal Worker Error" }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" }
            });
        }
    }
};