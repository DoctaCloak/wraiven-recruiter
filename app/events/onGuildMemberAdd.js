import { Events, PermissionsBitField, ChannelType } from "discord.js";
import fs from 'fs';
import path from 'path';
// import { getAccountRestrictionEmbed } from "./utils/onGuildMemberAdd.js"; // This utility was self-contained or needs to be re-evaluated
import { processUserMessageWithLLM } from "../utils/llm_utils.js";
import { initiateVouchProcess, notifyStaff } from "../utils/discord_actions.js";

// Load configuration
const configPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

/********************************************
 * CONSTANTS & CONFIG (from config.json)
 ********************************************/
const MIN_ACCOUNT_AGE_DAYS = config.ACCOUNT_RESTRICTIONS.MIN_ACCOUNT_AGE_DAYS;
const MIN_ACCOUNT_AGE_MS = MIN_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000;

const GUILD_NAME = config.GUILD_NAME;
const PROCESSING_CATEGORY_NAME = config.CATEGORIES.RECRUITMENT_PROCESSING; // Assuming this is what "City Gates" was for, or add a new specific config
const CITY_GATES_CATEGORY_NAME = config.CATEGORIES.CITY_GATES;
const MEMBER_ROLE_NAME = config.ROLES.MEMBER;
const BOT_COMMAND_CHANNEL_NAME = config.CHANNELS.BOT_COMMANDS;
const FRIEND_ROLE_NAME = config.ROLES.FRIEND;
const RECRUITER_ROLE_NAME = config.ROLES.RECRUITER;
const BOT_ROLE_NAME = config.ROLES.BOT;
const OUTSIDER_ROLE_NAME = config.ROLES.OUTSIDER;

const INITIAL_USER_RESPONSE_TIMEOUT_MS = config.TIMERS.INITIAL_USER_RESPONSE_MINUTES * 60 * 1000;
const VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS = config.TIMERS.VOUCH_MENTION_CLARIFICATION_MINUTES * 60 * 1000;
const GENERAL_CLARIFICATION_TIMEOUT_MS = config.TIMERS.GENERAL_CLARIFICATION_MINUTES * 60 * 1000;

const MAX_CLARIFICATION_ATTEMPTS = 3;

const ACCESS_STATUS = {
  PENDING: "PENDING",
  DENIED: "DENIED",
  ACCEPTED: "ACCEPTED",
};

const COMMUNITY_STATUS = {
  PENDING: "PENDING",
  DENIED: "DENIED",
  ACCEPTED: "ACCEPTED",
};

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

// Roles Map - uses names from config now
const rolesMap = new Map();
rolesMap.set("RECRUITER", RECRUITER_ROLE_NAME);
rolesMap.set("BOT", BOT_ROLE_NAME);


/********************************************
 * HELPER FUNCTIONS
 ********************************************/

// Function getAccountRestrictionEmbed would need to be defined here or imported if used.
// For now, assuming it's either not critical or defined elsewhere if handleAccountAgeRestriction is uncommented.

/**
 * Kicks the user if their account is younger than MIN_ACCOUNT_AGE_DAYS.
 * Returns true if the user was kicked (so we can stop the flow), false otherwise.
 */
async function handleAccountAgeRestriction(member) {
  const accountCreationTime = member.user.createdTimestamp; // ms since epoch
  const accountAge = Date.now() - accountCreationTime;

  if (accountAge < MIN_ACCOUNT_AGE_MS) {
    try {
      // Placeholder for embed logic if getAccountRestrictionEmbed is not available
      await member.send(`Your account is too new to join. Accounts must be at least ${MIN_ACCOUNT_AGE_DAYS} days old.`);
      console.log(`Sent account age restriction DM to ${member.user.tag}`);
    } catch (dmError) {
      console.error(`Failed to DM ${member.user.tag}:`, dmError);
    }

    try {
      await member.kick(`Account younger than ${MIN_ACCOUNT_AGE_DAYS} days.`);
      console.log(
        `Kicked ${member.user.tag} (account < ${MIN_ACCOUNT_AGE_DAYS} days old).`
      );
    } catch (kickError) {
      console.error(`Failed to kick ${member.user.tag}:`, kickError);
    }
    return true;
  }
  return false; // Old enough, continue
}

/**
 * Ensures we have (or create) a category (e.g. "City Gates").
 * Returns the category channel, or null if creation fails.
 */
async function ensureCategory(guild, categoryName) {
  let category = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name === categoryName
  );

  if (!category) {
    try {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
      });
      console.log(`Created "${categoryName}" category successfully.`);
    } catch (error) {
      console.error(`Unable to create "${categoryName}" category: `, error);
      return null;
    }
  }
  return category;
}


/**
 * Ensures the user's "processing" channel exists and permissions are correct.
 * Returns the channel. Creates it if needed; updates perms if it exists.
 */
async function ensureUserProcessingChannel(
  member,
  channelId,
  recruitmentCollection
) {
  const guild = member.guild;

  // 1) Find or create the processing category
  const processingCategory = await ensureCategory(guild, PROCESSING_CATEGORY_NAME);
  if (!processingCategory) {
      console.error(`Failed to find or create the category: ${PROCESSING_CATEGORY_NAME}. Processing channel cannot be created.`);
      // Notify staff about this critical issue
      await notifyStaff(guild, `CRITICAL: Could not find or create the category named \"${PROCESSING_CATEGORY_NAME}\". New user processing channels cannot be created. Please check bot permissions and category configuration.`, "CONFIG_ERROR_PROCESSING_CATEGORY");
      return null;
  }

  // 2) See if we already have a channel ID in DB
  let channel = channelId ? guild.channels.cache.get(channelId) : null;

  if (!channel) {
    const channelName = `processing-${member.user.username}`;
    try {
        channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: processingCategory.id, // Use the fetched/created category ID
        });

        await recruitmentCollection.updateOne(
            { userId: member.user.id },
            { $set: { channelId: channel.id } }
        );
        console.log(`Created channel "${channelName}" for ${member.user.tag} in category "${processingCategory.name}"`);
    } catch (error) {
        console.error(`Failed to create processing channel for ${member.user.tag}:`, error);
        const botCommandsChannel = guild.channels.cache.find(ch => ch.name === BOT_COMMAND_CHANNEL_NAME && ch.type === ChannelType.GuildText);
        if (botCommandsChannel) {
            await botCommandsChannel.send(`Critical error: Could not create processing channel for ${member.user.tag} in category ${PROCESSING_CATEGORY_NAME}. Please check permissions. User has been informed.`);
        }
        try {
            await member.send("I was unable to create a private channel for you due to a server configuration issue. Please contact a staff member.");
        } catch (dmErr) { console.error("Failed to DM user about channel creation failure", dmErr);}
        return null; 
    }
  } else {
    console.log(
      `Using existing channel (#${channel.name}) for ${member.user.tag}`
    );
  }

  try {
    const permissionOverwrites = buildProcessingChannelPermissions(member, guild); // buildProcessingChannelPermissions uses rolesMap which now uses config
    await channel.permissionOverwrites.set(permissionOverwrites);
  } catch (error) {
      console.error(`Failed to set permissions for channel ${channel.name} for ${member.user.tag}:`, error);
  }

  return channel;
}

/**
 * Builds permission overwrites for a "processing" channel,
 * granting the specified member (and relevant roles) the needed access.
 */
function buildProcessingChannelPermissions(member, guild) {
  // Look up roles by name (storing IDs is usually better in production).
  const recruiterRole = guild.roles.cache.find(
    (role) => role.name === rolesMap.get("RECRUITER")
  );
  const botRole = guild.roles.cache.find(
    (role) => role.name === rolesMap.get("BOT")
  );

  // The user gets full access, @everyone is denied, special roles get partial access.
  const overwrites = [
    {
      id: guild.id, // @everyone
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: member.id, // The new or returning user
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ];

  if (recruiterRole && recruiterRole.id) {
    overwrites.push({
      id: recruiterRole.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
      ],
    });
  }

  if (botRole && botRole.id) {
    overwrites.push({
      id: botRole.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.ManageRoles,
      ],
    });
  }
  return overwrites;
}

/**
 * Processes a rejoining user:
 *  - Reassign their old role, if it still exists.
 *  - Ensure or re-create their processing channel (and set perms).
 *  - Send a "welcome back" message there.
 */
async function processRejoiningUser(member, userData, recruitmentCollection) {
  console.log(`User ${member.user.tag} rejoined the server.`);

  const guild = member.guild;
  const { role, channelId } = userData;
  let messageHistory = userData.messageHistory || []; // Ensure messageHistory is an array

  // Re-assign stored role by name (if it exists)
  const storedRole = guild.roles.cache.find((r) => r.name === role);
  if (storedRole && !member.roles.cache.has(storedRole.id)) {
    try {
      await member.roles.add(storedRole);
      console.log(`Reassigned role "${storedRole.name}" to ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Error reassigning role "${storedRole.name}" to ${member.user.tag}:`,
        error
      );
    }
  }

  // Create or find channel, set perms, etc.
  const channel = await ensureUserProcessingChannel(
    member,
    channelId,
    recruitmentCollection
  );
  if (!channel) {
    console.error(`[ProcessRejoin] Could not ensure processing channel for ${member.user.tag}. Aborting.`);
    return; // Critical failure, cannot proceed
  }

  // DM the user with their channel link (optional; only if newly created?)
  const channelLink = `https://discord.com/channels/${guild.id}/${channel.id}`;
  try {
    await member.send(
      `Welcome back, **${member.user.username}**!\n` +
        `Your private channel is ready: ${channelLink}`
    );
  } catch (dmError) {
    console.error(`Failed to DM ${member.user.tag}:`, dmError);
  }

  // Send a welcome-back message
  await channel.send(
    `Hey, welcome back **${member.user.username}**!\n${
      messageHistory.length
        ? "Are you here to continue where you left off?"
        : "Let us know how we can help you this time!"
    }`
  );
}

/**
 * Processes a brand-new user:
 *  - Assign "Outsider" role if it exists.
 *  - Initialize DB entry.
 *  - Create a new processing channel, set perms, DM them the link, etc.
 */
async function processNewUser(member, database) {
  console.log(`New user ${member.user.tag} joined the server.`);

  const guild = member.guild;
  const userId = member.user.id;
  const recruitmentCollection = database.collection("recruitment");
  const messageHistoryCollection = database.collection("messageHistory");

  const outsiderRole = guild.roles.cache.find((r) => r.name === OUTSIDER_ROLE_NAME);
  if (outsiderRole && !member.roles.cache.has(outsiderRole.id)) {
    try {
      await member.roles.add(outsiderRole);
      console.log(`Assigned "${OUTSIDER_ROLE_NAME}" role to ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Error assigning "${OUTSIDER_ROLE_NAME}" role to ${member.user.tag}:`,
        error
      );
    }
  }

  const channel = await ensureUserProcessingChannel(
    member,
    null, 
    recruitmentCollection
  );

  if (!channel) {
    console.error(`[ProcessNewUser] Could not ensure processing channel for ${member.user.tag}. Aborting new user setup.`);
    return; 
  }

  try {
    await recruitmentCollection.updateOne(
      { userId },
      {
        $set: {
          userId,
          username: member.user.username,
          channelId: channel.id, 
          applicationStatus: ACCESS_STATUS.PENDING,
          communityStatus: COMMUNITY_STATUS.PENDING,
          role: outsiderRole ? outsiderRole.name : null, // Uses OUTSIDER_ROLE_NAME
          joinedAt: new Date(), 
          lastActivityAt: new Date(),
          messageHistory: [], 
          logs: [{timestamp: new Date(), event: "New user processed"}],
          conversationState: { // Initialize conversation state
            currentStep: ConversationStep.AWAITING_INITIAL_USER_MESSAGE,
            stepEntryTimestamp: new Date(),
            timeoutTimestamp: new Date(Date.now() + INITIAL_USER_RESPONSE_TIMEOUT_MS),
            activeCollectorType: 'INITIAL_USER_RESPONSE',
            attemptCount: 0
          }
        },
      },
      { upsert: true }
    );
    console.log(`Initialized database entry for ${member.user.tag} and set initial conversation state.`);
  } catch (error) {
    console.error(`Error initializing DB entry for ${member.user.tag}:`, error);
  }

  const channelLink = `https://discord.com/channels/${guild.id}/${channel.id}`;
  try {
    await member.send(
      `Hello **${member.user.username}**, welcome to ${GUILD_NAME}!\n` +
        `Your private channel is ready: ${channelLink}`
    );
  } catch (dmError) {
    console.error(`Failed to DM ${member.user.tag}:`, dmError);
  }

  const welcomeMsg1 = `Hello, **${member.user.username}**, welcome to ${GUILD_NAME}!`;
  const welcomeMsg2 = `What is your purpose for joining the ${GUILD_NAME} Discord channel?`; // Used GUILD_NAME
  await channel.send(welcomeMsg1);
  await channel.send(welcomeMsg2);

  try {
    await messageHistoryCollection.insertMany([
        { userId, channelId: channel.id, author: "bot", content: welcomeMsg1, timestamp: new Date() },
        { userId, channelId: channel.id, author: "bot", content: welcomeMsg2, timestamp: new Date() }
    ]);
  } catch(e){ console.error("DB Error logging welcome messages:", e); }


  const filter = (m) => m.author.id === member.id && m.channel.id === channel.id;
  const collector = channel.createMessageCollector({
    filter,
    max: 1, 
    time: INITIAL_USER_RESPONSE_TIMEOUT_MS, // Used config timer
  });

  collector.on("collect", async (message) => {
    console.log(
      `Collected response from ${member.user.tag}: "${message.content}"`
    );

    try {
      await messageHistoryCollection.insertOne({
        userId: member.user.id,
        channelId: channel.id,
        author: "user",
        content: message.content,
        timestamp: new Date(message.createdTimestamp),
        discordMessageId: message.id
      });
      await recruitmentCollection.updateOne(
        { userId: member.user.id }, 
        { $set: { lastActivityAt: new Date() } }
      );
    } catch (dbError) {
      console.error(
        `Error saving user message to messageHistoryCollection for ${member.user.tag}:`,
        dbError
      );
    }

    let conversationHistoryForLLM = [];
    try {
      const userHistory = await messageHistoryCollection.find(
          { userId: member.user.id, channelId: channel.id }
        ).sort({ timestamp: 1 }).toArray(); 
      
      conversationHistoryForLLM = userHistory.map((histMessage) => ({
        role: histMessage.author === "user" ? "user" : "assistant", 
        content: histMessage.content,
      }));
    } catch (dbError) {
      console.error(
        `Error fetching conversation history for LLM for ${member.user.tag}:`,
        dbError
      );
    }

    const firstLlmResponse = await processUserMessageWithLLM(
      message.content, 
      member.user.id,
      conversationHistoryForLLM,
      channel.id
    );
    console.log("[RecruiterApp] First LLM Response Received:", JSON.stringify(firstLlmResponse, null, 2));

    let initialBotMessageSent = false;
    if (firstLlmResponse && firstLlmResponse.suggested_bot_response) {
        try {
            const sentMessage = await channel.send(firstLlmResponse.suggested_bot_response);
            await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, firstLlmResponse.suggested_bot_response, sentMessage.id, firstLlmResponse);
            initialBotMessageSent = true;
        } catch (sendError) {
            console.error(`Error sending initial LLM suggested response: ${sendError}`);
        }
    }

    if (!initialBotMessageSent) { 
        const fallbackResponse = "Thanks for your message! I'm processing that and will get back to you.";
        if (!channel.deleted) {
            const sentFallbackMessage = await channel.send(fallbackResponse).catch(console.error);
            if (sentFallbackMessage) {
                 await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, fallbackResponse, sentFallbackMessage.id);
            }
        } else {
            // If channel is deleted, we can't get a message ID, but still log the attempt if necessary
            await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, fallbackResponse, null); 
        }
    }

    // Update history for the loop to include the user's first message and the bot's first response
    const historyForLoopStart = [
        ...conversationHistoryForLLM, // Already contains user's first message
        { role: "assistant", content: firstLlmResponse?.suggested_bot_response || "Thanks for your message!" } 
    ];

    // Now, hand off to the unified clarification loop
    await recruitmentCollection.updateOne({ userId: member.id }, { $set: { 
        "conversationState.currentStep": firstLlmResponse?.requires_clarification ? ConversationStep.AWAITING_CLARIFICATION : ConversationStep.GENERAL_LISTENING,
        "conversationState.lastLlmIntent": firstLlmResponse?.intent,
        "conversationState.stepEntryTimestamp": new Date(),
        "conversationState.timeoutTimestamp": new Date(Date.now() + (firstLlmResponse?.requires_clarification ? GENERAL_CLARIFICATION_TIMEOUT_MS : GENERAL_CLARIFICATION_TIMEOUT_MS * 2)),
        "conversationState.activeCollectorType": firstLlmResponse?.requires_clarification ? 'CLARIFICATION' : 'GENERAL',
        "conversationState.attemptCount": firstLlmResponse?.requires_clarification ? 1 : 0
    } });

    await handleClarificationLoop(
        member,
        channel,
        firstLlmResponse, 
        historyForLoopStart, 
        recruitmentCollection,
        messageHistoryCollection,
        guild,
        firstLlmResponse?.requires_clarification ? 1 : 0
    );
  });

  collector.on("end", async (collected, reason) => {
    if (reason === "time" && collected.size === 0) { 
      console.log(
        `User ${member.user.tag} did not respond within the time limit.`
      );
      const timeoutMsg = "It looks like you might be busy. Feel free to respond when you're ready, or a recruiter will check in with you later.";
      if (channel && !channel.deleted) { 
        try {
            const sentTimeoutMsg = await channel.send(timeoutMsg);
            await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, timeoutMsg, sentTimeoutMsg.id);
        } catch (e) {
            console.error(`Error sending timeout message to channel ${channel?.name}:`, e);
        }
      }
    }
  });
}

// Define logBotMsgToHistory as an exportable function
export async function logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, msgContent, discordMessageId = null, llmRespObj = null) {
    if (!msgContent) return;
    try {
        const logEntry = {
            userId: userId,
            channelId: channelId,
            author: "bot",
            content: msgContent,
            timestamp: new Date(),
            discordMessageId: discordMessageId,
            llm_response_object: null
        };
        if (llmRespObj) {
            logEntry.llm_response_object = llmRespObj;
        }
        await messageHistoryCollection.insertOne(logEntry);
        await recruitmentCollection.updateOne(
          { userId: userId }, 
          { $set: { lastActivityAt: new Date() } }
        );
    } catch (e) { console.error("[RecruiterApp/logBotMsgToHistory] DB Error logging bot message:", e); }
}

export async function handleClarificationLoop(
  member,
  channel,
  initialLlmResponse, 
  currentConversationHistory, 
  recruitmentCollection,
  messageHistoryCollection,
  guild,
  attemptCount = 0
) {
  console.log(`[Clarify ${attemptCount}] Starting loop. Prev LLM Intent: ${initialLlmResponse?.intent}, Requires Clarification: ${initialLlmResponse?.requires_clarification}`);

  // If the initialLlmResponse itself indicates an error, handle it and exit.
  if (!initialLlmResponse || initialLlmResponse.intent === "ERROR_NO_API_KEY" || initialLlmResponse.intent === "ERROR_OPENAI_API_CALL" || initialLlmResponse.intent === "ERROR_OPENAI_EMPTY_RESPONSE") {
    const errMsg = initialLlmResponse?.suggested_bot_response || "I'm having trouble with my AI brain. A staff member will assist.";
    // Bot message already sent by caller if it was the *first* LLM response.
    // If this error occurs deeper in the loop, we might need to send it here.
    // For now, assume caller (processNewUser or a recursive call) sent the error message.
    console.error(`[Clarify Loop] LLM processing error detected from initialLlmResponse: ${initialLlmResponse?.error}`);
    // No message sent here as it should have been sent by the context that produced this error response.
    // However, if this is a critical unrecoverable error for the loop, notify staff.
    if (attemptCount === 0) { // Only notify if it's an error on the first pass into the loop from external
        await notifyStaff(guild, `LLM Error for ${member.user.tag} in ${channel.name} at loop start: ${initialLlmResponse?.error || 'Unknown LLM processing error'}.`, "LLM_ERROR_LOOP_START");
    }
    return; // Exit loop on error
  }

  // Max attempts check is for *clarification cycles*.
  if (initialLlmResponse.requires_clarification && attemptCount >= MAX_CLARIFICATION_ATTEMPTS) {
    const maxAttemptsMsg = "I've tried to understand a few times, but I'm still not quite sure how to help. A staff member will reach out to you shortly in this channel.";
    const sentMaxAttemptsMsg = await channel.send(maxAttemptsMsg);
    await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, maxAttemptsMsg, sentMaxAttemptsMsg.id);
    await notifyStaff(guild, `User ${member.user.tag} in channel ${channel.name} reached max LLM clarification attempts. Last known intent: ${initialLlmResponse.intent}. Please assist.`, "MAX_CLARIFICATION_REACHED");
    console.log(`[Clarify Loop] Max attempts reached for ${member.user.tag}. Staff notified.`);
    await recruitmentCollection.updateOne({ userId: member.id }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.stepEntryTimestamp": new Date() } });
    return;
  }
  
  let conversationShouldContinue = !initialLlmResponse.requires_clarification;
  let nextUserMessageContent; // To be populated by collectors

  if (initialLlmResponse.requires_clarification) {
    conversationShouldContinue = false; // Explicitly false, waiting for specific clarification
    
    // Update DB state before setting up collector
    await recruitmentCollection.updateOne({ userId: member.id }, { $set: { 
        "conversationState.currentStep": ConversationStep.AWAITING_CLARIFICATION,
        "conversationState.activeCollectorType": 'CLARIFICATION',
        "conversationState.stepEntryTimestamp": new Date(),
        "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS),
        "conversationState.attemptCount": attemptCount // Current attempt count for this clarification cycle
    } });

    const clarificationCollector = channel.createMessageCollector({
      filter: (m) => m.author.id === member.id,
      time: GENERAL_CLARIFICATION_TIMEOUT_MS,
      max: 1,
    });

    clarificationCollector.on("collect", async (collected) => {
      nextUserMessageContent = collected.content.trim();
      await messageHistoryCollection.insertOne({
        userId: member.id,
        channelId: channel.id,
        author: "user",
        content: nextUserMessageContent,
        timestamp: new Date(),
        llmProcessingDetails: null,
        discordMessageId: collected.id
      });
      
      const nextLlmResponse = await processUserMessageWithLLM(
        nextUserMessageContent,
        member.user.id,
        currentConversationHistory, // History up to the bot's clarification question
        channel.id
      );

      if (nextLlmResponse && nextLlmResponse.suggested_bot_response) {
        const sentNextLlmMsg = await channel.send(nextLlmResponse.suggested_bot_response);
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, nextLlmResponse.suggested_bot_response, sentNextLlmMsg.id, nextLlmResponse);
      }

      const historyForNextLoopIteration = [
          ...currentConversationHistory,
          { role: "user", content: nextUserMessageContent },
          { role: "assistant", content: nextLlmResponse?.suggested_bot_response || "" }
      ];

      await recruitmentCollection.updateOne({ userId: member.id }, { $set: { 
          "conversationState.currentStep": nextLlmResponse?.requires_clarification ? ConversationStep.AWAITING_CLARIFICATION : ConversationStep.GENERAL_LISTENING,
          "conversationState.lastLlmIntent": nextLlmResponse?.intent,
          "conversationState.stepEntryTimestamp": new Date(),
          "conversationState.timeoutTimestamp": new Date(Date.now() + (nextLlmResponse?.requires_clarification ? GENERAL_CLARIFICATION_TIMEOUT_MS : GENERAL_CLARIFICATION_TIMEOUT_MS * 2)),
          "conversationState.activeCollectorType": nextLlmResponse?.requires_clarification ? 'CLARIFICATION' : 'GENERAL',
          "conversationState.attemptCount": nextLlmResponse?.requires_clarification ? (attemptCount + 1) : 0
      } });

      await handleClarificationLoop(
        member,
        channel,
        nextLlmResponse, // Pass the new LLM response
        historyForNextLoopIteration,
        recruitmentCollection,
        messageHistoryCollection,
        guild,
        attemptCount + 1
      );
    });

    clarificationCollector.on("end", async (collected, reason) => {
      if (reason === 'time' && collected.size === 0) {
        const timeoutMsg = "It looks like you might have stepped away. If you're back and need something, just send a message!";
        if (!channel.deleted) {
            const sentClarifyTimeoutMsg = await channel.send(timeoutMsg).catch(console.error);
            if (sentClarifyTimeoutMsg) {
                await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, timeoutMsg, sentClarifyTimeoutMsg.id);
            }
        } else {
             await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, timeoutMsg, null);
        }
        console.log(`[Clarify Loop] Clarification timed out for ${member.user.tag}.`);
        await recruitmentCollection.updateOne({ userId: member.id }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.stepEntryTimestamp": new Date() } });
      }
    });
  } else {
    // No clarification needed from initialLlmResponse, process the intent.
    // The bot's response for initialLlmResponse was already sent by the caller (processNewUser or previous loop iteration)
    switch (initialLlmResponse.intent) {
      case "GUILD_APPLICATION_INTEREST":
        conversationShouldContinue = false;
        console.log(`[Clarify Loop] User ${member.user.tag} expressed GUILD_APPLICATION_INTEREST.`);
        await recruitmentCollection.updateOne(
          { userId: member.id },
          { $set: { 
              intent: "GUILD_APPLICATION_INTEREST", 
              status: "PENDING_APPLICATION_INFO", 
              lastIntentTimestamp: new Date(),
              "conversationState.currentStep": ConversationStep.AWAITING_APPLICATION_ANSWER, // Or APPLICATION_PROCESS_ACTIVE
              "conversationState.activeCollectorType": 'APPLICATION_ANSWER',
              "conversationState.questionContext": 'first_question',
              "conversationState.stepEntryTimestamp": new Date(),
              // TODO: Add timeout for application answer
            } }
        );
        const firstQuestion = "Great! We're excited you're interested in Wraiven. To start, what is your main character's in-game name, primary class, and general experience with Albion Online?";
        const sentFirstQuestion = await channel.send(firstQuestion);
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, firstQuestion, sentFirstQuestion.id);
        await notifyStaff(guild, `User ${member.user.tag} (${member.user.username}) in channel ${channel.name} has expressed interest in applying to the guild. Waiting for answers to initial questions.`, "APPLICATION_INTEREST_NOTIFICATION");
        break;

      case "COMMUNITY_INTEREST_VOUCH":
        console.log(`[Clarify Loop] User ${member.user.tag} expressed COMMUNITY_INTEREST_VOUCH.`);
        if (initialLlmResponse.entities?.vouch_person_name) {
          conversationShouldContinue = false; 
          await initiateVouchProcess(
            member,
            channel,
            initialLlmResponse.entities.vouch_person_name,
            initialLlmResponse.entities.original_vouch_text,
            recruitmentCollection,
            messageHistoryCollection,
            guild
          );
        } else {
          conversationShouldContinue = false; // While mentionCollector is active
          // DB state update for awaiting vouch mention
          await recruitmentCollection.updateOne({ userId: member.id }, { $set: { 
              "conversationState.currentStep": ConversationStep.AWAITING_VOUCH_MENTION,
              "conversationState.activeCollectorType": 'VOUCH_MENTION',
              "conversationState.stepEntryTimestamp": new Date(),
              "conversationState.timeoutTimestamp": new Date(Date.now() + VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS)
          } });

          const vouchClarificationMsg = initialLlmResponse.suggested_bot_response || "It sounds like you're looking to join the community or play with friends! Do you have a specific guild member who can vouch for you? If so, please @mention them or provide their Discord name.";
          const mentionCollector = channel.createMessageCollector({
            filter: (m) => m.author.id === member.id,
            time: VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS,
            max: 1,
          });

          mentionCollector.on("collect", async (collectedMention) => {
            const mentionedName = collectedMention.content.trim();
            await messageHistoryCollection.insertOne({
                userId: member.id,
                channelId: channel.id,
                author: "user",
                content: mentionedName,
                timestamp: new Date(),
                llmProcessingDetails: null, 
                discordMessageId: collectedMention.id
            });
            
            const historyForVouchAttempt = [
                ...currentConversationHistory,
                { role: "user", content: mentionedName}
            ];
            const tempLlmResponseForVouch = {
                intent: "COMMUNITY_INTEREST_VOUCH",
                entities: { vouch_person_name: mentionedName, original_vouch_text: mentionedName },
                suggested_bot_response: `Okay, checking for ${mentionedName}...`,
                requires_clarification: false
            };
            const sentVouchCheckMsg = await channel.send(tempLlmResponseForVouch.suggested_bot_response);
            await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, tempLlmResponseForVouch.suggested_bot_response, sentVouchCheckMsg.id, tempLlmResponseForVouch);

            await initiateVouchProcess(
                member,
                channel,
                mentionedName,
                mentionedName,
                recruitmentCollection,
                messageHistoryCollection,
                guild
            );
          });

          mentionCollector.on("end", async (collectedMention, reason) => {
            if (reason === 'time' && collectedMention.size === 0) {
              const noMentionMsg = "No problem! If you don't have a specific vouch right now, you can explore our public channels or reach out if you remember their name later.";
              if (!channel.deleted) {
                  const sentNoMentionMsg = await channel.send(noMentionMsg).catch(console.error);
                  if (sentNoMentionMsg) {
                    await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, noMentionMsg, sentNoMentionMsg.id);
                  }
              } else {
                  await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, noMentionMsg, null);
              }
              await recruitmentCollection.updateOne(
                  { userId: member.id },
                  { $set: { 
                      intent: "COMMUNITY_INTEREST_NO_VOUCH", 
                      status: "COMMUNITY_EXPLORING", 
                      lastIntentTimestamp: new Date(),
                      "conversationState.currentStep": ConversationStep.GENERAL_LISTENING, // Or IDLE, then re-trigger general listening
                      "conversationState.activeCollectorType": 'GENERAL',
                      "conversationState.stepEntryTimestamp": new Date(),
                      "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS * 2) 
                    } }
              );
              conversationShouldContinue = true;
              
              await recruitmentCollection.updateOne({ userId: member.id }, { $set: { 
                  intent: "POST_VOUCH_MENTION_TIMEOUT", 
                  status: "COMMUNITY_EXPLORING", 
                  lastIntentTimestamp: new Date(),
                  "conversationState.currentStep": ConversationStep.GENERAL_LISTENING,
                  "conversationState.activeCollectorType": 'GENERAL',
                  "conversationState.stepEntryTimestamp": new Date(),
                  "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS * 2) 
                } }
              );
            }
          });
        }
        break;

      case "GENERAL_QUESTION":
      case "SOCIAL_GREETING":
      case "UNCLEAR_INTENT": 
      case "OTHER":
      default:
        console.log(`[Clarify Loop] Intent: ${initialLlmResponse.intent} for ${member.user.tag}. No specific action, will set up general listener if no clarification needed.`);
        break;
    }
  }

  if (conversationShouldContinue) {
    console.log(`[Clarify Loop] Setting up general listener for ${member.user.tag} in channel ${channel.name}.`);
    // Update DB state before setting up general listener
    await recruitmentCollection.updateOne({ userId: member.id }, { $set: { 
        "conversationState.currentStep": ConversationStep.GENERAL_LISTENING,
        "conversationState.activeCollectorType": 'GENERAL',
        "conversationState.stepEntryTimestamp": new Date(),
        "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS * 2),
        "conversationState.lastLlmIntent": initialLlmResponse?.intent // Good to store the intent that led to general listening
    } });

    const generalListenerCollector = channel.createMessageCollector({
      filter: (m) => m.author.id === member.id,
      time: GENERAL_CLARIFICATION_TIMEOUT_MS * 2, 
    });

    generalListenerCollector.on("collect", async (collected) => {
      generalListenerCollector.stop(); 
      const newMessageContent = collected.content.trim();
      await messageHistoryCollection.insertOne({
        userId: member.id,
        channelId: channel.id,
        author: "user",
        content: newMessageContent,
        timestamp: new Date(),
        llmProcessingDetails: null,
        discordMessageId: collected.id
      });

      console.log(`[General Listener] Collected: "${newMessageContent}" from ${member.user.tag}. Processing with LLM.`);
      
      const nextLlmResponse = await processUserMessageWithLLM(
        newMessageContent,
        member.user.id,
        currentConversationHistory, // History up to the bot's last general response
        channel.id
      );

      if (nextLlmResponse && nextLlmResponse.suggested_bot_response) {
        const sentGeneralNextLlmMsg = await channel.send(nextLlmResponse.suggested_bot_response);
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, nextLlmResponse.suggested_bot_response, sentGeneralNextLlmMsg.id, nextLlmResponse);
      }
      
      const historyForNextLoopIteration = [
        ...currentConversationHistory,
        { role: "user", content: newMessageContent },
        { role: "assistant", content: nextLlmResponse?.suggested_bot_response || "" }
      ];

      await recruitmentCollection.updateOne({ userId: member.id }, { $set: { 
          "conversationState.currentStep": nextLlmResponse?.requires_clarification ? ConversationStep.AWAITING_CLARIFICATION : ConversationStep.GENERAL_LISTENING,
          "conversationState.lastLlmIntent": nextLlmResponse?.intent,
          "conversationState.stepEntryTimestamp": new Date(),
          "conversationState.timeoutTimestamp": new Date(Date.now() + (nextLlmResponse?.requires_clarification ? GENERAL_CLARIFICATION_TIMEOUT_MS : GENERAL_CLARIFICATION_TIMEOUT_MS * 2)),
          "conversationState.activeCollectorType": nextLlmResponse?.requires_clarification ? 'CLARIFICATION' : 'GENERAL',
          "conversationState.attemptCount": nextLlmResponse?.requires_clarification ? 1 : 0
      } });

      await handleClarificationLoop(
        member,
        channel,
        nextLlmResponse, // Pass the new LLM response
        historyForNextLoopIteration,
        recruitmentCollection,
        messageHistoryCollection,
        guild,
        nextLlmResponse?.requires_clarification ? 1 : 0
      );
    });

    generalListenerCollector.on("end", async (collected, reason) => {
      if (reason !== 'message' && reason !== 'stop') { // stop is manual from collector.stop()
        console.log(`[General Listener] Timed out for ${member.user.tag} in channel ${channel.name}. Reason: ${reason}`);
        const inactivityMsg = "It looks like you've been idle for a bit. If you need anything else, just send a message!";
        if (guild.channels.cache.has(channel.id) && !channel.deleted) {
            try {
                const sentInactivityMsg = await channel.send(inactivityMsg).catch(console.error);
                if (sentInactivityMsg) {
                    await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, channel.id, inactivityMsg, sentInactivityMsg.id);
                }
                await recruitmentCollection.updateOne({ userId: member.id }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.stepEntryTimestamp": new Date() } });
            } catch (error) {
                console.warn(`[General Listener] Could not send inactivity message to ${channel.name}, possibly deleted: ${error.message}`);
            }
        }
      }
    });
  }
}

/********************************************
 * MAIN EVENT HANDLER (exported)
 ********************************************/
export default function onGuildMemberAdd(client, database) {
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return; 

    // const wasKicked = await handleAccountAgeRestriction(member); // Uncomment to enable
    // if (wasKicked) return;

    const recruitmentCollection = database.collection("recruitment");
    const userId = member.user.id;
    const userData = await recruitmentCollection.findOne({ userId });

    if (userData) {
      await processRejoiningUser(member, userData, recruitmentCollection);
    } else {
      await processNewUser(member, database);
    }
  });
}
