import { Actor, Entrypoint, handler, ActorState } from '@cloudflare/actors';

export interface Env {
    AI: any; 
}

// -------------------------------------------------
// 1. HELPER: Robust JSON Extraction (FIXED FOR ARRAYS)
// -------------------------------------------------
function extractJson(response: any): any {
    let rawText = typeof response === 'string' ? response : (response?.choices?.[0]?.message?.content || response?.response || JSON.stringify(response));
    let cleaned = rawText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, '$1').trim();
    
    // Find the first and last JSON boundaries (supports both Objects {} and Arrays [])
    const firstCurly = cleaned.indexOf('{');
    const lastCurly = cleaned.lastIndexOf('}');
    const firstSquare = cleaned.indexOf('[');
    const lastSquare = cleaned.lastIndexOf(']');

    let firstIndex = (firstCurly !== -1 && firstSquare !== -1) ? Math.min(firstCurly, firstSquare) : Math.max(firstCurly, firstSquare);
    let lastIndex = (lastCurly !== -1 && lastSquare !== -1) ? Math.max(lastCurly, lastSquare) : Math.max(lastCurly, lastSquare);

    if (firstIndex !== -1 && lastIndex !== -1 && lastIndex > firstIndex) {
        cleaned = cleaned.substring(firstIndex, lastIndex + 1);
    }
    try { return JSON.parse(cleaned); } catch { return null; }
}

// -------------------------------------------------
// 2. ROUTER (ENTRYPOINT)
// -------------------------------------------------
export class ApiRouter extends Entrypoint<Env> {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const actorName = url.searchParams.get("name") || url.searchParams.get("id") || "default";
        const actor = ApiAgentActor.get(actorName);
        return await actor.fetch(request);
    }
}

// -------------------------------------------------
// 3. THE AI AGENT (ACTOR)
// -------------------------------------------------
export class ApiAgentActor extends Actor<Env> {
    
    constructor(ctx: ActorState, env: Env) {
        super(ctx, env);
        this.storage.migrations = [
            {
                idMonotonicInc: 1,
                description: "Initialize Schema and Chat History Tables",
                sql: `
                    CREATE TABLE IF NOT EXISTS schema_store (id INTEGER PRIMARY KEY, content TEXT);
                    CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT);
                `
            },
            {
                idMonotonicInc: 2,
                description: "Add metadata column to schema_store",
                sql: `ALTER TABLE schema_store ADD COLUMN metadata TEXT;`
            }
        ];
    }

    protected async onRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);
        await this.storage.runMigrations();

        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            this.ctx.acceptWebSocket(server);
            this.handleConnect(server);
            return new Response(null, { status: 101, webSocket: client });
        }

        if (request.method === "POST" && (url.pathname.endsWith("/schema") || url.pathname === "/schema")) {
            const schemaRaw = await request.text();
            const meta = this.saveSchema(schemaRaw);
            this.broadcast({ type: "schema_updated", message: "Schema uploaded", metadata: meta });
            return new Response(JSON.stringify({ success: true, metadata: meta }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("API Agent Ready", { status: 200 });
    }

    private async handleConnect(ws: WebSocket) {
        try {
            const historyRows = this.sql`SELECT id FROM chat_history;`;
            const schemaRes = this.sql`SELECT metadata FROM schema_store WHERE id = 1 LIMIT 1;`;
            const hasSchema = schemaRes.length > 0;
            const metadata = (hasSchema && schemaRes[0].metadata) ? JSON.parse(schemaRes[0].metadata) : null;

            ws.send(JSON.stringify({ type: "init", historyLength: historyRows.length, hasSchema, schemaMetadata: metadata }));
        } catch (err) { console.error("Connect error:", err); }
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        const rawMessage = typeof message === 'string' ? message : new TextDecoder().decode(message);
        await this.processMessage(ws, rawMessage);
    }

    async webSocketClose() { console.log("Client disconnected."); }

    private broadcast(data: any) {
        const msg = JSON.stringify(data);
        for (const ws of this.ctx.getWebSockets()) {
            try { ws.send(msg); } catch (e) {}
        }
    }

    private saveSchema(schemaInput: string | object): any {
        let parsed: any;
        let stringContent = typeof schemaInput === 'string' ? schemaInput : JSON.stringify(schemaInput);
        try { parsed = typeof schemaInput === 'string' ? JSON.parse(schemaInput) : schemaInput; } 
        catch { parsed = { info: { title: "OpenAPI Schema" } }; }

        const metadata = {
            title: parsed?.info?.title || "API Specification",
            version: parsed?.info?.version || "1.0.0",
            servers: parsed?.servers || [],
            pathsCount: parsed?.paths ? Object.keys(parsed.paths).length : 0
        };

        this.sql`INSERT OR REPLACE INTO schema_store (id, content, metadata) VALUES (1, ${stringContent}, ${JSON.stringify(metadata)});`;
        return metadata;
    }

    // -------------------------------------------------
    // CORE MESSAGE ROUTING & PROCESSING
    // -------------------------------------------------
    private async processMessage(ws: WebSocket, rawMessage: string) {
        try {
            const payload = JSON.parse(rawMessage);

            if (payload.action === "load_schema" || payload.action === "get_schema") return this.handleSystemActions(ws, payload);
            if (payload.action === "execute_and_analyze") return this.handleExecution(ws, payload);

            let query = payload.query || payload.text || "";
            let action = payload.action;

            // Failsafe for older frontend cache
            if (action === "generate_request") action = "reqgenerate";

            if (typeof query === 'string' && query.startsWith('/')) {
                if (query.startsWith('/reranker')) { action = 'reranker'; query = query.replace('/reranker', '').trim(); }
                else if (query.startsWith('/reqgenerate')) { action = 'reqgenerate'; query = query.replace('/reqgenerate', '').trim(); }
                else if (query.startsWith('/dataanalysis')) { action = 'dataanalysis'; query = query.replace('/dataanalysis', '').trim(); }
                else if (query.startsWith('/chat')) { action = 'chat'; query = query.replace('/chat', '').trim(); }
            }

            if (!action || action === "auto") {
                this.broadcast({ type: "status", message: "Thinking..." });
                const intentPrompt = `Classify this request into exactly one category: RERANKER, REQGENERATE, DATAANALYSIS, or CHAT.
                - RERANKER: Searching for API endpoints, asking "which endpoint to use".
                - REQGENERATE: Building, filling out, or creating an API request JSON/payload.
                - DATAANALYSIS: Analyzing data, metrics, or API responses.
                - CHAT: General conversation, answering questions, or referencing previous chat history.
                
                Request: "${query}"
                Output ONLY the category word.`;
                
                const intentRes = await this.env.AI.run('@cf/qwen/qwen3.8-27b', { messages: [{ role: 'user', content: intentPrompt }] });
                const intentText = intentRes.response?.trim().toUpperCase() || 'CHAT';
                
                if (intentText.includes('RERANKER')) action = 'reranker';
                else if (intentText.includes('REQGENERATE')) action = 'reqgenerate';
                else if (intentText.includes('DATAANALYSIS')) action = 'dataanalysis';
                else action = 'chat';
                
                this.broadcast({ type: "intent_routed", intent: action });
            }

            if (query) this.sql`INSERT INTO chat_history (role, content) VALUES ('user', ${query});`;

            const schemaRes = this.sql`SELECT content, metadata FROM schema_store WHERE id = 1 LIMIT 1;`;
            const schemaContent = schemaRes.length > 0 ? schemaRes[0].content : "";
            const schemaMetadata = schemaRes.length > 0 ? schemaRes[0].metadata : "";

            switch (action) {
                case 'chat': await this.runChatMode(query, schemaMetadata); break;
                case 'reranker': await this.runRerankerTool(query, schemaContent); break;
                case 'reqgenerate': await this.runReqGenerateTool(query, schemaContent); break;
                case 'dataanalysis': await this.runDataAnalysisTool(payload.apiResponse, query); break;
                default: ws.send(JSON.stringify({ error: `Unknown routed action: ${action}` }));
            }

        } catch (error: any) {
            console.error("Agent Error:", error);
            this.broadcast({ type: "status", message: "" });
            ws.send(JSON.stringify({ error: `Agent Error: ${error.message}` }));
        }
    }

    // ==========================================
    // ACTION HANDLERS
    // ==========================================

    private async runChatMode(query: string, schemaMetadata: string) {
        this.broadcast({ type: "status", message: "Chatting..." });
        
        const rawHistoryRows = this.sql`SELECT role, content FROM chat_history ORDER BY id DESC LIMIT 10;`;
        const historyRows = [...rawHistoryRows].reverse();

        const messages = historyRows.map((row: any) => ({
            role: row.role === 'user' ? 'user' : 'assistant',
            content: row.content
        }));

        let meta = "None";
        try { if(schemaMetadata) { const m = JSON.parse(schemaMetadata); meta = `${m.title} (${m.pathsCount} endpoints)`; } } catch(e){}

        messages.unshift({ 
            role: 'system', 
            content: `You are an API Assistant. Loaded API: ${meta}. 
            You have access to the chat history and previous tool results. 
            Answer the user conversationally. If they need to build a payload, suggest they use /reqgenerate. If they need to find an endpoint, suggest /reranker.` 
        });

        const response = await this.env.AI.run('@cf/qwen/qwen3.8-27b', { messages });
        const textResponse = response.response || response.choices?.[0]?.message?.content || "No response generated.";

        this.sql`INSERT INTO chat_history (role, content) VALUES ('assistant', ${textResponse});`;
        this.broadcast({ type: "chat_reply", message: textResponse });
    }

    // ------------------------------------------------------------------
    // UPDATED RERANKER TOOL (Uses Qwen LLM instead of missing BAAI Model)
    // ------------------------------------------------------------------
    private async runRerankerTool(query: string, schemaContent: string) {
        if (!schemaContent) return this.broadcast({ error: "No schema loaded." });
        this.broadcast({ type: "status", message: "AI is finding the best endpoints..." });
        
        const docs: string[] = [];
        const docMeta: any[] = [];
        try {
            const parsed = JSON.parse(schemaContent);
            if (parsed.paths) {
                for (const [path, methods] of Object.entries(parsed.paths)) {
                    for (const [method, details] of Object.entries(methods as any)) {
                        if (['get','post','put','delete','patch'].includes(method.toLowerCase())) {
                            const desc = details.summary || details.description || '';
                            docs.push(`[${docs.length}] ${method.toUpperCase()} ${path} - ${desc}`);
                            docMeta.push({ operationKey: `${method.toUpperCase()}::${path}`, description: desc });
                        }
                    }
                }
            }
        } catch (e) {}

        if (docs.length === 0) return this.broadcast({ error: "No endpoints found in schema." });

        const prompt = `You are an API Endpoint Matcher.
        User Query: "${query}"
        
        Available Endpoints:
        ${docs.join('\n')}
        
        Select the top 3 most relevant endpoints for the query.
        Respond ONLY with a raw JSON array of objects in this exact format, ordered by relevance:
        [
          { "index": 0, "score": 0.95 },
          { "index": 3, "score": 0.85 }
        ]
        Do not include markdown blocks or backticks.`;

        try {
            const response = await this.env.AI.run('@cf/qwen/qwen3.8-27b', { 
                messages: [{ role: 'user', content: prompt }] 
            });
            
            const parsedRes = extractJson(response) || [];
            
            // Map the JSON output back to our docMeta array
            const topResults = parsedRes.slice(0, 3).map((res: any) => ({
                ...docMeta[res.index], 
                score: res.score || 0.5
            })).filter((r: any) => r.operationKey);

            if (topResults.length === 0) throw new Error("No endpoints matched.");

            const toolData = { operationKey: topResults[0]?.operationKey, readyToExecute: false, matches: topResults };
            this.sql`INSERT INTO chat_history (role, content) VALUES ('assistant', ${'[TOOL: RERANKER Result] ' + JSON.stringify(toolData)});`;
            this.broadcast({ type: "form_fill", data: toolData });

        } catch (error) {
            console.error("Endpoint Matcher Error", error);
            // Fallback gracefully if AI fails to parse JSON
            const fallbackResults = docMeta.slice(0, 3).map(m => ({ ...m, score: 0.5 }));
            const toolData = { operationKey: fallbackResults[0]?.operationKey, readyToExecute: false, matches: fallbackResults };
            this.broadcast({ type: "form_fill", data: toolData });
        }
    }

    private async runReqGenerateTool(query: string, schemaContent: string) {
        if (!schemaContent) return this.broadcast({ error: "No schema loaded." });
        this.broadcast({ type: "status", message: "Generating API Request Payload..." });

        const systemInstruction = `You are an API Request Generator. OpenAPI Schema: ${schemaContent}
        Respond ONLY with raw JSON. No markdown backticks.
        Format: { "operationKey": "METHOD::/path", "params": {}, "body": {}, "missingRequiredFields": [], "readyToExecute": boolean }`;

        const response = await this.env.AI.run('@cf/qwen/qwen3.8-27b', { 
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: query }
            ] 
        });
        const parsedData = extractJson(response);

        if(!parsedData) return this.broadcast({ error: "Failed to generate payload. Try rephrasing." });

        this.sql`INSERT INTO chat_history (role, content) VALUES ('assistant', ${'[TOOL: REQGENERATE Result] Generated Payload: ' + JSON.stringify(parsedData)});`;
        this.broadcast({ type: "form_fill", data: parsedData });
    }

    private async runDataAnalysisTool(apiResponse: any, query: string) {
        this.broadcast({ type: "status", message: "Analyzing Data..." });

        const prompt = `You are a Data Analyst. Analyze this API Response: ${JSON.stringify(apiResponse, null, 2)}
        User Query: "${query || 'Analyze data'}"
        Respond ONLY with raw JSON: { "summary": "...", "insights": ["..."], "suggestions": ["..."], "visualization": { "isRelevant": boolean, "chartType": "bar|line|doughnut|null", "htmlSnippet": "Tailwind+Chart.js or null" } }`;

        const response = await this.env.AI.run('@cf/qwen/qwen3.8-27b', { messages: [{ role: 'user', content: prompt }] });
        const parsedAnalysis = extractJson(response);

        if(!parsedAnalysis) return this.broadcast({ error: "Failed to analyze data." });

        this.sql`INSERT INTO chat_history (role, content) VALUES ('assistant', ${'[TOOL: DATAANALYSIS Result] Insights: ' + JSON.stringify(parsedAnalysis.insights)});`;
        this.broadcast({ type: "data_insights", data: parsedAnalysis });
    }

    private async handleSystemActions(ws: WebSocket, payload: any) {
        if (payload.action === "load_schema") {
            let schemaData = payload.schema;
            if (payload.url) {
                const res = await fetch(payload.url);
                schemaData = await res.text();
            }
            const metadata = this.saveSchema(schemaData);
            return this.broadcast({ type: "schema_loaded", message: `Loaded schema: ${metadata.title}`, metadata });
        }
        if (payload.action === "get_schema") {
            const schemaRes = this.sql`SELECT content, metadata FROM schema_store WHERE id = 1 LIMIT 1;`;
            return ws.send(JSON.stringify({
                type: "schema_info", hasSchema: schemaRes.length > 0,
                metadata: schemaRes.length > 0 ? JSON.parse(schemaRes[0].metadata) : null,
                schema: schemaRes.length > 0 ? JSON.parse(schemaRes[0].content) : null
            }));
        }
    }

    private async handleExecution(ws: WebSocket, payload: any) {
        this.broadcast({ type: "status", message: "Executing API call..." });
        const { baseUrl, operationKey, params, body, userQuery } = payload;
        const [method, pathTemplate] = operationKey.split('::');

        let finalPath = pathTemplate;
        if (params?.path) {
            for (const [key, val] of Object.entries(params.path)) { finalPath = finalPath.replace(`{${key}}`, encodeURIComponent(String(val))); }
        }
        const targetUrl = new URL(finalPath, baseUrl);
        if (params?.query) {
            for (const [key, val] of Object.entries(params.query)) { targetUrl.searchParams.append(key, String(val)); }
        }

        const fetchOptions: RequestInit = { method: method.toUpperCase(), headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...(params?.header || {}) } };
        if (['POST', 'PUT', 'PATCH'].includes(fetchOptions.method!) && body?.json) { fetchOptions.body = JSON.stringify(body.json); }

        const execResponse = await fetch(targetUrl.toString(), fetchOptions);
        const responseData = await execResponse.json().catch(() => ({ status: execResponse.statusText }));

        this.broadcast({ type: "api_execution_result", statusCode: execResponse.status, data: responseData });
        
        this.sql`INSERT INTO chat_history (role, content) VALUES ('assistant', ${'[TOOL: API EXECUTION] Status: ' + execResponse.status});`;
        await this.runDataAnalysisTool(responseData, userQuery || `Executed ${operationKey}`);
    }
}

export default handler(ApiRouter);
