/**
 * llm_utils.js
 *
 * Utilities for interacting with an LLM.
 * For now, this contains a mock function to simulate LLM responses.
 */

import OpenAI from 'openai';
import { config } from 'dotenv';

config();
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Define the structure we expect the LLM to return
const expectedJsonResponseFormat = {
  intent: "GUILD_APPLICATION_INTEREST | COMMUNITY_INTEREST_VOUCH | GENERAL_QUESTION | SOCIAL_GREETING | UNCLEAR_INTENT | OTHER",
  entities: {
    mentioned_class: "string | null (e.g., Warrior, Mage)",
    mentioned_experience_level: "string | null (e.g., New, Veteran, Some Experience)",
    desired_role: "string | null (e.g., Tank, Healer, DPS, Member)",
    vouch_person_name: "string | null (Discord username or mention if provided for vouch)",
    original_vouch_text: "string | null (The exact text user used for vouching)",
    question_topic: "string | null (e.g., raid_times, guild_rules, application_process)",
  },
  suggested_bot_response: "string (A friendly and contextually appropriate response for the bot to say)",
  confidence_score: "number (0.0 to 1.0, how confident LLM is about the intent)",
  requires_clarification: "boolean (True if the bot should ask for more information)",
  next_action_suggestion: "string | null (Internal hint for bot logic, e.g., NOTIFY_VOUCHER, ASK_CLASS_PREFERENCE)"
};

/**
 * Builds the prompt for the LLM, including system message, conversation history, and current user message.
 */
function buildFullPrompt(userMessage, userId, guildInfo, conversationHistory = []) {
  const systemPrompt = `You are an advanced AI assistant for "Wraiven", a Discord recruitment bot for the MMORPG Albion Online Guild "Wraiven".
Your primary goal is to understand new user intentions when they first join the server and send a message in their private processing channel.
You must classify their intent and extract relevant information.

Guild Name: Wraiven
Recruitment Focus: Raiding, M+, Social. We are looking for dedicated players for endgame content and active community members.
Current User ID: ${userId}

Possible Intents:
- GUILD_APPLICATION_INTEREST: User expresses clear interest in applying to the guild for raiding/M+/etc.
- COMMUNITY_INTEREST_VOUCH: User expresses interest in joining the community (not necessarily as a raider) AND mentions someone who can vouch for them. Extract the voucher's name.
- GENERAL_QUESTION: User is asking a general question about the guild (e.g., raid times, rules, what game you play).
- SOCIAL_GREETING: User is just saying hello or making a simple social gesture.
- UNCLEAR_INTENT: User's message is too vague or unclear to determine a specific intent.
- OTHER: None of the above.

Conversation History (if any):
${conversationHistory
  .map(
    (msg) => `${msg.author === "user" ? "User" : "WraivenBot"}: ${msg.content}`
  )
  .join("\n")}

Latest User Message: "${userMessage}"

Your task is to analyze the "Latest User Message" in the context of the "Conversation History" and respond ONLY with a valid JSON object matching this exact format:
${JSON.stringify(expectedJsonResponseFormat, null, 2)}

Ensure all string fields in the JSON are populated appropriately or set to null if no information is extracted.
The "suggested_bot_response" should be helpful and guide the user based on their intent.
If the user mentions someone who can vouch for them (intent: COMMUNITY_INTEREST_VOUCH), ensure "vouch_person_name" and "original_vouch_text" are extracted.
The "suggested_bot_response" for a vouch should acknowledge the vouch and state that the named person will be contacted.
Do NOT add any text before or after the JSON object.`;

  return systemPrompt;
}

/**
 * Processes a user message with the OpenAI LLM.
 *
 * @param {string} userMessage - The content of the user's message.
 * @param {string} userId - The ID of the user.
 * @param {Array<object>} conversationHistory - An array of previous messages.
 * @returns {Promise<object|null>} A promise that resolves to the LLM's structured JSON response, or null if an error occurs.
 */
export async function processUserMessageWithLLM(
  userMessage,
  userId,
  conversationHistory = []
) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[LLM ERROR] OpenAI API key is not configured.");
    return { // Return a fallback error structure
        intent: "LLM_ERROR",
        entities: {},
        suggested_bot_response: "I'm currently unable to process requests with my advanced AI. Please contact a staff member directly.",
        confidence_score: 0,
        requires_clarification: true,
        next_action_suggestion: "ALERT_STAFF_LLM_DOWN"
    };
  }

  const guildInfo = { /* You can expand this with dynamic guild info if needed */ };
  const fullPrompt = buildFullPrompt(userMessage, userId, guildInfo, conversationHistory);

  console.log(`[LLM Request] Processing message for user ${userId}: "${userMessage}"`);
  // console.log("[LLM Request] Full prompt being sent (first 200 chars):", fullPrompt.substring(0,200)); // For debugging, be careful with logging full prompts

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-0125", // Or "gpt-4o" or other suitable model
      messages: [
        { role: "system", content: "You are a helpful assistant that only responds in JSON." }, // Basic system message for chat model
        { role: "user", content: fullPrompt } // Our detailed prompt instructing JSON output and task
      ],
      temperature: 0.5, // Lower for more deterministic, higher for more creative
      max_tokens: 500,  // Adjust as needed for expected JSON size
      // response_format: { type: "json_object" }, // Uncomment if using a model/API version that explicitly supports JSON mode
    });

    const llmOutputText = completion.choices[0]?.message?.content;

    if (!llmOutputText) {
      console.error("[LLM ERROR] No content in LLM response.");
      return { // Return a fallback error structure
        intent: "LLM_NO_RESPONSE_CONTENT",
        entities: {},
        suggested_bot_response: "My AI core provided an empty response. A guild officer will be with you shortly.",
        confidence_score: 0,
        requires_clarification: true,
        next_action_suggestion: "ALERT_STAFF_LLM_EMPTY_RESPONSE"
      };
    }

    console.log("[LLM Raw Response]:", llmOutputText);

    // Attempt to parse the LLM output as JSON
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(llmOutputText);
    } catch (jsonError) {
      console.error("[LLM ERROR] Failed to parse LLM response as JSON:", jsonError);
      console.error("[LLM ERROR] Non-JSON response received:", llmOutputText);
      // Fallback: Try to extract JSON from a string that might have markdown backticks
      const jsonMatch = llmOutputText.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch && jsonMatch[1]) {
        try {
          parsedResponse = JSON.parse(jsonMatch[1]);
          console.log("[LLM Info] Successfully extracted JSON from markdown.");
        } catch (e) {
            console.error("[LLM ERROR] Still failed to parse extracted JSON:", e);
            return { // Return a fallback error structure
                intent: "LLM_RESPONSE_FORMAT_ERROR",
                entities: {},
                suggested_bot_response: "I received a response, but it wasn't in the format I expected after an initial parsing attempt. A guild officer will assist you shortly.",
                confidence_score: 0,
                requires_clarification: true,
                next_action_suggestion: "ALERT_STAFF_LLM_FORMAT_ISSUE_POST_EXTRACTION"
            };
        }
      } else {
        return { // Return a fallback error structure if no JSON is found
            intent: "LLM_RESPONSE_FORMAT_ERROR",
            entities: {},
            suggested_bot_response: "I'm having trouble understanding the response from my AI core. Please wait for a guild officer.",
            confidence_score: 0,
            requires_clarification: true,
            next_action_suggestion: "ALERT_STAFF_LLM_FORMAT_ISSUE_NO_JSON"
        };
      }
    }

    // TODO: Validate parsedResponse against the expectedJsonResponseFormat structure
    // For now, we assume it's correct if parsing succeeded.

    console.log("[LLM Parsed Response]:", JSON.stringify(parsedResponse, null, 2));
    return parsedResponse;

  } catch (error) {
    console.error("[LLM ERROR] Error calling OpenAI API:", error);
    let errorIntent = "LLM_API_ERROR_UNKNOWN";
    let errorMessage = "There was an unknown issue communicating with my advanced AI services. A staff member will be with you soon.";

    if (error instanceof OpenAI.APIError) {
        errorIntent = `LLM_API_ERROR_\${error.status || 'GENERIC'}`;
        errorMessage = `AI Service Error (Status: ${error.status || 'N/A'}): ${error.name} - ${error.message}. A staff member will assist.`;
        if (error.status === 401) errorMessage = "AI Service Error: Authentication failed. Please check API key. Staff notified.";
        if (error.status === 429) errorMessage = "AI Service Error: Rate limit exceeded. Please try again later. Staff notified.";
        if (error.status === 500) errorMessage = "AI Service Error: Internal server error on AI provider side. Please try again later. Staff notified.";
    }
    
    return { // Return a fallback error structure
        intent: errorIntent,
        entities: {},
        suggested_bot_response: errorMessage,
        confidence_score: 0,
        requires_clarification: true,
        next_action_suggestion: "ALERT_STAFF_LLM_API_DOWN"
    };
  }
}

// Example of how you might structure a more complex prompt for a real LLM
/*
function buildPromptForLLM(userMessage, userId, guildInfo, conversationHistory) {
  const systemPrompt = `You are a helpful and friendly recruitment assistant for the MMORPG guild "House Valier".
Your goal is to understand new user's intentions, answer their questions, and guide them through the application process if they are interested.
Guild Information:
- Guild Name: House Valier
- Focus: Semi-hardcore Raiding & Community
- Primary Game: [Specify Game Name]
- Recruitment Status: Currently recruiting [Tank, Healer, DPS - specify needs]

Current Conversation:
${conversationHistory.map(msg => `${msg.author === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n')}
User: ${userMessage}
Assistant (respond in JSON format with fields: "intent", "entities", "suggested_bot_response", "confidence_score", "requires_clarification", "next_action_suggestion"):`;

  return systemPrompt;
}
*/ 