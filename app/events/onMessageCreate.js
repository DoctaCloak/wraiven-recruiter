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
const PLACEHOLDER_EMPTY_CONTENT = "<message content not available>"; // Placeholder for empty/null content

const ConversationStep = { 
    IDLE: 'IDLE',
    AWAITING_INITIAL_USER_MESSAGE: 'AWAITING_INITIAL_USER_MESSAGE',
    AWAITING_CLARIFICATION: 'AWAITING_CLARIFICATION',
    AWAITING_VOUCH_MENTION: 'AWAITING_VOUCH_MENTION',
    AWAITING_APPLICATION_ANSWER: 'AWAITING_APPLICATION_ANSWER',
    GENERAL_LISTENING: 'GENERAL_LISTENING',
    VOUCH_PROCESS_ACTIVE: 'VOUCH_PROCESS_ACTIVE',
    APPLICATION_PROCESS_ACTIVE: 'APPLICATION_PROCESS_ACTIVE',
    PROCESSING_INITIAL_RESPONSE: 'PROCESSING_INITIAL_RESPONSE',
};


export default function onMessageCreate(client, database) {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return; 

    const guild = message.guild;
    if (!guild) return; 

    // Validate message content early, used for logging and processing
    const currentMessageContent = (message.content && message.content.trim() !== "") ? message.content : PLACEHOLDER_EMPTY_CONTENT;

    if (!message.channel.name || !message.channel.name.startsWith(PROCESSING_CHANNEL_PREFIX)) {
        return;
    }
    
    console.log(`[onMessageCreate] Received message from ${message.author.tag} in ${message.channel.name}: "${currentMessageContent}" (Original: "${message.content}")`);

    const recruitmentCollection = database.collection("recruitment");
    const messageHistoryCollection = database.collection("messageHistory");
    const userId = message.author.id;

    console.log(`[onMessageCreate] Attempting to find user data for userId: ${userId}`);
    let userData = await recruitmentCollection.findOne({ userId: userId });

    if (userData) {
        console.log(`[onMessageCreate] User data FOUND for userId: ${userId}.`); // Removed full data log for brevity
        if (userData.channelId !== message.channel.id) {
            console.warn(`[onMessageCreate] User ${userId} record has channelId '${userData.channelId}', but message is from channel '${message.channel.id}'. Mismatch.`);
            userData = null; 
        } else {
            console.log(`[onMessageCreate] User ${userId} record channelId '${userData.channelId}' matches message channelId '${message.channel.id}'.`);
        }
    } else {
        console.log(`[onMessageCreate] User data NOT FOUND for userId: ${userId} in recruitmentCollection.`);
    }

    if (!userData) {
        console.log(`[onMessageCreate] User data invalid or channel mismatch for userId: ${userId}, channelId: ${message.channel.id}. No rehydration.`);
        return;
    }
    if (!userData.conversationState) {
        console.log(`[onMessageCreate] User data for userId: ${userId} found and channel matches, but conversationState is MISSING. Initializing it now.`);
        userData.conversationState = {
            currentStep: ConversationStep.IDLE, 
            stepEntryTimestamp: new Date(),
            timeoutTimestamp: null, 
            activeCollectorType: null,
            attemptCount: 0,
            lastLlmIntent: null,
            lastDiscordMessageIdProcessed: null // Ensure this is part of init
        };
        try {
            await recruitmentCollection.updateOne(
                { userId: userId }, 
                { $set: { conversationState: userData.conversationState, lastActivityAt: new Date() } }
            );
            console.log(`[onMessageCreate] Successfully initialized conversationState for userId: ${userId}`);
        } catch (dbError) {
            console.error(`[onMessageCreate] Failed to update DB with initialized conversationState for userId: ${userId}`, dbError);
        }
    }

    const { conversationState } = userData;
    const currentStep = conversationState.currentStep;
    const activeCollectorType = conversationState.activeCollectorType;
    const lastProcessedMessageId = conversationState.lastDiscordMessageIdProcessed;
    
    console.log(`[onMessageCreate] User ${userId}, Current Step: ${currentStep}, Active Collector: ${activeCollectorType}, LastProcessedMsgID: ${lastProcessedMessageId}`);

    if (currentStep === ConversationStep.PROCESSING_INITIAL_RESPONSE && lastProcessedMessageId === message.id) {
        console.log(`[onMessageCreate] Message ${message.id} for user ${userId} is currently being processed by onGuildMemberAdd initial collector. Ignoring in onMessageCreate.`);
        return;
    }

    if (currentStep === ConversationStep.AWAITING_CLARIFICATION || 
        currentStep === ConversationStep.AWAITING_VOUCH_MENTION || 
        currentStep === ConversationStep.AWAITING_APPLICATION_ANSWER || 
        currentStep === ConversationStep.GENERAL_LISTENING ||
        (currentStep === ConversationStep.IDLE && activeCollectorType === null) 
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

        const knownMessageIds = new Set(dbMessages.map(msg => msg.discordMessageId).filter(id => id));
        let recentDiscordMessages = new Collection();
        try {
            recentDiscordMessages = await message.channel.messages.fetch({ limit: 30 }); 
        } catch (fetchError) {
            console.error(`[onMessageCreate] Error fetching recent messages from Discord channel ${message.channel.id}:`, fetchError);
            await notifyStaff(guild, `Error fetching recent messages from Discord channel for ${member.user.tag}. Error: ${fetchError.message}`, "DISCORD_FETCH_ERROR_REHYDRATE").catch(console.error);
        }

        const messagesToSaveToDb = [];
        const allMessagesTemp = dbMessages.map(dbMsg => ({ // Ensure content from DB is also validated
            ...dbMsg,
            content: (dbMsg.messageContent && dbMsg.messageContent.trim() !== "") ? dbMsg.messageContent : PLACEHOLDER_EMPTY_CONTENT
        })); 

        for (const discordMsg of recentDiscordMessages.reverse().values()) {
            if (knownMessageIds.has(discordMsg.id)) continue;
            
            const msgContent = (discordMsg.content && discordMsg.content.trim() !== "") ? discordMsg.content : PLACEHOLDER_EMPTY_CONTENT;

            const roughlySameTimeAndContent = allMessagesTemp.find(tempMsg => 
                Math.abs(new Date(tempMsg.timestamp).getTime() - discordMsg.createdTimestamp) < 2000 && 
                tempMsg.content === msgContent && // Compare with validated content
                ((discordMsg.author.id === userId && tempMsg.author === 'user') || (discordMsg.author.bot && discordMsg.author.id === client.user.id && tempMsg.author === 'bot'))
            );
            if (roughlySameTimeAndContent && !allMessagesTemp.find(dbm => dbm.discordMessageId === discordMsg.id)){
                if(roughlySameTimeAndContent._id && !roughlySameTimeAndContent.discordMessageId){
                    messageHistoryCollection.updateOne({_id: roughlySameTimeAndContent._id}, {$set: {discordMessageId: discordMsg.id}}).catch(err => console.error("Error updating discordMessageId", err));
                    knownMessageIds.add(discordMsg.id); 
                }
                continue;
            }
            if (roughlySameTimeAndContent) continue;

            const formattedMissedMessage = {
                discordMessageId: discordMsg.id,
                userId: userId, 
                channelId: discordMsg.channel.id,
                author: discordMsg.author.id === userId ? "user" : (discordMsg.author.bot && discordMsg.author.id === client.user.id ? "bot" : "other_user_or_bot"),
                content: msgContent, // Use validated content
                messageContent: msgContent, // For DB storage consistency with logBotMsgToHistory
                timestamp: new Date(discordMsg.createdTimestamp),
                llm_response_object: null, 
                savedFromDiscordFetch: true
            };

            if (formattedMissedMessage.author === "user" || formattedMissedMessage.author === "bot") {
                allMessagesTemp.push(formattedMissedMessage);
                // Prepare for DB: use messageContent field as per logBotMsgToHistory
                const dbEntry = {...formattedMissedMessage}; 
                delete dbEntry.content; // remove 'content' if it was just for LLM prep, rely on messageContent
                messagesToSaveToDb.push(dbEntry);
                knownMessageIds.add(discordMsg.id); 
            }
        }

        allMessagesTemp.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        if (messagesToSaveToDb.length > 0) {
            console.log(`[onMessageCreate] Saving ${messagesToSaveToDb.length} missed messages to DB for user ${userId}.`);
            messageHistoryCollection.insertMany(messagesToSaveToDb, { ordered: false }).catch(err => {
                console.error(`[onMessageCreate] Error bulk saving missed messages to DB for ${userId}:`, err);
            });
        }

        conversationHistoryForLLM = allMessagesTemp.map(msg => ({
            role: msg.author === "user" ? "user" : "assistant", 
            // content field here should be the one used for LLM, which we validated earlier as msg.content or dbMsg.messageContent
            content: (msg.content && msg.content.trim() !== "") ? msg.content : ((msg.messageContent && msg.messageContent.trim() !== "") ? msg.messageContent : PLACEHOLDER_EMPTY_CONTENT)
        }));        
        
        if (!knownMessageIds.has(message.id)) {
            try {
                const currentUserMessageEntry = {
                    discordMessageId: message.id,
                    userId: member.user.id,
                    channelId: message.channel.id,
                    author: "user",
                    messageContent: currentMessageContent, // Use validated content for DB
                    timestamp: new Date(message.createdTimestamp),
                    savedFromDiscordFetch: false 
                };
                await messageHistoryCollection.insertOne(currentUserMessageEntry);
                await recruitmentCollection.updateOne(
                    { userId: member.user.id, channelId: message.channel.id }, 
                    { $set: { lastActivityAt: new Date() } }
                );
                conversationHistoryForLLM.push({ role: "user", content: currentMessageContent }); // Use validated content for LLM history
            } catch (dbError) {
                console.error(`[onMessageCreate] Error saving current user message to history for ${member.user.tag}:`, dbError);
                await message.channel.send("I had a small hiccup recording your current message. Please try sending it again. If this persists, contact staff.").catch(console.error);
                return; 
            }
        } else {
            const lastMsgInHistory = conversationHistoryForLLM[conversationHistoryForLLM.length -1];
            if (!lastMsgInHistory || (lastMsgInHistory.content !== currentMessageContent && lastMsgInHistory.content !== PLACEHOLDER_EMPTY_CONTENT) || lastMsgInHistory.role !== 'user'){    
                console.warn("[onMessageCreate] Current message was in knownMessageIds but not last in history or content mismatch. Appending validated content.")
                conversationHistoryForLLM.push({ role: "user", content: currentMessageContent }); // Use validated content
            }
        }

        const rehydratedLlmResponse = await processUserMessageWithLLM(
            currentMessageContent, // Use validated content for the primary message to LLM
            conversationHistoryForLLM, 
            member.user.username, // Changed from member.user.id as per llm_utils.js expectation
            member.id             // Added member.id as per llm_utils.js expectation
        );
        
        console.log("[onMessageCreate] Rehydrated LLM Response Received:", JSON.stringify(rehydratedLlmResponse, null, 2));

        let nextAttemptCount = 0;
        if (rehydratedLlmResponse?.requires_clarification) {
            if (currentStep === ConversationStep.AWAITING_CLARIFICATION && activeCollectorType === 'CLARIFICATION') {
                nextAttemptCount = (conversationState.attemptCount || 0) + 1;
            } else {
                nextAttemptCount = 1; 
            }
        } 

        await handleClarificationLoop(
            member,
            message.channel,
            rehydratedLlmResponse,      
            conversationHistoryForLLM, 
            recruitmentCollection,
            messageHistoryCollection,
            guild,
            nextAttemptCount,           
            message.id // Pass current message ID to HCL
        );
    } else {
        console.log(`[onMessageCreate] User ${userId} in step ${currentStep} with collector ${activeCollectorType}. No direct message rehydration action defined for this combination currently.`);
    }

  });
}
