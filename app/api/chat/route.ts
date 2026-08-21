import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

// Server-only: this file runs on Vercel's servers, never in the browser,
// so the API key is never exposed to the client.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are JARVIS, a sharp, dry-witted AI assistant inspired by Tony Stark's
assistant. You are speaking out loud through text-to-speech, so:
- Keep replies short and conversational (1-3 sentences unless asked for detail).
- Never use markdown, bullet points, code blocks, or emoji — plain spoken sentences only.
- Be helpful and direct, with a touch of understated wit.
- You have a web search tool. Use it whenever the answer depends on current events, prices,
  scores, weather, or anything else that could have changed since your training — don't guess
  or rely on stale memory for time-sensitive facts. Summarize what you find in your own words;
  don't read out URLs.`;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY." },
      { status: 500 },
    );
  }

  let body: { message?: string; history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "Missing 'message'." }, { status: 400 });
  }

  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      // Anthropic's server-side web search tool: Claude decides when to use it
      // (e.g. "what's the news today", "what's the weather"), runs the search
      // itself, and reasons over the results before replying.
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [...history, { role: "user", content: message }],
    });

    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
      .trim();

    return NextResponse.json({ reply: reply || "I didn't quite catch that." });
  } catch (err) {
    console.error("Anthropic API error:", err);
    const detail = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `AI request failed: ${detail}` },
      { status: 502 },
    );
  }
}
