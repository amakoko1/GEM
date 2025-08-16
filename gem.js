// Configuration: Load configuration variables from ENV first, use default values for those not defined in ENV
let CONFIG = {
  upstream_url_base: "https://generativelanguage.googleapis.com",
  max_consecutive_failures: 5,
  debug_mode: true
};

function initConfig(env = {}) {
  CONFIG.upstream_url_base = env.UPSTREAM_URL_BASE || "https://generativelanguage.googleapis.com";
  CONFIG.max_consecutive_failures = parseInt(env.MAX_CONSECUTIVE_FAILURES) || 5;
  CONFIG.debug_mode = env.DEBUG_MODE ? env.DEBUG_MODE.toLowerCase() === 'true' : true;
}

// Handle CORS preflight requests
const handleOPTIONS = async () =>
  new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    },
  });

function logDebug(...args) {
  if (CONFIG.debug_mode) {
    console.log('DEBUG - ', ...args);
  }
}

function textToUnicodeEscapes(text) {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const hex = text.charCodeAt(i).toString(16).padStart(4, '0');
    result += `\\u${hex}`;
  }
  return result;
}

// Relay non-POST requests as-is to upstream
async function relayNonStream(request) {
  const originalUrl = new URL(request.url);
  const upstreamUrl = `${CONFIG.upstream_url_base}${originalUrl.pathname}${originalUrl.search}`;
  
  logDebug(`Relaying ${request.method} request to: ${upstreamUrl}`);
  
  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });
  
  logDebug(`Upstream ${request.method} response status: ${upstreamResponse.status}`);
  
  // Return response with same headers and body
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers
  });
}

// Parse Server-Sent Events (SSE) stream line by line
async function* sseLineIterator(reader) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }
    // Split buffer by newlines (support both \n and \r\n)
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop(); 
    // Yield each complete line
    for (const line of lines) {
      if (line.trim()) {
        yield line;
      }
    }
    // If stream is done, yield any remaining content
    if (done) {
      if (buffer.trim()) {
        yield buffer;
      }
      break;
    }
  }
}

// Extract text content from SSE data line
function extractTextFromSSELine(line) {
  if (!line.startsWith('data: ')) return null;
  try {
    const jsonStr = line.slice(6); // Remove 'data: ' prefix
    const data = JSON.parse(jsonStr);
    // Navigate through the nested structure to get text
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || null;
  } catch (e) {
    logDebug(`Failed to extract text from SSE line: ${line}, error: ${e.message}`);
    return null;
  }
}

// Check if the line contains a finishReason and extract it
function checkFinishReason(line) {
  if (!line.includes('finishReason')) return null;
  // Find the start of JSON object
  const firstBraceIndex = line.indexOf('{');
  if (firstBraceIndex === -1) return null;
  try {
    const jsonStr = line.slice(firstBraceIndex);
    const data = JSON.parse(jsonStr);
    const finishReason = data?.candidates?.[0]?.finishReason || null;
    logDebug(`Extracted finishReason: ${finishReason}`);
    return finishReason;
  } catch (e) {
    logDebug(`Failed to parse finishReason from line: ${line}, error: ${e.message}`);
    return null;
  }
}

// Build a new request body for retry with accumulated text
function buildRetryRequestBody(originalRequestBody, aggText, isReasoningModel) {
  // Minimize reasoning token budget for fast retry
  // https://ai.google.dev/gemini-api/docs/thinking
  if (isReasoningModel) {
    originalRequestBody.generationConfig.thinkingConfig =  { 
      ...originalRequestBody.generationConfig.thinkingConfig, 
      thinkingBudget: 128,
      includeThoughts: false 
    };  
  }

  // Deep copy the original request body
  const retryRequestBody = JSON.parse(JSON.stringify(originalRequestBody)); 
  
  logDebug(`Building retry request body with accumulated text length: ${aggText.length}`);
  
  // Ensure contents array exists
  if (!retryRequestBody.contents) {
    retryRequestBody.contents = [];
  }

  // If last message is not from user, add model response and user continue prompt
  if (retryRequestBody.contents.length > 0 && 
      retryRequestBody.contents[retryRequestBody.contents.length - 1].role !== "user") {
    retryRequestBody.contents.push({ role: "model", parts: [{ text: "" }]});
    retryRequestBody.contents.push({ role: "user", parts: [{ text: "continue" }]}); 
    logDebug(`Added empty model response and continue prompt`);
  }
  

  const preservedLength = 10;
  const plainAggPart = aggText.slice(Math.max(0, aggText.length - preservedLength));
  const escapedAggPart = aggText.slice(0, Math.max(0, aggText.length - preservedLength));  

  // Add accumulated text as model's previous response
  retryRequestBody.contents.push({
    role: "model",
    parts: [{ text: textToUnicodeEscapes(escapedAggPart) + "\n(unicode ended)\n" + plainAggPart }]
  });

  logDebug(`Added accumulated text as model response. Total conversation length: ${retryRequestBody.contents.length}`);
  
  return retryRequestBody;
}

// Main function to relay requests and handle retries on truncation
async function relayAndRetry(originalRequest, writer) {
  const encoder = new TextEncoder();
  let retryCount = 0;
  let AGG_TEXT = ""; // Accumulated text from all attempts
  let originalRequestBody;
  
  const geminiVersionMatch = new URL(originalRequest.url).pathname.match(/gemini-(\d+(?:\.\d+)?)/);
  const isReasoningModel = geminiVersionMatch && parseFloat(geminiVersionMatch[1]) >= 2.5;
  
  if (isReasoningModel) {
    logDebug(`Detected Gemini version >= 2.5, will force includeThoughts to true`);
  }

  try {
    originalRequestBody = await originalRequest.clone().json();
    logDebug(`Original request body parsed successfully`);

    if (isReasoningModel) {
      originalRequestBody.generationConfig.thinkingConfig =  { 
        ...originalRequestBody.generationConfig.thinkingConfig, 
        includeThoughts: true 
      };
      logDebug(`Overrode thinkingConfig.includeThoughts to true`);
    }
  } catch (e) {
    logDebug(`Failed to parse original request body: ${e.message}`);
    throw new Error(`Invalid JSON in request body: ${e.message}`);
  }
  
  let currentRequestBody = JSON.parse(JSON.stringify(originalRequestBody));

  while (retryCount <= CONFIG.max_consecutive_failures) {
    let needsRetry = false;
    let reader = null;
    
    logDebug(`Starting attempt ${retryCount + 1}/${CONFIG.max_consecutive_failures + 1}`);
    
    try {
      // Construct upstream URL with Google API host
      const originalUrl = new URL(originalRequest.url);
      const upstreamUrl = `${CONFIG.upstream_url_base}${originalUrl.pathname}${originalUrl.search}`;
      
      logDebug(`Making request to upstream: ${upstreamUrl}`);

      const reqBody = JSON.stringify(currentRequestBody);

      // Make request to upstream Google API - preserve all original request details except body
      const upstreamResponse = await fetch(upstreamUrl, {
        method: originalRequest.method,
        headers: originalRequest.headers,
        body: reqBody
      });

      logDebug(`Request Body: ${reqBody}`);
      
      logDebug(`Upstream response status: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
      
      if (!upstreamResponse.ok) {
          throw new Error(`Upstream error: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
      }
      
      reader = upstreamResponse.body.getReader();
      let textReceivedInThisAttempt = false;
      let isBlocked = false;
      let finishReasonArrived = false;
      
      // Process SSE stream line by line
      for await (const line of sseLineIterator(reader)) {
          logDebug(`Processing SSE line: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
          
          const finishReason = checkFinishReason(line);
          if (line.includes('"finishReason"')) {
            finishReasonArrived = true;
          }
          isBlocked = line.includes('blockReason');

          if (isBlocked) {
            logDebug(`[Attempt ${retryCount + 1}] blocked, preparing to retry...`);
            needsRetry = true;
            break; // Exit loop to retry
          }

          if (finishReason !== null) {
              logDebug(`Received finishReason: ${finishReason}`);
              
              // Check if response was truncated (not a normal completion)
              if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
                  logDebug(`[Attempt ${retryCount + 1}] Detected abnormal finish reason: ${finishReason}, preparing to retry...`);
                  needsRetry = true;
                  break; // Exit loop to retry
              } else {
                  // Normal completion - forward line and close stream
                  await writer.write(encoder.encode(line + '\n\n'));
                  await writer.close();
                  logDebug(`[Attempt ${retryCount + 1}] Request finished successfully. Finish reason: ${finishReason || "STOP"}`);
                  return; // Success - exit function
              }
          } else {
              // Regular content line - extract text and forward
              const text = extractTextFromSSELine(line);
              if (text) {
                  AGG_TEXT += text; // Accumulate text
                  textReceivedInThisAttempt = true;
                  logDebug(`Extracted text chunk of length: ${text.length}, total accumulated: ${AGG_TEXT.length}`);
              }
              
              await writer.write(encoder.encode(line + '\n\n'));
              logDebug(`Forwarded SSE line to client`);
          }
      }
      
      // If the stream ends naturally, but no `finishReason` appears throughout the process, it is considered truncated and needs to be retried
      if (!needsRetry && !finishReasonArrived) {
        logDebug(`[Attempt ${retryCount + 1}] Stream finished but no finishReason found – will retry`);
        needsRetry = true;
      }
      
      // Reset retry count if we received text in this attempt
      if (textReceivedInThisAttempt) {
        retryCount = 0;
        logDebug(`Reset retry count due to successful text reception`);
      }
      
      
    } catch (error) {
      logDebug(`[Attempt ${retryCount + 1}] Fetch or processing error: ${error.message}`);
      console.error(`[Attempt ${retryCount + 1}] Fetch or processing error:`, error);
      needsRetry = true;
    } finally {
      // Clean up reader to prevent resource leaks
      if (reader) {
        try {
          await reader.cancel();
          logDebug(`Reader cancelled successfully`);
        } catch (e) {
          logDebug(`Failed to cancel reader: ${e.message}`);
        }
      }
    }

    if (needsRetry) {
        retryCount++;
        if (retryCount > CONFIG.max_consecutive_failures) {
            // Max retries exceeded - send error and close
            logDebug(`Max retries (${CONFIG.max_consecutive_failures}) exceeded. Closing stream.`);
            console.error("Max retries exceeded. Closing stream.");
            const errorPayload = { error: { message: "Max retries exceeded after multiple upstream failures." } };
            await writer.write(encoder.encode('data: ' + JSON.stringify(errorPayload) + '\n\n'));
            await writer.close();
            return;
        }
        
        // Build new request body with accumulated text for retry
        currentRequestBody = buildRetryRequestBody(originalRequestBody, AGG_TEXT, isReasoningModel);
        logDebug(`[Attempt ${retryCount + 1}] Prepared retry with accumulated text length: ${AGG_TEXT.length}`);
    } else {
        // Success - exit loop
        logDebug(`Request completed successfully without retry`);
        break;
    }
  }
}

// Main request handler
async function handleRequest(request, env = {}) {
  // Initialize Configuration
  initConfig(env);
  
  logDebug(`Received ${request.method} request to ${request.url}`);
  
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    logDebug(`Handling OPTIONS request`);
    return handleOPTIONS();
  }
  
  const { pathname, searchParams } = new URL(request.url, 'http://_');
  const isStream = /stream/i.test(pathname) || searchParams.get('alt')?.toLowerCase() === 'sse'; 

  // For non-POST requests, relay as-is
  if (request.method !== "POST" || !isStream) {
    logDebug(`Relaying non-stream request: ${request.method}`);
    try {
      return await relayNonStream(request);
    } catch (error) {
      logDebug(`Failed to relay non-stream request: ${error.message}`);
      console.error('Non-POST relay error:', error);
      return new Response(JSON.stringify({ error: "Failed to relay request", details: error.message }), 
        { status: 502, headers: { "Content-Type": "application/json" } });
    }
  }

  // Handle POST requests with retry logic
  try {
    logDebug(`Processing POST request for streaming response`);
    
    // Create a streaming response
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Start relay and retry process asynchronously
    // Don't await - let it run in background while we return the stream
    relayAndRetry(request, writer).catch(error => {
      logDebug(`relayAndRetry failed: ${error.message}`);
      console.error('Relay and retry error:', error);
      // Try to send error to client if stream is still writable
      const encoder = new TextEncoder();
      const errorPayload = { error: { message: "Request processing failed", details: error.message } };
      writer.write(encoder.encode('data: ' + JSON.stringify(errorPayload) + '\n\n')).catch(() => {});
      writer.close().catch(() => {});
    });

    // Return SSE stream response
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
    logDebug(`Request handling error: ${error.message}`);
    console.error('Request handling error:', error);
    return new Response(JSON.stringify({ error: "Request processing failed", details: error.message }), 
      { status: 400, headers: { "Content-Type": "application/json" } });
  }
}

// Export for Cloudflare Workers
export default { fetch: handleRequest };
// Export for Cloudflare Pages Functions
export const onRequest = (context) => { return handleRequest(context.request, context.env); };

// Deno runtime support for local development
if (typeof Deno !== "undefined") {
  const port = Number(Deno.env.get("PORT")) || 8000;
  console.log(`Deno server listening on http://localhost:${port}`);
  Deno.serve({ port }, (request) => {
    const env = {}; // Simple Deno env mock
    for (const key in Deno.env.toObject()) {
        env[key] = Deno.env.get(key);
    }
    return handleRequest(request, env);
  });
}
