import { Events, Collection } from "discord.js";
import fs from 'fs';
import path from 'path';
import { handleClarificationLoop, logBotMsgToHistory } from "../events/onGuildMemberAdd.js";
import { processUserMessageWithLLM } from "../utils/llm_utils.js";
import { notifyStaff } from "../utils/discord_actions.js"; // Added for error reporting

// Load configuration
const configPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const PROCESSING_CHANNEL_PREFIX = config.CHANNEL_PREFIXES?.RECRUITMENT_PROCESSING || "processing-";
const GENERAL_CLARIFICATION_TIMEOUT_MS = config.TIMERS.GENERAL_CLARIFICATION_MINUTES * 60 * 1000;

const ConversationStep = { 
    IDLE: 'IDLE',
    AWAITING_INITIAL_USER_MESSAGE: 'AWAITING_INITIAL_USER_MESSAGE',
    AWAITING_CLARIFICATION: 'AWAITING_CLARIFICATION',
    AWAITING_VOUCH_MENTION: 'AWAITING_VOUCH_MENTION',
    AWAITING_APPLICATION_ANSWER: 'AWAITING_APPLICATION_ANSWER',
    GENERAL_LISTENING: 'GENERAL_LISTENING',
    VOUCH_PROCESS_ACTIVE: 'VOUCH_PROCESS_ACTIVE',
    APPLICATION_PROCESS_ACTIVE: 'APPLICATION_PROCESS_ACTIVE',
};


export default function onMessageCreate(client, database) {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return; 

    const guild = message.guild;
    if (!guild) return; 

    if (!message.channel.name || !message.channel.name.startsWith(PROCESSING_CHANNEL_PREFIX)) {
        return;
    }
    
    console.log(`[onMessageCreate] Received message from ${message.author.tag} in ${message.channel.name}: "${message.content}"`);

    const recruitmentCollection = database.collection("recruitment");
    const messageHistoryCollection = database.collection("messageHistory");
    const userId = message.author.id;

    console.log(`[onMessageCreate] Attempting to find user data for userId: ${userId}`);
    let userData = await recruitmentCollection.findOne({ userId: userId });

    if (userData) {
        console.log(`[onMessageCreate] User data FOUND for userId: ${userId}. Full data:`, JSON.stringify(userData, null, 2));
        if (userData.channelId !== message.channel.id) {
            console.warn(`[onMessageCreate] User ${userId} record has channelId '${userData.channelId}', but message is from channel '${message.channel.id}'. Mismatch.`);
            // For safety, nullify userData to prevent rehydration with a mismatched channel context for now.
            // Depending on desired behavior, one might update userData.channelId here if this new channel should become primary.
            userData = null; 
        } else {
            console.log(`[onMessageCreate] User ${userId} record channelId '${userData.channelId}' matches message channelId '${message.channel.id}'.`);
        }
    } else {
        console.log(`[onMessageCreate] User data NOT FOUND for userId: ${userId} in recruitmentCollection.`);
    }

    // Proceed only if userData is still valid (exists, channel matches, and has conversationState)
    if (!userData) {
        console.log(`[onMessageCreate] User data invalid or channel mismatch for userId: ${userId}, channelId: ${message.channel.id}. No rehydration.`);
        return;
    }
    if (!userData.conversationState) {
        console.log(`[onMessageCreate] User data for userId: ${userId} found and channel matches, but conversationState is MISSING. Initializing it now.`);
        userData.conversationState = {
            currentStep: ConversationStep.IDLE, // Start them at IDLE, the loop will take over
            stepEntryTimestamp: new Date(),
            timeoutTimestamp: null, 
            activeCollectorType: null,
            attemptCount: 0,
            lastLlmIntent: null
        };
        try {
            await recruitmentCollection.updateOne(
                { userId: userId }, 
                { $set: { conversationState: userData.conversationState, lastActivityAt: new Date() } }
            );
            console.log(`[onMessageCreate] Successfully initialized conversationState for userId: ${userId}`);
        } catch (dbError) {
            console.error(`[onMessageCreate] Failed to update DB with initialized conversationState for userId: ${userId}`, dbError);
            // Don't return yet, try to proceed with the in-memory initialized state for this interaction.
        }
    }

    const { conversationState } = userData;
    const currentStep = conversationState.currentStep;
    const activeCollectorType = conversationState.activeCollectorType;
    
    console.log(`[onMessageCreate] User ${userId}, Current Step: ${currentStep}, Active Collector: ${activeCollectorType}`);

    // Only rehydrate if the bot was expecting a message from the user in this state.
    // These are states where a collector would have been active.
    if (currentStep === ConversationStep.AWAITING_CLARIFICATION || 
        currentStep === ConversationStep.AWAITING_VOUCH_MENTION || 
        currentStep === ConversationStep.AWAITING_APPLICATION_ANSWER || 
        currentStep === ConversationStep.GENERAL_LISTENING ||
        (currentStep === ConversationStep.IDLE && activeCollectorType === null) // A general message when bot is idle in channel
       ) {
        
        console.log(`[onMessageCreate] Rehydrating conversation for ${userId} at step ${currentStep}.`);
        
        const member = await guild.members.fetch(userId).catch(err => {
            console.error(`[onMessageCreate] Failed to fetch member ${userId}: ${err}`);
            return null;
        });
        if (!member) {
            console.warn(`[onMessageCreate] Could not fetch member ${userId}. Cannot rehydrate.`);
            return;
        }

        let dbMessages = [];
        try {
            dbMessages = await messageHistoryCollection.find(
                { userId: userId, channelId: message.channel.id }
            ).sort({ timestamp: 1 }).toArray();
        } catch (dbError) {
            console.error(`[onMessageCreate] Error fetching conversation history from DB for ${userId}:`, dbError);
            await message.channel.send("I'm having trouble remembering our past conversation (DB Error). A staff member will be notified.").catch(console.error);
            await notifyStaff(guild, `Error fetching message history from DB for ${member.user.tag} during rehydration. DB Error: ${dbError.message}`, "DB_HISTORY_ERROR_REHYDRATE").catch(console.error);
            return;
        }

        // Create a set of known message identifiers from the DB to help avoid duplicates
        // Assuming dbMessages store discordMessageId. If not, this check will be less effective.
        const knownMessageIds = new Set(dbMessages.map(msg => msg.discordMessageId).filter(id => id));

        let recentDiscordMessages = new Collection();
        try {
            recentDiscordMessages = await message.channel.messages.fetch({ limit: 30 }); // Fetch last 30 messages
        } catch (fetchError) {
            console.error(`[onMessageCreate] Error fetching recent messages from Discord channel ${message.channel.id}:`, fetchError);
            // Not a fatal error for rehydration, we can proceed with DB messages, but log it.
            await notifyStaff(guild, `Error fetching recent messages from Discord channel for ${member.user.tag}. Error: ${fetchError.message}`, "DISCORD_FETCH_ERROR_REHYDRATE").catch(console.error);
        }

        const messagesToSaveToDb = [];
        const allMessagesTemp = [...dbMessages]; // Start with DB messages

        // Iterate Discord messages (they come newest to oldest, so reverse for chronological processing)
        for (const discordMsg of recentDiscordMessages.reverse().values()) {
            if (knownMessageIds.has(discordMsg.id)) {
                continue; // Already have this message from DB
            }
            // Heuristic: if discordMessageId wasn't stored or matched, double check content and rough time
            // This is imperfect and ideally replaced by consistent discordMessageId storage.
            const roughlySameTimeAndContent = dbMessages.find(dbMsg => 
                Math.abs(new Date(dbMsg.timestamp).getTime() - discordMsg.createdTimestamp) < 2000 && // within 2 secs
                dbMsg.content === discordMsg.content &&
                ((discordMsg.author.id === userId && dbMsg.author === 'user') || (discordMsg.author.bot && discordMsg.author.id === client.user.id && dbMsg.author === 'bot'))
            );
            if (roughlySameTimeAndContent && !dbMessages.find(dbm => dbm.discordMessageId === discordMsg.id)){
                //Likely the same message but discordMessageId was not stored. Update the DB entry.
                if(roughlySameTimeAndContent._id){
                    messageHistoryCollection.updateOne({_id: roughlySameTimeAndContent._id}, {$set: {discordMessageId: discordMsg.id}}).catch(err => console.error("Error updating discordMessageId", err));
                    knownMessageIds.add(discordMsg.id); // Add it now that we've linked it
                }
                continue;
            }
            if (roughlySameTimeAndContent) continue;


            const formattedMissedMessage = {
                discordMessageId: discordMsg.id,
                userId: userId, // The user whose conversation this is
                channelId: discordMsg.channel.id,
                author: discordMsg.author.id === userId ? "user" : (discordMsg.author.bot && discordMsg.author.id === client.user.id ? "bot" : "other_user_or_bot"),
                content: discordMsg.content,
                timestamp: new Date(discordMsg.createdTimestamp),
                llm_response_object: null, // Missed messages wouldn't have this initially
                savedFromDiscordFetch: true
            };

            // Only process/save if it's from the current user or the bot itself for this conversation context
            if (formattedMissedMessage.author === "user" || formattedMissedMessage.author === "bot") {
                allMessagesTemp.push(formattedMissedMessage);
                messagesToSaveToDb.push(formattedMissedMessage);
                knownMessageIds.add(discordMsg.id); // Add to known IDs after processing
            }
        }

        // Sort all collected messages by timestamp
        allMessagesTemp.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        // Asynchronously save the newly found messages to the database
        if (messagesToSaveToDb.length > 0) {
            console.log(`[onMessageCreate] Saving ${messagesToSaveToDb.length} missed messages to DB for user ${userId}.`);
            messageHistoryCollection.insertMany(messagesToSaveToDb, { ordered: false }).catch(err => {
                console.error(`[onMessageCreate] Error bulk saving missed messages to DB for ${userId}:`, err);
                // Individual errors might occur if a message somehow got saved between fetch and insertMany (e.g. race condition)
            });
        }

        // This is the history for the LLM, from combined sources, sorted.
        let conversationHistoryForLLM;
        conversationHistoryForLLM = allMessagesTemp.map(msg => ({
            role: msg.author === "user" ? "user" : "assistant", // Map 'bot' to 'assistant' for LLM
            content: msg.content
        }));
        
        // Log the new incoming message (message that triggered onMessageCreate) to history BEFORE passing to LLM
        // Ensure this current message isn't already in allMessagesTemp from the fetch (if fetch was very fast)
        if (!knownMessageIds.has(message.id)) {
            try {
                const currentUserMessageEntry = {
                    discordMessageId: message.id,
                    userId: member.user.id,
                    channelId: message.channel.id,
                    author: "user",
                    content: message.content,
                    timestamp: new Date(message.createdTimestamp),
                    savedFromDiscordFetch: false // This is the triggering message
                };
                await messageHistoryCollection.insertOne(currentUserMessageEntry);
                await recruitmentCollection.updateOne(
                    { userId: member.user.id, channelId: message.channel.id }, 
                    { $set: { lastActivityAt: new Date() } }
                );
                conversationHistoryForLLM.push({ role: "user", content: message.content });
                // No need to add to knownMessageIds here as it's the current message, not part of historical fetch merge
            } catch (dbError) {
                console.error(`[onMessageCreate] Error saving current user message to history for ${member.user.tag}:`, dbError);
                await message.channel.send("I had a small hiccup recording your current message. Please try sending it again. If this persists, contact staff.").catch(console.error);
                return; 
            }
        } else {
             // Current message was already captured by the fetch (e.g. if bot restarted very quickly after message was sent)
             // Ensure it's the last one in conversationHistoryForLLM if it was part of allMessagesTemp
            const lastMsgInHistory = conversationHistoryForLLM[conversationHistoryForLLM.length -1];
            if (!lastMsgInHistory || lastMsgInHistory.content !== message.content || lastMsgInHistory.role !== 'user'){    
                //This should not happen if knownMessageIds.has(message.id) is true and allMessagesTemp was built correctly
                //But as a fallback, ensure the current message is correctly represented as the last user message.
                console.warn("[onMessageCreate] Current message was in knownMessageIds but not last in history. Appending.")
                conversationHistoryForLLM.push({ role: "user", content: message.content });
            }
        }

        // Now, process this new message with the LLM
        const rehydratedLlmResponse = await processUserMessageWithLLM(
            message.content,
            member.user.id,
            conversationHistoryForLLM, // This now includes the current message
            message.channel.id
        );
        
        console.log("[onMessageCreate] Rehydrated LLM Response Received:", JSON.stringify(rehydratedLlmResponse, null, 2));

        // --- MODIFICATION: Commenting out direct message sending and history update from onMessageCreate ---
        // // Send LLM's immediate response (if any) and log it
        // if (rehydratedLlmResponse && rehydratedLlmResponse.suggested_bot_response) {
        //     await message.channel.send(rehydratedLlmResponse.suggested_bot_response).catch(async sendErr => {
        //         console.error(`[onMessageCreate] Error sending rehydrated LLM response: ${sendErr}`)
        //         await notifyStaff(guild, `Error sending LLM response for ${member.user.tag} during rehydration. Error: ${sendErr.message}`, "LLM_SEND_ERROR_REHYDRATE").catch(console.error);
        //     });
        //     await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, message.channel.id, rehydratedLlmResponse.suggested_bot_response, rehydratedLlmResponse);
        //     // Update history for the loop to include the bot's response
        //     conversationHistoryForLLM.push({ role: "assistant", content: rehydratedLlmResponse.suggested_bot_response });
        // } else if (!rehydratedLlmResponse || rehydratedLlmResponse.error) {
        //     // If LLM had an error or no response, log and potentially send a generic message
        //     const fallbackMsg = "I'm having a little trouble processing that. Let me try to get back on track.";
        //     if(!rehydratedLlmResponse?.error?.includes("NO_API_KEY")) { // Avoid spamming if key is missing
        //       await message.channel.send(fallbackMsg).catch(console.error);
        //     }
        //     await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, message.channel.id, fallbackMsg, rehydratedLlmResponse);
        //     conversationHistoryForLLM.push({ role: "assistant", content: fallbackMsg });
        //     if (rehydratedLlmResponse?.error) {
        //          await notifyStaff(guild, `LLM Error for ${member.user.tag} during rehydration: ${rehydratedLlmResponse.error}. User was in step: ${currentStep}`, "LLM_ERROR_REHYDRATE").catch(console.error);
        //     }
        // }
        // If LLM has no response but no error, it might be a silent action or handled by the loop structure itself.
        // conversationHistoryForLLM passed to handleClarificationLoop will now end with the user's last message.
        // handleClarificationLoop will be responsible for sending the bot's reply, logging it, and updating its own copy of the history.
        // --- END MODIFICATION ---

        // Determine the attempt count for the rehydrated loop.
        // If the previous state was AWAITING_CLARIFICATION, increment its attempt count.
        // Otherwise, if the new LLM response requires clarification, start at 1.
        // If no clarification needed, it's 0.
        let nextAttemptCount = 0;
        if (rehydratedLlmResponse?.requires_clarification) {
            if (currentStep === ConversationStep.AWAITING_CLARIFICATION && activeCollectorType === 'CLARIFICATION') {
                nextAttemptCount = (conversationState.attemptCount || 0) + 1;
            } else {
                nextAttemptCount = 1; // Start a new clarification cycle
            }
        } 

        // --- MODIFICATION: Commenting out premature state update. handleClarificationLoop should manage this. ---
        // // Update DB state based on rehydratedLlmResponse before entering the loop
        // await recruitmentCollection.updateOne({ userId: member.id, channelId: message.channel.id }, { $set: { 
        //     "conversationState.currentStep": rehydratedLlmResponse?.requires_clarification ? ConversationStep.AWAITING_CLARIFICATION : ConversationStep.GENERAL_LISTENING,
        //     "conversationState.lastLlmIntent": rehydratedLlmResponse?.intent,
        //     "conversationState.stepEntryTimestamp": new Date(),
        //     "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS), // Reset timeout
        //     "conversationState.activeCollectorType": rehydratedLlmResponse?.requires_clarification ? 'CLARIFICATION' : 'GENERAL',
        //     "conversationState.attemptCount": nextAttemptCount
        // } });
        // --- END MODIFICATION ---

        // Now, call the main loop.
        // conversationHistoryForLLM currently includes the user's new message, but NOT the bot's response to it yet.
        await handleClarificationLoop(
            member,
            message.channel,
            rehydratedLlmResponse,      // The LLM response to the user's current message
            conversationHistoryForLLM, // History up to user's current message
            recruitmentCollection,
            messageHistoryCollection,
            guild,
            nextAttemptCount           // Use the calculated attempt count
        );
    } else {
        console.log(`[onMessageCreate] User ${userId} in step ${currentStep} with collector ${activeCollectorType}. No direct message rehydration action defined for this combination currently.`);
    }

  });
}
