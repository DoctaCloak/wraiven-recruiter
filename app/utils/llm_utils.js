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
const GUILD_INFO = config.GUILD_INFO || {}; // Load GUILD_INFO

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

function createSystemPrompt(GUILD_NAME, guildContext, userId, conversationHistory, userMessage, expectedJsonResponseFormat) {
  const example1 = `
Example 1 (Vague initial response):
Conversation History:
WraivenBot: Hello, [User], welcome to Wraiven!
WraivenBot: What is your purpose for joining the Wraiven Discord channel?
Latest User Message: "content"
Expected JSON:
{
  "intent": "UNCLEAR_INTENT",
  "entities": { "mentioned_class": null, "mentioned_experience_level": null, "desired_role": null, "vouch_person_name": null, "original_vouch_text": null, "question_topic": null },
  "suggested_bot_response": "Okay! To help me understand better, are you interested in applying to become a member of Wraiven, playing with our community members, or do you have another question?",
  "confidence_score": 0.9,
  "requires_clarification": true,
  "next_action_suggestion": null
}
`;

  const example2 = `
Example 2 (Clear application interest):
Conversation History:
WraivenBot: Hello, [User], welcome to Wraiven!
WraivenBot: What is your purpose for joining the Wraiven Discord channel?
Latest User Message: "i want to apply to your guild"
Expected JSON:
{
  "intent": "GUILD_APPLICATION_INTEREST",
  "entities": { "mentioned_class": null, "mentioned_experience_level": null, "desired_role": null, "vouch_person_name": null, "original_vouch_text": null, "question_topic": "application_process" },
  "suggested_bot_response": "Great! It sounds like you're interested in applying to Wraiven. We can start that process. To begin, could you tell me about your main character's name, class, and level?",
  "confidence_score": 0.98,
  "requires_clarification": false,
  "next_action_suggestion": "START_APPLICATION_QUESTIONS"
}
`;

  const example3 = `
Example 3 (Specific vouch):
Conversation History:
WraivenBot: Hello, [User], welcome to Wraiven!
WraivenBot: What is your purpose for joining the Wraiven Discord channel?
Latest User Message: "My friend @SomeDude told me to join"
Expected JSON:
{
  "intent": "COMMUNITY_INTEREST_VOUCH",
  "entities": { "mentioned_class": null, "mentioned_experience_level": null, "desired_role": null, "vouch_person_name": "@SomeDude", "original_vouch_text": "My friend @SomeDude told me to join", "question_topic": null },
  "suggested_bot_response": "Excellent! I see @SomeDude mentioned you. I'll start the vouch process with them.",
  "confidence_score": 0.95,
  "requires_clarification": false,
  "next_action_suggestion": "INITIATE_VOUCH_FOR_@SomeDude"
}
`;

  const example4 = `
Example 4 (Generic vouch):
Conversation History:
WraivenBot: Hello, [User], welcome to Wraiven!
WraivenBot: What is your purpose for joining the Wraiven Discord channel?
Latest User Message: "my friends are in here"
Expected JSON:
{
  "intent": "COMMUNITY_INTEREST_VOUCH",
  "entities": { "mentioned_class": null, "mentioned_experience_level": null, "desired_role": null, "vouch_person_name": null, "original_vouch_text": "my friends are in here", "question_topic": null },
  "suggested_bot_response": "Happy to have you join our community! Do you have a specific friend in Wraiven who can vouch for you? If so, please @mention them or tell me their name.",
  "confidence_score": 0.9,
  "requires_clarification": true,
  "next_action_suggestion": "REQUEST_SPECIFIC_VOUCH_NAME"
}
`;

  const example5 = `
Example 5 (Simple greeting):
Conversation History:
WraivenBot: Hello, [User], welcome to Wraiven!
WraivenBot: What is your purpose for joining the Wraiven Discord channel?
Latest User Message: "hi"
Expected JSON:
{
  "intent": "SOCIAL_GREETING",
  "entities": { "mentioned_class": null, "mentioned_experience_level": null, "desired_role": null, "vouch_person_name": null, "original_vouch_text": null, "question_topic": null },
  "suggested_bot_response": "Hello there! Welcome to Wraiven. To help me direct you, are you looking to apply, join our community, or ask a question?",
  "confidence_score": 0.85,
  "requires_clarification": true,
  "next_action_suggestion": null
}
`;

  const example6 = `
Example 6 (Specific question):
Conversation History:
WraivenBot: Hello, [User], welcome to Wraiven!
WraivenBot: What is your purpose for joining the Wraiven Discord channel?
Latest User Message: "What are your raid times?"
Expected JSON:
{
  "intent": "GENERAL_QUESTION",
  "entities": { "mentioned_class": null, "mentioned_experience_level": null, "desired_role": null, "vouch_person_name": null, "original_vouch_text": null, "question_topic": "raid_times" },
  "suggested_bot_response": "Our current active timeframe is 21:00-05:00 UTC. For specific raid schedules, it's best to check our announcements or ask an officer once you're in!",
  "confidence_score": 0.92,
  "requires_clarification": false,
  "next_action_suggestion": null
}
`;

  const conversationHistoryString = conversationHistory
    .map(
      (msg) => `${msg.author === "user" || msg.role === "user" ? "User" : "WraivenBot"}: ${msg.content}`
    )
    .join("\n");

  const systemPrompt = `You are an advanced AI assistant for "${GUILD_NAME}", a Discord bot for the MMORPG Albion Online Guild "${GUILD_NAME}".
Your primary mission is to understand a new user's intention when they first join the server and send a message in their private processing channel. Your goal is to guide them towards one of three main paths: applying to the guild, joining the community (possibly with a vouch), or asking a specific question.

GUILD CONTEXT:
- Guild Name: ${GUILD_NAME}
${guildContext}
- Current User ID: ${userId}

INTENT CLASSIFICATION & RESPONSE GUIDELINES:

1.  **Primary User Goals & Intents**:
    *   GUILD_APPLICATION_INTEREST: User clearly expresses interest in formally joining "${GUILD_NAME}" as a member (e.g., "how to apply", "want to join guild", "looking for a guild like yours").
        *   requires_clarification: false
        *   suggested_bot_response: Acknowledge their interest and briefly state what to expect next (e.g., "Great! It sounds like you're interested in applying to ${GUILD_NAME}. We can start that process. First, tell me about your main character...").
    *   COMMUNITY_INTEREST_VOUCH: User wants to join the community, play with friends already in the guild, or mentions a vouch.
        *   If a specific person is mentioned for vouching (e.g., "CJ told me to join", "@CJ can vouch"):
            *   Extract name/mention into vouch_person_name and the original text into original_vouch_text.
            *   requires_clarification: false (if name is specific).
            *   suggested_bot_response: "Thanks for letting me know! I'll try to connect with [vouch_person_name] for you." or similar.
        *   If a generic vouch is mentioned (e.g., "my friends", "someone said I should join") OR if the user just wants to hang out/play with unspecified members:
            *   Set vouch_person_name: null.
            *   requires_clarification: true.
            *   suggested_bot_response: "Happy to have you join our community! Do you have a specific friend in ${GUILD_NAME} who can vouch for you? If so, please @mention them or tell me their name."
    *   GENERAL_QUESTION: User asks a specific question not directly tied to immediate application or vouching (e.g., "What are your raid times?", "What's the guild tax?", "What kind of content do you run?").
        *   requires_clarification: false (usually, unless the question itself is vague).
        *   suggested_bot_response: Attempt to answer based on GUILD CONTEXT if possible, or state that a recruiter can help.
    *   UNCLEAR_INTENT: User's initial message (often in response to "What is your purpose for joining?") is vague, too short, or doesn't clearly fit the above. THIS IS THE DEFAULT FOR AMBIGUITY.
        *   requires_clarification: true.
        *   suggested_bot_response: ALWAYS ask a clarifying question to guide them to one of the primary goals. Examples:
            *   "Welcome to ${GUILD_NAME}! To best assist you, are you looking to formally apply to the guild, join our community (perhaps with a friend who is already a member), or do you have a specific question about us?"
            *   "Okay! To help me understand better, are you interested in applying to become a member of ${GUILD_NAME}, playing with our community members, or do you have another question?"
    *   SOCIAL_GREETING: Simple greetings ("hi", "hello") with no other substance.
        *   requires_clarification: true.
        *   suggested_bot_response: A friendly welcome and the standard clarification question from UNCLEAR_INTENT to guide them. E.g., "Hello there! Welcome to ${GUILD_NAME}. To help me direct you, are you looking to apply, join our community, or ask a question?"
    *   OTHER: If the intent is discernible but doesn't fit any of the above (rare for initial interactions).

2.  **Critical Rule for Vagueness**: If the "Latest User Message" is short, vague (e.g., "info", "pvp", "content", "here to play"), or a generic statement that doesn't clearly indicate one of the primary intents above, you MUST classify it as UNCLEAR_INTENT, set requires_clarification: true, and use one of the example suggested_bot_responses for UNCLEAR_INTENT to guide the user. Do NOT try to guess a specific intent from highly ambiguous input.

3.  **Entity Extraction**:
    *   vouch_person_name: Only populate if a specific name or @mention is given for a vouch.
    *   original_vouch_text: The user's text that indicated a vouch.
    *   Other entities (mentioned_class, mentioned_experience_level, desired_role, question_topic): Populate if clearly stated. Otherwise, null.

4.  confidence_score: Your best estimate (0.0-1.0).
5.  next_action_suggestion: For internal bot use, can be null.

FEW-SHOT EXAMPLES:
${example1}
${example2}
${example3}
${example4}
${example5}
${example6}

Conversation History (if any):
${conversationHistoryString}

Latest User Message: "${userMessage}"

Respond ONLY with a valid JSON object matching this exact format (do not add any text before or after the JSON object):
${JSON.stringify(expectedJsonResponseFormat, null, 2)}
Ensure all string fields in the JSON are populated appropriately or set to null if no information is extracted.`;

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

  // Construct Guild Information string from config
  const guildInfoDetails = [];
  if (GUILD_INFO.PRIMARY_ACTIVITIES) guildInfoDetails.push(`- Primary Activities: ${GUILD_INFO.PRIMARY_ACTIVITIES}`);
  if (GUILD_INFO.PLAYER_DEVELOPMENT_INFO) guildInfoDetails.push(`- Player Development: ${GUILD_INFO.PLAYER_DEVELOPMENT_INFO}`);
  if (GUILD_INFO.LOOT_SYSTEM) guildInfoDetails.push(`- Loot System: ${GUILD_INFO.LOOT_SYSTEM}`);
  if (GUILD_INFO.ACTIVE_TIMEFRAME_UTC) guildInfoDetails.push(`- Active Times (UTC): ${GUILD_INFO.ACTIVE_TIMEFRAME_UTC}`);
  if (GUILD_INFO.ALLIANCE) guildInfoDetails.push(`- Alliance: ${GUILD_INFO.ALLIANCE}`);
  if (GUILD_INFO.TAX_RATE_PERCENT !== undefined) guildInfoDetails.push(`- Tax Rate: ${GUILD_INFO.TAX_RATE_PERCENT}%`);
  const guildContext = guildInfoDetails.join('\n');

  const systemPrompt = createSystemPrompt(GUILD_NAME, guildContext, userId, conversationHistory, userMessage, expectedJsonResponseFormat);

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