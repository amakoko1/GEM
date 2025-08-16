// main.ts - Recommended version for Deno Deploy

// --- Configuration ---
// Using Deno.env.get for flexible configuration. Best practice for deployment.
const UPSTREAM_URL_BASE = Deno.env.get("UPSTREAM_URL_BASE") || "https://generativelanguage.googleapis.com";
const MAX_CONSECUTIVE_FAILURES = parseInt(Deno.env.get("MAX_RETRIES") || "5", 10);
const DEBUG_MODE = Deno.env.get("DEBUG_MODE") === "true";

// --- Logging Utility ---
function logDebug(...args: any[]) {
  if (DEBUG_MODE) {
    console.log('DEBUG - ', ...args);
  }
}

// --- CORS Preflight Handler ---
const handleOPTIONS = () =>
  new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    },
  });

// --- Simple Request Relayer ---
async function relayNonStream(request: Request): Promise<Response> {
  const originalUrl = new URL(request.url);
  const upstreamUrl = `${UPSTREAM_URL_BASE}${originalUrl.pathname}${originalUrl.search}`;
  
  logDebug(`Relaying ${request.method} request to: ${upstreamUrl}`);
  
  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });
  
  logDebug(`Upstream ${request.method} response status: ${upstreamResponse.status}`);
  
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers
  });
}

// --- SSE Stream Parser ---
async function* sseLineIterator(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || ""; 
    for (const line of lines) {
      if (line.trim()) {
        yield line;
      }
    }
    if (done) {
      if (buffer.trim()) {
        yield buffer;
      }
      break;
    }
  }
}

// --- SSE Data Extractors ---
function extractTextFromSSELine(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  try {
    const jsonStr = line.slice(6);
    const data = JSON.parse(jsonStr);
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    logDebug(`Failed to extract text from SSE line: ${line}, error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function checkFinishReason(line: string): string | null {
  if (!line.includes('finishReason')) return null;
  const firstBraceIndex = line.indexOf('{');
  if (firstBraceIndex === -1) return null;
  try {
    const jsonStr = line.slice(firstBraceIndex);
    const data = JSON.parse(jsonStr);
    const finishReason = data?.candidates?.[0]?.finishReason || null;
    logDebug(`Extracted finishReason: ${finishReason}`);
    return finishReason;
  } catch (e) {
    logDebug(`Failed to parse finishReason from line: ${line}, error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// --- Retry Logic: Request Body Builder ---
function buildRetryRequestBody(originalRequestBody: any, aggText: string, isReasoningModel: boolean): any {
  if (isReasoningModel) {
    originalRequestBody.generationConfig.thinkingConfig = { 
      ...originalRequestBody.generationConfig.thinkingConfig, 
      thinkingBudget: 128,
      includeThoughts: false 
    };  
  }

  const retryRequestBody = JSON.parse(JSON.stringify(originalRequestBody)); 
  
  logDebug(`Building retry request body with accumulated text length: ${aggText.length}`);
  
  if (!retryRequestBody.contents) {
    retryRequestBody.contents = [];
  }

  if (retryRequestBody.contents.length > 0 && 
      retryRequestBody.contents[retryRequestBody.contents.length - 1].role !== "user") {
    retryRequestBody.contents.push({ role: "model", parts: [{ text: "" }]});
    retryRequestBody.contents.push({ role: "user", parts: [{ text: "continue" }]}); 
    logDebug(`Added empty model response and continue prompt`);
  }
  
  retryRequestBody.contents.push({
    role: "model",
    parts: [{ text: aggText }]
  });
  
  logDebug(`Added accumulated text as model response. Total conversation length: ${retryRequestBody.contents.length}`);
  
  return retryRequestBody;
}

// --- Core Relay and Retry Handler ---
async function relayAndRetry(originalRequest: Request, writer: WritableStreamDefaultWriter<Uint8Array>) {
  const encoder = new TextEncoder();
  let retryCount = 0;
  let AGG_TEXT = "";
  let originalRequestBody: any;
  
  const geminiVersionMatch = new URL(originalRequest.url).pathname.match(/gemini-(\d+(?:\.\d+)?)/);
  const isReasoningModel = geminiVersionMatch && parseFloat(geminiVersionMatch[1]) >= 2.5;
  
  if (isReasoningModel) {
    logDebug(`Detected Gemini version >= 2.5, will force includeThoughts to true`);
  }

  try {
    originalRequestBody = await originalRequest.clone().json();
    logDebug(`Original request body parsed successfully`);

    if (isReasoningModel) {
      originalRequestBody.generationConfig.thinkingConfig = { 
        ...originalRequestBody.generationConfig.thinkingConfig, 
        includeThoughts: true 
      };
      logDebug(`Overrode thinkingConfig.includeThoughts to true`);
    }
  } catch (e) {
    logDebug(`Failed to parse original request body: ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(`Invalid JSON in request body: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  let currentRequestBody = JSON.parse(JSON.stringify(originalRequestBody));

  while (retryCount <= MAX_CONSECUTIVE_FAILURES) {
    let needsRetry = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    
    logDebug(`Starting attempt ${retryCount + 1}/${MAX_CONSECUTIVE_FAILURES + 1}`);
    
    try {
      const originalUrl = new URL(originalRequest.url);
      const upstreamUrl = `${UPSTREAM_URL_BASE}${originalUrl.pathname}${originalUrl.search}`;
      
      logDebug(`Making request to upstream: ${upstreamUrl}`);

      const reqBody = JSON.stringify(currentRequestBody);
      
      const upstreamResponse = await fetch(upstreamUrl, {
        method: originalRequest.method,
        headers: originalRequest.headers,
        body: reqBody
      });

      logDebug(`Request Body: ${reqBody.substring(0, 500)}...`);
      logDebug(`Upstream response status: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
      
      if (!upstreamResponse.ok) {
        throw new Error(`Upstream error: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
      }
      
      reader = upstreamResponse.body?.getReader() ?? null;
      if (!reader) {
        throw new Error("Failed to get readable stream reader from response body.");
      }
      
      let textReceivedInThisAttempt = false;
      let isBlocked = false;
      
      for await (const line of sseLineIterator(reader)) {
        logDebug(`Processing SSE line: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
        
        const finishReason = checkFinishReason(line);
        isBlocked = line.includes('blockReason');

        if (finishReason !== null) {
          logDebug(`Received finishReason: ${finishReason}`);
          if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
            logDebug(`[Attempt ${retryCount + 1}] Abnormal finish reason: ${finishReason}, preparing retry...`);
            needsRetry = true;
            break;
          } else {
            await writer.write(encoder.encode(line + '\n\n'));
            await writer.close();
            logDebug(`[Attempt ${retryCount + 1}] Request finished successfully. Reason: ${finishReason || "STOP"}`);
            return;
          }
        } else {
          const text = extractTextFromSSELine(line);
          if (text) {
            AGG_TEXT += text;
            textReceivedInThisAttempt = true;
            logDebug(`Extracted text chunk of length: ${text.length}, total accumulated: ${AGG_TEXT.length}`);
          }
          
          if (!isBlocked) {
            await writer.write(encoder.encode(line + '\n\n'));
            logDebug(`Forwarded SSE line to client`);
          } else {
            logDebug(`Blocked line detected, not forwarding: ${line}`);
          }
        }
      }
      
      if (textReceivedInThisAttempt) {
        retryCount = 0;
        logDebug(`Reset retry count due to successful text reception.`);
      }
      
      if (!needsRetry && isBlocked) {
        logDebug(`[Attempt ${retryCount + 1}] Stream blocked without STOP reason, preparing to retry...`);
        needsRetry = true;
      }
      
    } catch (error) {
      logDebug(`[Attempt ${retryCount + 1}] Fetch/processing error: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[Attempt ${retryCount + 1}] Fetch/processing error:`, error);
      needsRetry = true;
    } finally {
      if (reader) {
        try {
          await reader.cancel();
          logDebug(`Reader cancelled successfully`);
        } catch (e) {
          logDebug(`Failed to cancel reader: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    if (needsRetry) {
      retryCount++;
      if (retryCount > MAX_CONSECUTIVE_FAILURES) {
        logDebug(`Max retries (${MAX_CONSECUTIVE_FAILURES}) exceeded. Closing stream.`);
        console.error("Max retries exceeded. Closing stream.");
        const errorPayload = { error: { message: "Max retries exceeded after multiple upstream failures." } };
        await writer.write(encoder.encode('data: ' + JSON.stringify(errorPayload) + '\n\n'));
        await writer.close();
        return;
      }
      
      currentRequestBody = buildRetryRequestBody(originalRequestBody, AGG_TEXT, isReasoningModel);
      logDebug(`[Attempt ${retryCount}] Prepared retry with accumulated text length: ${AGG_TEXT.length}`);
    } else {
      logDebug(`Request completed successfully without needing a retry.`);
      await writer.close();
      break;
    }
  }
}

// --- Main Request Handler ---
async function handleRequest(request: Request): Promise<Response> {
  logDebug(`Received ${request.method} request to ${request.url}`);
  
  if (request.method === "OPTIONS") {
    logDebug(`Handling OPTIONS request`);
    return handleOPTIONS();
  }
  
  const { pathname, searchParams } = new URL(request.url);
  const isStream = /stream/i.test(pathname) || searchParams.get('alt')?.toLowerCase() === 'sse'; 

  if (request.method !== "POST" || !isStream) {
    logDebug(`Relaying non-stream request: ${request.method} ${pathname}`);
    try {
      return await relayNonStream(request);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logDebug(`Failed to relay non-stream request: ${errorMessage}`);
      console.error('Non-POST relay error:', error);
      return new Response(JSON.stringify({ error: "Failed to relay request", details: errorMessage }), 
        { status: 502, headers: { "Content-Type": "application/json" } });
    }
  }

  try {
    logDebug(`Processing POST request for streaming response`);
    
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    relayAndRetry(request, writer).catch(error => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logDebug(`relayAndRetry failed: ${errorMessage}`);
      console.error('Relay and retry error:', error);
      const encoder = new TextEncoder();
      const errorPayload = { error: { message: "Request processing failed", details: errorMessage } };
      writer.write(encoder.encode('data: ' + JSON.stringify(errorPayload) + '\n\n')).catch(() => {});
      writer.close().catch(() => {});
    });

    logDebug(`Returning streaming response`);
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDebug(`Request handling error: ${errorMessage}`);
    console.error('Request handling error:', error);
    return new Response(JSON.stringify({ error: "Request processing failed", details: errorMessage }), 
      { status: 400, headers: { "Content-Type": "application/json" } });
  }
}

// --- Deno Server Entry Point ---
logDebug("Starting Gemini Elastic Middleware server...");
Deno.serve(handleRequest);
