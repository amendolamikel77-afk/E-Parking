import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  const { image, mimeType, voterId } = await req.json();
  if (!image || !voterId) {
    return NextResponse.json({ error: "Missing image or voterId" }, { status: 400 });
  }

  let valid = true;
  let reason = "";
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType || "image/jpeg",
                data: image,
              },
            },
            {
              type: "text",
              text:
                'Does this photo plausibly show a real parking spot or parking space ' +
                "(street parking, parking lot, garage, driveway, or similar)? " +
                'Reply with strict JSON only, no other text: {"valid": true or false, "reason": "short reason"}',
            },
          ],
        },
      ],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text : "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    valid = Boolean(parsed.valid);
    reason = typeof parsed.reason === "string" ? parsed.reason : "";
  } catch {
    // If the AI check itself fails (no key, network, bad response), don't
    // penalize the user for an infrastructure problem — let the claim through.
    return NextResponse.json({ valid: true, reason: "AI check unavailable" });
  }

  if (!valid) {
    const admin = getSupabaseAdmin();
    const { data: profile } = await admin
      .from("profiles")
      .select("reliability_score")
      .eq("id", voterId)
      .single();
    if (profile) {
      await admin
        .from("profiles")
        .update({ reliability_score: profile.reliability_score - 1 })
        .eq("id", voterId);
    }
  }

  return NextResponse.json({ valid, reason });
}
