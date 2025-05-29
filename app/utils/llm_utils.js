/**
 * llm_utils.js
 *
 * Utilities for interacting with an LLM.
 * For now, this contains a mock function to simulate LLM responses.
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load configuration for Guild Name
const configPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const GUILD_NAME = config.LLM.PROMPT_GUILD_NAME || "Wraiven"; // Fallback just in case

// Load environment variables from .env file at the root of the 'recruiter' app parent directory
const envPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../.env');
dotenv.config({ path: envPath });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
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
  const systemPrompt = `You are an advanced AI assistant for "${GUILD_NAME}", a Discord recruitment bot for the MMORPG Albion Online Guild "${GUILD_NAME}".
Your primary goal is to understand new user intentions when they first join the server and send a message in their private processing channel.
You must classify their intent and extract relevant information according to the rules below.

Guild Name: ${GUILD_NAME}
Recruitment Focus: Raiding, M+, Social. We are looking for dedicated players for endgame content and active community members.
Current User ID: ${userId}

RULES FOR 'COMMUNITY_INTEREST_VOUCH' INTENT:
1. If the user explicitly @mentions a Discord user OR provides a clear, specific username as a voucher (e.g., "My friend JohnDoe can vouch"), set 'intent' to 'COMMUNITY_INTEREST_VOUCH', extract the @mention or username into 'vouch_person_name', set 'requires_clarification' to false, and populate 'suggested_bot_response' to acknowledge this specific person.
2. If the user mentions a generic group like "my friends", "a buddy", "someone I know" WITHOUT a specific username or @mention, you MUST set 'intent' to 'COMMUNITY_INTEREST_VOUCH', set 'vouch_person_name' to null, set 'requires_clarification' to true. In this case, 'suggested_bot_response' MUST be a question asking the user to provide the specific @mention or username of their friend in the guild.

RULES FOR VAGUE INITIAL RESPONSES (like "Content", "Info", "Playing"):
1. If the "Latest User Message" is a very short, vague, or non-specific answer to the bot's initial question "What is your purpose for joining...", and it doesn't clearly fit GUILD_APPLICATION_INTEREST or have a specific vouch, then you MUST set 'intent' to 'UNCLEAR_INTENT'.
2. For this 'UNCLEAR_INTENT' due to vagueness, 'requires_clarification' MUST be true.
3. The 'suggested_bot_response' for this type of UNCLEAR_INTENT should ask clarifying questions to guide the user. For example: "Okay! To help me understand better, what specifically are you looking for? For example, are you interested in specific game content, looking to apply to the guild, or perhaps join our community and play with existing members?"

Possible Intents (follow above rules):
- GUILD_APPLICATION_INTEREST: User expresses clear interest in applying to the guild for raiding/M+/etc.
- COMMUNITY_INTEREST_VOUCH: (See RULES FOR 'COMMUNITY_INTEREST_VOUCH' INTENT above).
- GENERAL_QUESTION: User is asking a general question about the guild (e.g., raid times, rules, what game you play), not a vague initial purpose statement.
- SOCIAL_GREETING: User is just saying hello or making a simple social gesture.
- UNCLEAR_INTENT: User's message is too vague or unclear to determine a specific intent (especially after the initial purpose question, see VAGUE INITIAL RESPONSES rules), or doesn't fit other categories after applying vouch rules.
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
The "suggested_bot_response" should be helpful and guide the user based on their intent and the rules provided.
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
  conversationHistory = [],
  channelId = null
) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[LLM] OpenAI API key is not set. Skipping LLM call.");
    // Return a default mock response or error structure
    return {
      intent: "ERROR_NO_API_KEY",
      entities: {},
      suggested_bot_response: "I am currently unable to process requests with AI. Please contact a staff member.",
      requires_clarification: false,
      error: "OpenAI API key missing",
    };
  }

  const guildInfo = { /* You can expand this with dynamic guild info if needed */ };
  const systemPrompt = await buildFullPrompt(userMessage, userId, guildInfo, conversationHistory);

  const messagesForApi = [
    { role: "system", content: systemPrompt },
    // Add existing conversation history, ensuring correct roles (user/assistant)
    ...conversationHistory.map(msg => ({
        // Adjust if your history object has a different structure for role, e.g., msg.author === 'bot' ? 'assistant' : 'user'
        role: msg.role || (msg.author === 'bot' ? 'assistant' : 'user'), 
        content: msg.content
    })),
    { role: "user", content: userMessage },
  ];

  console.log("[LLM] Sending request to OpenAI with messages:", JSON.stringify(messagesForApi, null, 2));

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-0125", // Or your preferred model like gpt-4o
      messages: messagesForApi,
      response_format: { type: "json_object" }, // Enforce JSON output if using a compatible model
      temperature: 0.5, // Lower temperature for more deterministic, less creative responses for classification/extraction
    });

    const llmResponseContent = completion.choices[0]?.message?.content;
    console.log("[LLM] Raw response from OpenAI:", llmResponseContent);

    if (!llmResponseContent) {
      console.error("[LLM] Received empty content from OpenAI.");
      return {
        intent: "ERROR_OPENAI_EMPTY_RESPONSE",
        entities: {},
        suggested_bot_response: "I received an unusual response from the AI. Please try rephrasing, or a staff member can assist.",
        requires_clarification: false,
        error: "OpenAI returned empty content",
      };
    }

    try {
      const parsedResponse = JSON.parse(llmResponseContent);
      console.log("[LLM] Parsed LLM JSON response:", JSON.stringify(parsedResponse, null, 2));
      // Basic validation for expected fields (can be expanded)
      if (typeof parsedResponse.intent !== 'string' || typeof parsedResponse.suggested_bot_response !== 'string') {
          console.error("[LLM] Parsed JSON is missing required fields (intent, suggested_bot_response).");
          throw new Error("LLM response missing required fields."); // Caught by outer catch
      }
      return parsedResponse;
    } catch (jsonParseError) {
      console.error("[LLM] Failed to parse JSON response from OpenAI:", jsonParseError);
      console.error("[LLM] Non-JSON content was: ", llmResponseContent); // Log the problematic content
      // Attempt to extract intent if it looks like a simple string response (fallback)
      let fallbackIntent = "UNCLEAR_INTENT";
      if (llmResponseContent.toLowerCase().includes("apply") || llmResponseContent.toLowerCase().includes("join guild")) {
          fallbackIntent = "GUILD_APPLICATION_INTEREST";
      }
      // Add more fallback intent checks if needed

      return {
        intent: fallbackIntent,
        entities: { original_response_if_not_json: llmResponseContent },
        suggested_bot_response: `I had a little trouble understanding the AI's last message. It said: "${llmResponseContent.substring(0,1000)}". Could you try rephrasing your request? Or a staff member can help.`,
        requires_clarification: true,
        error: "Failed to parse LLM JSON response",
      };
    }
  } catch (error) {
    console.error("[LLM] Error calling OpenAI API:", error);
    let errorMessage = "An unexpected error occurred while contacting the AI.";
    if (error.response) { // Axios-style error checking, or check specific OpenAI error properties
        console.error("[LLM] OpenAI API Error Status:", error.response.status);
        console.error("[LLM] OpenAI API Error Data:", error.response.data);
        errorMessage = `AI Service Error: ${error.response.data?.error?.message || error.message}`;
    } else if (error.message) {
        errorMessage = `AI Service Error: ${error.message}`;
    }

    // Check for specific error types, like authentication
    if (error.message && error.message.includes("authentication")) {
        errorMessage = "AI authentication failed. Please check the API key configuration.";
        // Consider more drastic action like disabling LLM features temporarily
    }

    return {
      intent: "ERROR_OPENAI_API_CALL",
      entities: {},
      suggested_bot_response: errorMessage,
      requires_clarification: false,
      error: error.message || "OpenAI API call failed",
    };
  }
}

// Example of how you might structure a more complex prompt for a real LLM
/*
function buildPromptForLLM(userMessage, userId, guildInfo, conversationHistory) {
  const systemPrompt = `You are a helpful and friendly recruitment assistant for the MMORPG guild "Wraiven".
Your goal is to understand new user's intentions, answer their questions, and guide them through the application process if they are interested.
Guild Information:
- Guild Name: Wraiven
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