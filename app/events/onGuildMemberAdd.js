import { Events, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
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
    try {
        const botMessageEntry = {
            discordMessageId: discordMessageId, // Store the Discord message ID if available
            userId: userId,
            channelId: channelId,
            author: "bot",
            content: msgContent,
            timestamp: new Date(),
            llm_response_object: llmRespObj,
            savedFromDiscordFetch: false
        };
        await messageHistoryCollection.insertOne(botMessageEntry);
        // Also update lastActivityAt in the main recruitment document
        await recruitmentCollection.updateOne(
            { userId: userId, channelId: channelId }, // Ensure we target the correct document
            { $set: { lastActivityAt: new Date() } }
        );
    } catch (error) {
        console.error(`[logBotMsgToHistory] Error saving bot message to history for user ${userId}:`, error);
    }
}

export async function handleClarificationLoop(
  member,
  channel,
  currentLlmResponse, // Renamed from initialLlmResponse
  conversationHistoryForLLM, // Renamed from currentConversationHistory
  recruitmentCollection,
  messageHistoryCollection,
  guild,
  attemptCount = 0
) {
  console.log(`[handleClarificationLoop] Entered. User: ${member.user.tag}, Attempt: ${attemptCount}`);
  console.log(`[handleClarificationLoop] Received LLM Response:`, JSON.stringify(currentLlmResponse, null, 2));
  console.log(`[handleClarificationLoop] Initial Conversation History (length ${conversationHistoryForLLM.length}):`, conversationHistoryForLLM.slice(-5)); // Log last 5 messages

  const userId = member.id;
  let conversationShouldContinue = true; // Flag to control the outer loop/listening
  let sentMessageId = null;
  let userData = await recruitmentCollection.findOne({ userId: userId, channelId: channel.id }); // Fetch userData once at the beginning

  // 1. Send bot's response based on currentLlmResponse and log it
  if (currentLlmResponse && currentLlmResponse.suggested_bot_response) {
    try {
      const sentMsg = await channel.send(currentLlmResponse.suggested_bot_response);
      sentMessageId = sentMsg.id;
      await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, currentLlmResponse.suggested_bot_response, sentMessageId, currentLlmResponse);
      conversationHistoryForLLM.push({ role: "assistant", content: currentLlmResponse.suggested_bot_response });
      console.log(`[handleClarificationLoop] Sent and logged LLM response for ${userId}. History length now ${conversationHistoryForLLM.length}`);
    } catch (sendError) {
      console.error(`[handleClarificationLoop] Error sending LLM suggested response for ${userId}:`, sendError);
      await notifyStaff(guild, `Error sending LLM response for ${member.user.tag} in handleClarificationLoop. Error: ${sendError.message}`, "LLM_SEND_ERROR_HCL").catch(console.error);
    }
  } else if (!currentLlmResponse || currentLlmResponse.error) {
    const fallbackMsg = "I'm having a little trouble with my thoughts right now. Could you try rephrasing, or I can get a staff member to help?";
    if (!currentLlmResponse?.error?.includes("NO_API_KEY")) {
      try {
        const sentMsg = await channel.send(fallbackMsg);
        sentMessageId = sentMsg.id;
      } catch (sendError) {
        console.error(`[handleClarificationLoop] Error sending fallback message for ${userId}:`, sendError);
      }
    }
    await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, fallbackMsg, sentMessageId, currentLlmResponse);
    conversationHistoryForLLM.push({ role: "assistant", content: fallbackMsg });
    console.log(`[handleClarificationLoop] Sent and logged fallback/error response for ${userId}. History length now ${conversationHistoryForLLM.length}`);
    if (currentLlmResponse?.error) {
      await notifyStaff(guild, `LLM Error for ${member.user.tag} in handleClarificationLoop: ${currentLlmResponse.error}.`, "LLM_ERROR_HCL").catch(console.error);
    }
    if (!currentLlmResponse) currentLlmResponse = {}; 
    currentLlmResponse.requires_clarification = true; 
    currentLlmResponse.intent = "UNCLEAR_INTENT";
  }

  // 2. Update conversation state in DB
  const requiresClarification = currentLlmResponse?.requires_clarification || false;
  const currentIntent = currentLlmResponse?.intent || "UNKNOWN_INTENT";
  let nextStep = ConversationStep.GENERAL_LISTENING;
  let nextCollectorType = 'GENERAL';
  let nextTimeoutMs = GENERAL_CLARIFICATION_TIMEOUT_MS;
  
  if (currentIntent === "GUILD_APPLICATION_INTEREST" && !requiresClarification) {
    nextStep = ConversationStep.GENERAL_LISTENING;
    nextCollectorType = 'GENERAL'; 
  } else if (requiresClarification) {
    nextStep = ConversationStep.AWAITING_CLARIFICATION;
    nextCollectorType = 'CLARIFICATION';
  } else {
    switch (currentIntent) {
      case "COMMUNITY_INTEREST_VOUCH":
        if (currentLlmResponse.vouch_person_name) {
          nextStep = ConversationStep.IDLE; 
          nextCollectorType = null;
          conversationShouldContinue = false; 
        } else {
          nextStep = ConversationStep.AWAITING_VOUCH_MENTION;
          nextCollectorType = 'VOUCH_MENTION';
          nextTimeoutMs = VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS;
        }
        break;
      case "END_CONVERSATION":
      case "USER_REQUESTED_STAFF":
        nextStep = ConversationStep.IDLE;
        nextCollectorType = null;
        conversationShouldContinue = false;
        break;
      default:
        nextStep = ConversationStep.GENERAL_LISTENING;
        nextCollectorType = 'GENERAL';
        break;
    }
  }
  
  const newConversationState = {
      currentStep: nextStep,
      stepEntryTimestamp: new Date(),
      timeoutTimestamp: nextCollectorType ? new Date(Date.now() + nextTimeoutMs) : null,
      activeCollectorType: nextCollectorType,
      attemptCount: requiresClarification ? attemptCount : 0, 
      lastLlmIntent: currentIntent,
      applicationQuestionIndex: null
  };

  try {
      await recruitmentCollection.updateOne(
          { userId: userId, channelId: channel.id },
          { $set: { conversationState: newConversationState, lastActivityAt: new Date() } }
      );
      console.log(`[handleClarificationLoop] Updated DB state for ${userId} to: ${nextStep}, collector: ${nextCollectorType}, intent: ${currentIntent}`);
      userData = await recruitmentCollection.findOne({ userId: userId, channelId: channel.id }); // Refresh userData after update
  } catch (dbError) {
      console.error(`[handleClarificationLoop] Failed to update conversationState in DB for ${userId}`, dbError);
  }

  // 3. Main logic based on LLM intent
  console.log(`[handleClarificationLoop] Processing intent: ${currentIntent} for ${userId}, Requires Clarification: ${requiresClarification}`);

  if (requiresClarification && attemptCount >= MAX_CLARIFICATION_ATTEMPTS) {
    console.log(`[handleClarificationLoop] Max clarification attempts reached for ${userId}.`);
    const staffMessage = `User ${member.user.tag} (channel: ${channel.name}) reached max clarification attempts. Last intent was '${currentIntent}'. Please assist.`;
    await notifyStaff(guild, staffMessage, "MAX_CLARIFICATION_REACHED");
    try {
        const sentStaffNotifMsg = await channel.send("I'm still having trouble understanding. I've notified a staff member to come and help you out!");
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, sentStaffNotifMsg.content, sentStaffNotifMsg.id, currentLlmResponse);
        conversationHistoryForLLM.push({ role: "assistant", content: sentStaffNotifMsg.content });
        await recruitmentCollection.updateOne({ userId: userId }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.activeCollectorType": null, "conversationState.timeoutTimestamp": null } });
    } catch (sendError) { console.error("Failed to send max attempts message or log it", sendError); }
    return; 
  }

  switch (currentIntent) {
    case "UNCLEAR_INTENT": // This case is primarily for when requiresClarification is true
      if (requiresClarification) {
        console.log(`[handleClarificationLoop] Setting up CLARIFICATION collector for ${userId}. Attempt ${attemptCount + 1}`);
        // Message asking for clarification was already sent at the top.
        const clarificationCollector = channel.createMessageCollector({
          filter: (m) => m.author.id === userId,
          time: GENERAL_CLARIFICATION_TIMEOUT_MS, 
          max: 1,
        });

        clarificationCollector.on("collect", async (m) => {
          console.log(`[ClarificationCollector] Collected: "${m.content}" from ${userId}`);
           try {
                const userMessageEntry = { discordMessageId: m.id, userId: userId, channelId: channel.id, author: "user", content: m.content, timestamp: new Date(m.createdTimestamp) };
                await messageHistoryCollection.insertOne(userMessageEntry);
                await recruitmentCollection.updateOne({ userId: userId, channelId: channel.id }, { $set: { lastActivityAt: new Date() } });
                conversationHistoryForLLM.push({ role: "user", content: m.content });
            } catch (dbErr) { console.error("DB error logging user clarification msg", dbErr); }

          const followUpLlmResponse = await processUserMessageWithLLM(m.content, userId, conversationHistoryForLLM, channel.id);
          await handleClarificationLoop(member, channel, followUpLlmResponse, conversationHistoryForLLM, recruitmentCollection, messageHistoryCollection, guild, attemptCount + 1);
        });

        clarificationCollector.on("end", async (collected, reason) => {
          if (reason === "time" && collected.size === 0) { // Check if collector ended due to timeout AND no messages were collected
            console.log(`[ClarificationCollector] Timed out for ${userId}.`);
            try {
                const timeoutMsgContent = "It looks like you've been quiet for a bit. If you're still there and need help, just send a message! Otherwise, this channel might be archived later.";
                const sentTimeoutMsg = await channel.send(timeoutMsgContent);
                await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, timeoutMsgContent, sentTimeoutMsg.id, null); 
                await recruitmentCollection.updateOne({ userId: userId }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.activeCollectorType": null, "conversationState.timeoutTimestamp": null } });
            } catch (sendError) { console.error("Failed to send clarification timeout message", sendError); }
          }
        });
      } else if (nextStep === ConversationStep.GENERAL_LISTENING && conversationShouldContinue) {
        console.log(`[handleClarificationLoop] Setting up GENERAL_LISTENING collector for ${userId}.`);
        const generalListenerCollector = channel.createMessageCollector({
          filter: (m) => m.author.id === userId,
          time: GENERAL_CLARIFICATION_TIMEOUT_MS * 3, 
        });

        generalListenerCollector.on("collect", async (m) => {
          console.log(`[GeneralListenerCollector] Collected: "${m.content}" from ${userId}`);
          generalListenerCollector.stop("newMessage"); 
          try {
                const userMessageEntry = { discordMessageId: m.id, userId: userId, channelId: channel.id, author: "user", content: m.content, timestamp: new Date(m.createdTimestamp) };
                await messageHistoryCollection.insertOne(userMessageEntry);
                await recruitmentCollection.updateOne({ userId: userId, channelId: channel.id }, { $set: { lastActivityAt: new Date() } });
                conversationHistoryForLLM.push({ role: "user", content: m.content });
            } catch (dbErr) { console.error("DB error logging user general msg", dbErr); }

          const followUpLlmResponse = await processUserMessageWithLLM(m.content, userId, conversationHistoryForLLM, channel.id);
          await handleClarificationLoop(member, channel, followUpLlmResponse, conversationHistoryForLLM, recruitmentCollection, messageHistoryCollection, guild, 0 );
        });

        generalListenerCollector.on("end", async (collected, reason) => {
          if (reason === "time" && collected.size === 0) {
            console.log(`[GeneralListenerCollector] Timed out for ${userId}. No new message for a while.`);
            await recruitmentCollection.updateOne({ userId: userId }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.activeCollectorType": null, "conversationState.timeoutTimestamp": null } });
          }
        });
      }
      break;

    case "GUILD_APPLICATION_INTEREST":
      if (!requiresClarification) { // Only proceed if LLM confirms application interest and no clarification needed
        console.log(`[handleClarificationLoop] Intent: GUILD_APPLICATION_INTEREST for ${userId}. Preparing to send ticket button.`);

        const ticketButton = new ButtonBuilder()
            .setCustomId('open_recruitment_ticket')
            .setLabel('Open Recruitment Ticket')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(ticketButton);
        
        const messageContent = currentLlmResponse.suggested_bot_response ? 
            `${currentLlmResponse.suggested_bot_response}\nIf you'd like to apply, please click the button below to open a recruitment ticket.`:
            "It sounds like you're interested in applying! Click the button below to open a recruitment ticket.";

        try {
            // The initial LLM response (if any) was already sent at the top of the function.
            // If that response already mentioned applying, this message with the button supplements it.
            // If there was no suggested_bot_response, this will be the primary message.
            
            // We need to decide if we *resend* the LLM's suggested_bot_response here OR rely on it being sent at the top.
            // For simplicity and to avoid double messages, let's assume suggested_bot_response was ALREADY sent if it existed.
            // So, the message here is primarily to present the button.

            const buttonMessageText = "To proceed with your application for Wraiven, please click the button below to open a dedicated recruitment ticket.";
            
            // If currentLlmResponse.suggested_bot_response was already sent, just send the button text.
            // Otherwise, combine them if the LLM's response was generic.
            // Given the code at the top, currentLlmResponse.suggested_bot_response was ALREADY sent.
            // So we just send the button prompt now.

            const sentButtonMessage = await channel.send({ 
                content: buttonMessageText,
                components: [row] 
            });
            await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, buttonMessageText, sentButtonMessage.id, null);
            conversationHistoryForLLM.push({ role: "assistant", content: buttonMessageText, components: "BUTTON_OPEN_TICKET" }); // Log button presence

            console.log(`[handleClarificationLoop] Sent 'Open Recruitment Ticket' button to ${userId} in channel ${channel.name}.`);

            // Update conversation state to general listening in this channel, as ticket opens a new one.
            await recruitmentCollection.updateOne(
                { userId: userId, channelId: channel.id },
                { $set: { 
                    "conversationState.currentStep": ConversationStep.GENERAL_LISTENING,
                    "conversationState.activeCollectorType": 'GENERAL',
                    "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS * 3),
                    "conversationState.lastLlmIntent": "APPLICATION_TICKET_OFFERED",
                    "conversationState.applicationQuestionIndex": null // Clear Q&A index
                }}
            );
            userData = await recruitmentCollection.findOne({ userId: userId, channelId: channel.id }); // Refresh userData

            // Set up a general listener in the current processing channel
            // This is crucial because the user might say something else here instead of clicking the button.
            conversationShouldContinue = true; // Ensure the default general listener might be set up
            nextStep = ConversationStep.GENERAL_LISTENING; // Confirm this state for the default block later
            nextCollectorType = 'GENERAL';


        } catch (error) {
            console.error(`[handleClarificationLoop] Error sending 'Open Recruitment Ticket' button for ${userId}:`, error);
            await notifyStaff(guild, `Error sending ticket button to ${member.user.tag}. Error: ${error.message}`, "TICKET_BUTTON_SEND_ERROR");
            // Fallback to general listening if button send fails
             await recruitmentCollection.updateOne(
                { userId: userId, channelId: channel.id },
                { $set: { 
                    "conversationState.currentStep": ConversationStep.GENERAL_LISTENING,
                    "conversationState.activeCollectorType": 'GENERAL',
                    "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS * 3)
                }}
            );
        }
      } else if (requiresClarification) {
          // If GUILD_APPLICATION_INTEREST but requiresClarification is true,
          // the standard clarification collector at the top (or in UNCLEAR_INTENT) will handle it.
          console.log(`[handleClarificationLoop] GUILD_APPLICATION_INTEREST with requiresClarification=true. Will be handled by clarification logic.`);
          // No specific action here, relies on the requiresClarification block and UNCLEAR_INTENT case collector.
      }
      break;

    case "COMMUNITY_INTEREST_VOUCH":
      console.log(`[handleClarificationLoop] Intent: COMMUNITY_INTEREST_VOUCH for ${userId}.`);
      if (currentLlmResponse.vouch_person_name && !requiresClarification) {
        // LLM identified a vouch target, and no further clarification needed on this.
        console.log(`[handleClarificationLoop] Vouch target: ${currentLlmResponse.vouch_person_name}. Initiating vouch process.`);
        // initiateVouchProcess handles its own DB updates for conversationState during its operation
        await initiateVouchProcess(member, channel, currentLlmResponse.vouch_person_name, recruitmentCollection, messageHistoryCollection, guild);
        // Vouch process is self-contained and will set its own state (e.g., VOUCH_PROCESS_ACTIVE then IDLE).
        // No further collector from handleClarificationLoop is needed here.
      } else {
        // Vouch mentioned, but name is unclear (requires_clarification should be true, or name is null)
        // Bot should have sent a message asking for @mention (from currentLlmResponse.suggested_bot_response)
        console.log(`[handleClarificationLoop] Setting up VOUCH_MENTION collector for ${userId}.`);
        
        await recruitmentCollection.updateOne({ userId: userId, channelId: channel.id }, { $set: { 
            "conversationState.currentStep": ConversationStep.AWAITING_VOUCH_MENTION,
            "conversationState.activeCollectorType": 'VOUCH_MENTION',
            "conversationState.stepEntryTimestamp": new Date(),
            "conversationState.timeoutTimestamp": new Date(Date.now() + VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS)
        }});

        const vouchMentionCollector = channel.createMessageCollector({
          filter: (m) => m.author.id === userId && m.mentions.users.size > 0,
          time: VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS,
          max: 1,
        });

        vouchMentionCollector.on("collect", async (m) => {
          const mentionedUser = m.mentions.users.first();
          console.log(`[VouchMentionCollector] Collected mention: @${mentionedUser.tag} from ${userId}`);
          
          try {
                const userMessageEntry = { discordMessageId: m.id, userId: userId, channelId: channel.id, author: "user", content: m.content, timestamp: new Date(m.createdTimestamp) };
                await messageHistoryCollection.insertOne(userMessageEntry);
                await recruitmentCollection.updateOne({ userId: userId, channelId: channel.id }, { $set: { lastActivityAt: new Date() } });
                // No need to add to conversationHistoryForLLM here as initiateVouchProcess will start fresh or handle history.
            } catch (dbErr) { console.error("DB error logging vouch mention msg", dbErr); }

          // Update state to reflect vouch process is starting. initiateVouchProcess will manage further state.
          await recruitmentCollection.updateOne({ userId: userId, channelId: channel.id }, { $set: { "conversationState.currentStep": ConversationStep.VOUCH_PROCESS_ACTIVE, "conversationState.activeCollectorType": null } });
          await initiateVouchProcess(member, channel, mentionedUser.tag, recruitmentCollection, messageHistoryCollection, guild);
        });

        vouchMentionCollector.on("end", async (collected, reason) => {
          if (reason === "time" && collected.size === 0) {
            console.log(`[VouchMentionCollector] Timed out for ${userId}. No valid mention.`);
            try {
                const timeoutMsg = "It looks like you didn't mention anyone. If you still want to proceed with a vouch, please @mention the person who can vouch for you. Otherwise, we can explore other options.";
                const sentMsg = await channel.send(timeoutMsg);
                await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, timeoutMsg, sentMsg.id, null);
                // Revert to general listening or await clarification for what to do next
                const fallbackLlmResponse = { intent: "UNCLEAR_INTENT", requires_clarification: true, suggested_bot_response: "What would you like to do next?" };
                conversationHistoryForLLM.push({role: "assistant", content: timeoutMsg}); // Add timeout to history
                // Call handleClarificationLoop again to decide next step (likely ask for clarification)
                 await handleClarificationLoop(
                    member, channel, fallbackLlmResponse, conversationHistoryForLLM, 
                    recruitmentCollection, messageHistoryCollection, guild, attemptCount + 1 // Increment attempt as it's a failed clarification
                );
            } catch (sendError) { console.error("Failed to send vouch mention timeout message", sendError); }
          }
        });
      }
      break;
    
    case "USER_REQUESTED_STAFF":
        console.log(`[handleClarificationLoop] User ${userId} requested staff assistance.`);
        const staffNotification = `User ${member.user.tag} (channel: ${channel.name}) has requested staff assistance. Last LLM intent: ${currentLlmResponse?.lastLlmIntent || 'N/A'}.`;
        await notifyStaff(guild, staffNotification, "USER_REQUESTED_STAFF");
        try {
            const sentMsg = await channel.send("Okay, I've notified the staff. Someone should be with you shortly!");
            await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, "Okay, I've notified the staff. Someone should be with you shortly!", sentMsg.id, currentLlmResponse);
            await recruitmentCollection.updateOne({ userId: userId }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.activeCollectorType": null } });
        } catch(e){console.error("Error sending staff notification confirmation", e);}
        break;

    case "END_CONVERSATION":
        console.log(`[handleClarificationLoop] User ${userId} or LLM indicated end of conversation.`);
        // Bot might have already sent a goodbye message via currentLlmResponse.suggested_bot_response
        // Ensure state is idle.
        await recruitmentCollection.updateOne({ userId: userId }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.activeCollectorType": null } });
        // Optionally, schedule channel for deletion after a delay if that's desired.
        break;
    
    // Add other specific intent handlers here if needed

    default: // Includes intents not explicitly handled above or if no clarification needed from GENERAL_QUESTION
      console.log(`[handleClarificationLoop] Default case for intent: ${currentIntent} for ${userId}. ConversationShouldContinue: ${conversationShouldContinue}`);
      if (conversationShouldContinue && nextStep === ConversationStep.GENERAL_LISTENING) { // Check if we decided to enter general listening
        console.log(`[handleClarificationLoop] Setting up GENERAL_LISTENING collector (from default case) for ${userId}.`);
        // This is similar to the general listener in the "UNCLEAR_INTENT" block but for other intents
        // that resolve to general listening without prior clarification.

        const generalListenerCollector = channel.createMessageCollector({
          filter: (m) => m.author.id === userId,
          time: GENERAL_CLARIFICATION_TIMEOUT_MS * 3, // Longer timeout
        });

        generalListenerCollector.on("collect", async (m) => {
          console.log(`[GeneralListenerCollector-Default] Collected: "${m.content}" from ${userId}`);
          generalListenerCollector.stop("newMessage");

          try {
                const userMessageEntry = { discordMessageId: m.id, userId: userId, channelId: channel.id, author: "user", content: m.content, timestamp: new Date(m.createdTimestamp) };
                await messageHistoryCollection.insertOne(userMessageEntry);
                await recruitmentCollection.updateOne({ userId: userId, channelId: channel.id }, { $set: { lastActivityAt: new Date() } });
                conversationHistoryForLLM.push({ role: "user", content: m.content });
            } catch (dbErr) { console.error("DB error logging user general msg from default", dbErr); }


          const followUpLlmResponse = await processUserMessageWithLLM(
            m.content,
            userId,
            conversationHistoryForLLM,
            channel.id
          );
          await handleClarificationLoop(
            member,
            channel,
            followUpLlmResponse,
            conversationHistoryForLLM,
            recruitmentCollection,
            messageHistoryCollection,
            guild,
            0 // Reset attempt count
          );
        });

        generalListenerCollector.on("end", async (collected, reason) => {
          if (reason === "time") {
            console.log(`[GeneralListenerCollector-Default] Timed out for ${userId}.`);
            await recruitmentCollection.updateOne({ userId: userId }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.activeCollectorType": null, "conversationState.timeoutTimestamp": null } });
          }
        });
      } else if (!conversationShouldContinue) {
        console.log(`[handleClarificationLoop] Default case for ${userId}, but conversationShouldContinue is false. No new collector.`);
         // Ensure state is sensible if conversation ended without explicit END_CONVERSATION intent
        const finalStateCheck = await recruitmentCollection.findOne({userId: userId}, {projection: {"conversationState.currentStep": 1}});
        if (finalStateCheck && finalStateCheck.conversationState && 
            finalStateCheck.conversationState.currentStep !== ConversationStep.IDLE &&
            finalStateCheck.conversationState.currentStep !== ConversationStep.VOUCH_PROCESS_ACTIVE && // Vouch process manages its own end state
            finalStateCheck.conversationState.currentStep !== ConversationStep.APPLICATION_PROCESS_ACTIVE // App process manages its own end state
            ) {
            // If an intent didn't explicitly set to IDLE (like vouch/application complete/staff notified)
            // and conversationShouldContinue became false, set to IDLE.
            console.log(`[handleClarificationLoop] Setting user ${userId} to IDLE as conversationShouldContinue is false and current step is ${finalStateCheck.conversationState.currentStep}`);
            await recruitmentCollection.updateOne({ userId: userId }, { $set: { "conversationState.currentStep": ConversationStep.IDLE, "conversationState.activeCollectorType": null } });
        }
      }
      break;
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
