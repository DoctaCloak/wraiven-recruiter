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
    PROCESSING_INITIAL_RESPONSE: 'PROCESSING_INITIAL_RESPONSE',
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
export async function ensureCategory(guild, categoryName) {
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
    const channelName = `processing-${member.user.username.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 25) || 'user'}`;
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
export function buildProcessingChannelPermissions(member, guild) {
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
    console.log(`[RecruiterApp] Rejoining user: ${member.user.tag}`);
    const guild = member.guild;
    const messageHistoryCollection = member.client.db.collection("messageHistory"); // Assuming client.db is set up

    // 1. Reassign old roles (if any and still exist)
    if (userData.roles && Array.isArray(userData.roles)) {
        for (const roleName of userData.roles) {
            const role = guild.roles.cache.find(r => r.name === roleName);
            if (role && !member.roles.cache.has(role.id)) {
                try {
                    await member.roles.add(role);
                    console.log(`Re-assigned role "${roleName}" to ${member.user.tag}.`);
                } catch (roleError) {
                    console.error(`Failed to re-assign role "${roleName}" to ${member.user.tag}:`, roleError);
                }
            }
        }
    }

    // 2. Ensure their processing channel (it might have been deleted)
    const channel = await ensureUserProcessingChannel(
        member,
        userData.channelId, // Pass existing channel ID
        recruitmentCollection
    );

    if (!channel) {
        console.error(
            `[RecruiterApp] Failed to ensure processing channel for rejoining user ${member.user.tag}.`
        );
        // Might send a DM if possible, or notify staff
        try {
            await member.send("Welcome back! I had trouble setting up your private channel. Please contact a staff member.");
        } catch (dmError) {
            console.error("Failed to DM rejoining user about channel issue:", dmError);
        }
        return;
    }
     // Fetch updated user data to get channelId if it was just created or confirmed
    const updatedUserDataForChannel = await recruitmentCollection.findOne({ userId: member.id });
    const currentChannelId = updatedUserDataForChannel?.channelId || channel.id;

    // 3. Send welcome back message
    let conversationHistoryForLLM = [];
    try {
        const welcomeBackMsg = `Welcome back to ${GUILD_NAME}, **${member.user.username}**! It looks like you were here before. How can I help you today?`;
        const sentMsg = await channel.send(welcomeBackMsg);
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.id, currentChannelId, welcomeBackMsg, sentMsg.id);
        conversationHistoryForLLM.push({ role: "assistant", content: welcomeBackMsg });

        // Set initial conversation state for rejoining user to listen for their response
        const rejoiningState = {
            currentStep: ConversationStep.AWAITING_INITIAL_USER_MESSAGE, // Or GENERAL_LISTENING if we expect them to take initiative
            activeCollectorType: 'INITIAL_USER_RESPONSE', // Or 'GENERAL'
            stepEntryTimestamp: new Date(),
            timeoutTimestamp: new Date(Date.now() + INITIAL_USER_RESPONSE_TIMEOUT_MS), // Give them time to respond
            lastLlmIntent: null,
            lastDiscordMessageIdProcessed: null,
            attemptCount: 0
        };
        await recruitmentCollection.updateOne({ userId: member.id }, { $set: { conversationState: rejoiningState, lastActivityAt: new Date() } });

    } catch (error) {
        console.error(`[RecruiterApp] Error sending welcome back message to ${member.user.tag}:`, error);
        return;
    }

    // 4. Listen for their response (similar to new user, but using existing history)
    const filter = (m) => m.author.id === member.id && m.channel.id === currentChannelId;
    const rejoiningMsgCollector = channel.createMessageCollector({
        filter,
        max: 1,
        time: INITIAL_USER_RESPONSE_TIMEOUT_MS, 
    });

    rejoiningMsgCollector.on("collect", async (message) => {
        console.log(`[RecruiterApp] Collected message from rejoining user ${member.user.tag}: "${message.content}"`);
        
        // Update state to PROCESSING_INITIAL_RESPONSE for rejoining user as well
        try {
            const processingStateUpdate = {
                "conversationState.currentStep": ConversationStep.PROCESSING_INITIAL_RESPONSE,
                "conversationState.lastDiscordMessageIdProcessed": message.id,
                "conversationState.stepEntryTimestamp": new Date(),
                "conversationState.activeCollectorType": null,
                "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS * 2), 
            };
            await recruitmentCollection.updateOne({ userId: member.id }, { $set: processingStateUpdate });
            console.log(`[RecruiterApp] DB updated for rejoining ${member.user.tag}: step = PROCESSING_INITIAL_RESPONSE, msgID = ${message.id}`);
        } catch (dbError) {
            console.error(`[RecruiterApp] CRITICAL: Failed to update rejoining user state to PROCESSING_INITIAL_RESPONSE for ${member.user.tag}, msg ${message.id}:`, dbError);
        }


        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.id, currentChannelId, message.content, message.id);
        conversationHistoryForLLM.push({ role: "user", content: message.content });
        
        // Fetch more complete history for rejoining user for LLM context
        try {
            const allUserHistoryEntries = await messageHistoryCollection.find(
                { userId: member.id, channelId: currentChannelId }
            ).sort({ timestamp: 1 }).toArray();
            
            const fullHistoryForLLM = allUserHistoryEntries.map(entry => ({
                role: entry.author === 'user' ? 'user' : 'assistant',
                content: entry.messageContent
            }));
            // The latest user message is already pushed, ensure no duplicates if history fetch overlaps
            // For simplicity, LLM can handle slight repetition if it occurs.
            conversationHistoryForLLM = fullHistoryForLLM; // Replace current with full

        } catch (dbHistError) {
            console.error("[RecruiterApp] Error fetching full history for rejoining user:", dbHistError);
            // Proceed with the limited history (welcome + current message)
        }


        const llmResponse = await processUserMessageWithLLM(
            message.content,
            conversationHistoryForLLM,
            member.user.username,
            member.id
        );
        console.log("[RecruiterApp] LLM Response for rejoining user:", JSON.stringify(llmResponse, null, 2));

        await handleClarificationLoop(
            member,
            channel,
            llmResponse,
            conversationHistoryForLLM,
            recruitmentCollection,
            messageHistoryCollection,
            guild,
            0, 
            message.id // Pass user message ID
        );
    });

    rejoiningMsgCollector.on("end", async (collected, reason) => {
        if (reason === "time" && collected.size === 0) {
            console.log(`[RecruiterApp] Rejoining user ${member.user.tag} did not respond.`);
            await recruitmentCollection.updateOne(
                { userId: member.id },
                { $set: { 
                    "conversationState.currentStep": ConversationStep.IDLE, 
                    "conversationState.activeCollectorType": null, 
                    "conversationState.timeoutTimestamp": null,
                    communityStatus: "TIMED_OUT_REJOIN_RESPONSE"
                 } }
            );
            if (channel && !channel.deleted) {
                try {
                    await channel.send(
                        "Looks like you stepped away. Feel free to message again when you're back!"
                    );
                } catch (sendError) { console.error("Failed to send timeout to rejoining user:", sendError);}
            }
        }
    });
}

/**
 * Processes a new user joining the server:
 * - Sets up their initial database record.
 * - Assigns an "outsider" role.
 * - Creates their private processing channel.
 * - Sends welcome messages and collects their first response.
 * - Hands off to the LLM and clarification loop.
 */
async function processNewUser(member, database) {
  console.log(`[RecruiterApp] New user: ${member.user.tag}`);
  const recruitmentCollection = database.collection("recruitment");
  const messageHistoryCollection = database.collection("messageHistory"); // For logging conversation

  // Initialize user data if not exists
  const now = new Date();
  const initialUserData = {
    userId: member.id,
    username: member.user.username,
    discriminator: member.user.discriminator,
    guildId: member.guild.id,
    joinTimestamp: now,
    roles: [OUTSIDER_ROLE_NAME],
    accessStatus: ACCESS_STATUS.PENDING, // Default to pending access
    communityStatus: COMMUNITY_STATUS.PENDING,
    applicationStatus: "NOT_STARTED",
    channelId: null,
    ticketChannelId: null,
    messageHistory: [], // Deprecated, use messageHistoryCollection
    conversationState: {
      currentStep: ConversationStep.IDLE, // Will be updated before collector
      activeCollectorType: null,
      stepEntryTimestamp: now,
      timeoutTimestamp: null,
      attemptCount: 0,
      lastLlmIntent: null,
      lastDiscordMessageIdProcessed: null, // New field
      applicationQuestionIndex: 0, // Initialize for potential application
      applicationAnswers: {}, // Initialize for potential application
    },
    notes: [],
  };

  await recruitmentCollection.updateOne(
    { userId: member.id },
    { $setOnInsert: initialUserData },
    { upsert: true }
  );
  console.log(`[RecruiterApp] Upserted initial data for ${member.user.tag}.`);


  // 1. Ensure they have an "outsider" role initially.
  const outsiderRole = member.guild.roles.cache.find(
    (role) => role.name === OUTSIDER_ROLE_NAME
  );
  if (outsiderRole && !member.roles.cache.has(outsiderRole.id)) {
    try {
      await member.roles.add(outsiderRole);
      console.log(`Assigned OUTSIDER role to ${member.user.tag}.`);
    } catch (roleError) {
      console.error(`Failed to assign OUTSIDER role to ${member.user.tag}:`, roleError);
    }
  }


  // 2. Create or ensure their personal processing channel
  const channel = await ensureUserProcessingChannel(
    member,
    null,
    recruitmentCollection
  ); // Pass null channelId for new user
  if (!channel) {
    console.error(
      `[RecruiterApp] Failed to create/ensure processing channel for ${member.user.tag}. Aborting new user processing.`
    );
    return; // Cannot proceed without a channel
  }
  // Fetch updated user data to get channelId if it was just created
  const updatedUserDataAfterChannelCreation = await recruitmentCollection.findOne({ userId: member.id });
  const currentChannelId = updatedUserDataAfterChannelCreation?.channelId || channel.id;


  // 3. Send initial welcome messages
  let conversationHistoryForLLM = [];
  try {
    const welcomeMsg1 = `Hello, **${member.user.username}**, welcome to ${GUILD_NAME}!`;
    const sentWelcomeMsg1 = await channel.send(welcomeMsg1);
    await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, currentChannelId, welcomeMsg1, sentWelcomeMsg1.id);
    conversationHistoryForLLM.push({ role: "assistant", content: welcomeMsg1 });

    const welcomeMsg2 = `What is your purpose for joining the ${GUILD_NAME} Discord channel?`;
    const sentWelcomeMsg2 = await channel.send(welcomeMsg2);
    await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, currentChannelId, welcomeMsg2, sentWelcomeMsg2.id);
    conversationHistoryForLLM.push({ role: "assistant", content: welcomeMsg2 });
  } catch (error) {
    console.error(`[RecruiterApp] Error sending welcome messages to ${member.user.tag}:`, error);
    if (channel && !channel.deleted) {
        try {
            await channel.send("Sorry, I encountered an error trying to send my welcome message. Please try sending a message here, and I'll do my best to assist.");
        } catch (fallbackError) {
            console.error("Failed to send fallback message:", fallbackError);
        }
    }
    return; // Critical failure
  }

  // Update conversation state before starting collector
  try {
    await recruitmentCollection.updateOne(
      { userId: member.id },
      {
        $set: {
          "conversationState.currentStep": ConversationStep.AWAITING_INITIAL_USER_MESSAGE,
          "conversationState.activeCollectorType": 'INITIAL_USER_RESPONSE',
          "conversationState.stepEntryTimestamp": new Date(),
          "conversationState.timeoutTimestamp": new Date(Date.now() + INITIAL_USER_RESPONSE_TIMEOUT_MS),
          "conversationState.lastDiscordMessageIdProcessed": null, // Ensure it's null before user responds
        }
      }
    );
    console.log(`[RecruiterApp] DB updated for ${member.user.tag}: step = AWAITING_INITIAL_USER_MESSAGE`);
  } catch (dbError) {
      console.error(`[RecruiterApp] CRITICAL: Failed to set AWAITING_INITIAL_USER_MESSAGE state for ${member.user.tag}:`, dbError);
      // Potentially notify staff or send a generic error to user if channel exists
      return;
  }


  // 4. Collect the user's first message
  const filter = (m) => m.author.id === member.id && m.channel.id === currentChannelId;
  const initialMsgCollector = channel.createMessageCollector({
    filter,
    max: 1,
    time: INITIAL_USER_RESPONSE_TIMEOUT_MS, // Use configured timeout
  });

  initialMsgCollector.on("collect", async (message) => {
    console.log(`[RecruiterApp] Collected first message from ${member.user.tag}: "${message.content}"`);
    
    try {
        const processingStateUpdate = {
            "conversationState.currentStep": ConversationStep.PROCESSING_INITIAL_RESPONSE,
            "conversationState.lastDiscordMessageIdProcessed": message.id,
            "conversationState.stepEntryTimestamp": new Date(),
            "conversationState.activeCollectorType": null, 
            "conversationState.timeoutTimestamp": new Date(Date.now() + GENERAL_CLARIFICATION_TIMEOUT_MS * 2),
        };
        await recruitmentCollection.updateOne({ userId: member.id }, { $set: processingStateUpdate });
        console.log(`[RecruiterApp] DB updated for ${member.user.tag}: step = PROCESSING_INITIAL_RESPONSE, lastDiscordMessageIdProcessed = ${message.id}`);
    } catch (dbError) {
        console.error(`[RecruiterApp] CRITICAL: Failed to update state to PROCESSING_INITIAL_RESPONSE for ${member.user.tag}, message ${message.id}:`, dbError);
        // Attempt to recover by setting to IDLE if this critical update fails, to avoid getting stuck.
        await recruitmentCollection.updateOne(
            { userId: member.id }, 
            { $set: { 
                "conversationState.currentStep": ConversationStep.IDLE,
                "conversationState.activeCollectorType": null,
                "conversationState.lastDiscordMessageIdProcessed": message.id, // still note that we saw this message
                "conversationState.lastLlmIntent": "ERROR_SETTING_PROCESSING_STEP",
            } }
        ).catch(finalDbError => console.error("[RecruiterApp] Failed to set IDLE state after failing to set PROCESSING_INITIAL_RESPONSE:", finalDbError));
        // Don't return here, let the rest of the try block attempt to run, but state might be inconsistent.
    }

    try { // New try-catch for LLM and handleClarificationLoop
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, member.user.id, currentChannelId, message.content, message.id);
        conversationHistoryForLLM.push({ role: "user", content: message.content });

        const firstLlmResponse = await processUserMessageWithLLM(
          message.content,
          conversationHistoryForLLM, 
          member.user.username,
          member.id
        );
        console.log("[RecruiterApp] First LLM Response Received:", JSON.stringify(firstLlmResponse, null, 2));

        const historyForLoopStart = [...conversationHistoryForLLM];

        await handleClarificationLoop(
            member,
            channel,
            firstLlmResponse,
            historyForLoopStart,
            recruitmentCollection,
            messageHistoryCollection,
            member.guild,
            0, 
            message.id 
        );
    } catch (error) {
        console.error(`[RecruiterApp] Error during initial LLM processing or handleClarificationLoop for ${member.user.tag}:`, error);
        await notifyStaff(member.guild, `Critical error during initial processing for ${member.user.tag} in channel <#${currentChannelId}>. User may be stuck. Error: ${error.message}`, "INITIAL_PROCESSING_ERROR").catch(console.error);
        try {
            if (channel && !channel.deleted) {
                await channel.send("I encountered an unexpected issue while processing your first message. Please try sending another message, or a staff member will be notified to assist.").catch(console.error);
            }
        } catch (e) {console.error("Failed to send error message to user channel", e);}
        // Attempt to reset state to IDLE to allow onMessageCreate to pick up next message
        await recruitmentCollection.updateOne(
            { userId: member.id }, 
            { $set: { 
                "conversationState.currentStep": ConversationStep.IDLE,
                "conversationState.activeCollectorType": null,
                // lastDiscordMessageIdProcessed is already set to this message.id
                "conversationState.lastLlmIntent": "ERROR_DURING_INITIAL_HCL",
                "conversationState.timeoutTimestamp": null,
                "conversationState.attemptCount": 0
            } }
        ).catch(dbUpdateError => {
            console.error(`[RecruiterApp] Failed to update state to IDLE after error for ${member.user.tag}:`, dbUpdateError);
        });
    }
  });

  initialMsgCollector.on("end", async (collected, reason) => {
    // Check if the reason is 'time' AND no messages were collected during the initial period 
    // AND the current step is still AWAITING_INITIAL_USER_MESSAGE (meaning our collector timed out before any message came in)
    const userData = await recruitmentCollection.findOne({ userId: member.id });
    if (reason === "time" && collected.size === 0 && userData?.conversationState?.currentStep === ConversationStep.AWAITING_INITIAL_USER_MESSAGE) {
      console.log(`[RecruiterApp] User ${member.user.tag} did not respond within the initial timeout.`);
      // Update database state
      await recruitmentCollection.updateOne(
        { userId: member.id },
        { $set: { 
            "conversationState.currentStep": ConversationStep.IDLE,
            "conversationState.activeCollectorType": null,
            "conversationState.timeoutTimestamp": null,
            communityStatus: "TIMED_OUT_INITIAL_RESPONSE" 
        }}
      );
      if (channel && !channel.deleted) {
        try {
          await channel.send(
            "It looks like you haven't responded. If you need help or want to start over, feel free to send a message here. This channel will remain open for a while."
          );
        } catch (sendError) {
            console.error("Error sending timeout message to user processing channel:", sendError);
        }
        // Optionally, you might schedule a deletion or archiving of this channel later.
      }
    }
  });
}

// Define logBotMsgToHistory as an exportable function
export async function logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, msgContent, discordMessageId = null, llmRespObj = null) {
  const logEntry = {
    userId,
    channelId,
    messageContent: msgContent,
    timestamp: new Date(),
    author: "bot", // 'bot' or 'user'
    discordMessageId: discordMessageId, // Store the Discord message ID if available
    llmResponseDetails: llmRespObj ? { // Store LLM details if this bot message was based on an LLM response
        intent: llmRespObj.intent,
        entities: llmRespObj.entities,
        requires_clarification: llmRespObj.requires_clarification,
        vouch_person_name: llmRespObj.vouch_person_name,
        // DO NOT log suggested_bot_response here, as that IS msgContent for bot messages. Avoids duplication.
    } : null,
  };
  try {
    await messageHistoryCollection.insertOne(logEntry);
    // console.log(`[History] Logged bot message for ${userId} in ${channelId}. DiscordMsgID: ${discordMessageId}`);
  } catch (error) {
    console.error("Error logging bot message to history:", error);
  }
}


export async function handleClarificationLoop(
  member,
  channel,
  currentLlmResponse, 
  conversationHistoryForLLM, 
  recruitmentCollection,
  messageHistoryCollection,
  guild,
  attemptCount = 0,
  currentUserMessageId = null // ID of the user message being responded to
) {
  const userId = member.id;
  const channelId = channel.id;
  let conversationShouldContinue = true; // Flag to control if a new listener should be set up.
  let nextCollectorType = null; // To determine what kind of collector to set up.
  let nextStepTimeout = GENERAL_CLARIFICATION_TIMEOUT_MS; // Default timeout
  let finalLlmResponseForThisTurn = currentLlmResponse; // The LLM response we are acting upon in this iteration

  console.log(`[ClarifyLoop-${userId}] Entered. Attempt: ${attemptCount}. Current LLM Intent: ${currentLlmResponse?.intent}, Requires Clarification: ${currentLlmResponse?.requires_clarification}. UserMsgID: ${currentUserMessageId}`);

  // Update lastDiscordMessageIdProcessed with the user message we are currently handling (if available)
  // This is crucial for onMessageCreate to avoid race conditions if the bot restarts during processing,
  // or if this loop is entered from onMessageCreate itself.
  if (currentUserMessageId) {
      try {
          // Fetch current state to avoid overwriting other ongoing updates if necessary,
          // though for lastDiscordMessageIdProcessed, direct set is usually fine.
          await recruitmentCollection.updateOne(
              { userId },
              { $set: { 
                  "conversationState.lastDiscordMessageIdProcessed": currentUserMessageId,
                  // If we are processing a user message, then we are not IDLE, so ensure step reflects activity.
                  // The actual step (e.g., AWAITING_CLARIFICATION, GENERAL_LISTENING) will be set later in this function.
                  // For now, just ensure it is not IDLE if we are processing a message.
                  // However, a simple update to lastDiscordMessageIdProcessed is safest to avoid complex conditional logic here.
                } 
              }
          );
          console.log(`[ClarifyLoop-${userId}] Updated lastDiscordMessageIdProcessed to ${currentUserMessageId}`);
      } catch (dbError) {
          console.error(`[ClarifyLoop-${userId}] CRITICAL: Failed to update lastDiscordMessageIdProcessed for user message ${currentUserMessageId}:`, dbError);
          // Depending on severity, might want to stop or notify.
      }
  }


  // --- 1. Send Bot's Response (LLM suggested, Q&A, or fallback) & Log it ---
  let botResponseMessageContent = "I'm not sure how to respond to that. Could you try rephrasing?"; // Default fallback
  if (finalLlmResponseForThisTurn && finalLlmResponseForThisTurn.suggested_bot_response) {
    try {
      const sentMsg = await channel.send(finalLlmResponseForThisTurn.suggested_bot_response);
      await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, finalLlmResponseForThisTurn.suggested_bot_response, sentMsg.id, finalLlmResponseForThisTurn);
      conversationHistoryForLLM.push({ role: "assistant", content: finalLlmResponseForThisTurn.suggested_bot_response });
      console.log(`[handleClarificationLoop] Sent and logged LLM response for ${userId}. History length now ${conversationHistoryForLLM.length}`);
    } catch (sendError) {
      console.error(`[handleClarificationLoop] Error sending LLM suggested response for ${userId}:`, sendError);
      await notifyStaff(guild, `Error sending LLM response for ${member.user.tag} in handleClarificationLoop. Error: ${sendError.message}`, "LLM_SEND_ERROR_HCL").catch(console.error);
    }
  } else if (!finalLlmResponseForThisTurn || finalLlmResponseForThisTurn.error) {
    const fallbackMsg = "I'm having a little trouble with my thoughts right now. Could you try rephrasing, or I can get a staff member to help?";
    if (!finalLlmResponseForThisTurn?.error?.includes("NO_API_KEY")) {
      try {
        const sentMsg = await channel.send(fallbackMsg);
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, fallbackMsg, sentMsg.id, finalLlmResponseForThisTurn);
        conversationHistoryForLLM.push({ role: "assistant", content: fallbackMsg });
        console.log(`[handleClarificationLoop] Sent and logged fallback/error response for ${userId}. History length now ${conversationHistoryForLLM.length}`);
        if (finalLlmResponseForThisTurn?.error) {
          await notifyStaff(guild, `LLM Error for ${member.user.tag} in handleClarificationLoop: ${finalLlmResponseForThisTurn.error}.`, "LLM_ERROR_HCL").catch(console.error);
        }
        if (!finalLlmResponseForThisTurn) finalLlmResponseForThisTurn = {}; 
        finalLlmResponseForThisTurn.requires_clarification = true; 
        finalLlmResponseForThisTurn.intent = "UNCLEAR_INTENT";
      } catch (sendError) {
        console.error(`[handleClarificationLoop] Error sending fallback message for ${userId}:`, sendError);
      }
    }
    // Ensure history and logging occurs even if send fails or is skipped (e.g. NO_API_KEY)
    // Avoid logging the same message twice if already logged in the try block.
    if (!conversationHistoryForLLM.find(m => m.role === 'assistant' && m.content === fallbackMsg)){
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, fallbackMsg, null, finalLlmResponseForThisTurn);
        conversationHistoryForLLM.push({ role: "assistant", content: fallbackMsg });
        console.log(`[handleClarificationLoop] Logged fallback/error response (send might have been skipped) for ${userId}.`);
    }
    
    if (finalLlmResponseForThisTurn?.error && !finalLlmResponseForThisTurn.error.includes("NO_API_KEY")) {
      // Already notified staff inside the try block if error was present and not NO_API_KEY
    } else if (finalLlmResponseForThisTurn?.error?.includes("NO_API_KEY")) {
        // Log or handle NO_API_KEY specifically if needed, but don't notify staff repeatedly for it.
        console.warn(`[handleClarificationLoop] LLM processing skipped due to missing API key for user ${userId}.`);
    }

    if (!finalLlmResponseForThisTurn) finalLlmResponseForThisTurn = { error: 'Unknown error, no LLM response object' }; 
    finalLlmResponseForThisTurn.requires_clarification = true; 
    finalLlmResponseForThisTurn.intent = "UNCLEAR_INTENT";
  }

  // 2. Determine Next State, Collector Type, and Timeout based on LLM response
  const requiresClarification = finalLlmResponseForThisTurn?.requires_clarification || false;
  const currentIntent = finalLlmResponseForThisTurn?.intent || "UNKNOWN_INTENT";
  let nextStep = ConversationStep.GENERAL_LISTENING; // Default next step
  // nextCollectorType is already declared at the top of the function scope
  // nextStepTimeout is already declared at the top of the function scope
  
  if (currentIntent === "GUILD_APPLICATION_INTEREST" && !requiresClarification) {
    // If GUILD_APPLICATION_INTEREST is clear, we offer a button, then go to general listening in the processing channel.
    // The actual application happens in a new ticket channel.
    nextStep = ConversationStep.GENERAL_LISTENING;
    nextCollectorType = 'GENERAL'; 
    nextStepTimeout = GENERAL_CLARIFICATION_TIMEOUT_MS * 3; // Longer timeout for general listening
  } else if (requiresClarification) {
    nextStep = ConversationStep.AWAITING_CLARIFICATION;
    nextCollectorType = 'CLARIFICATION';
    nextStepTimeout = GENERAL_CLARIFICATION_TIMEOUT_MS;
  } else {
    // If no clarification is needed, determine the next step based on the confirmed intent.
    switch (currentIntent) {
      case "COMMUNITY_INTEREST_VOUCH":
        if (finalLlmResponseForThisTurn.vouch_person_name) {
          // Vouch person identified, vouch process will take over.
          nextStep = ConversationStep.IDLE; // Or VOUCH_PROCESS_ACTIVE, but initiateVouchProcess handles its own state
          nextCollectorType = null;
          nextStepTimeout = null;
          conversationShouldContinue = false; // Vouch process is terminal for this loop's collector
        } else {
          // Vouch mentioned, but name is unclear (this case should ideally be caught by requiresClarification=true)
          // If LLM somehow says clarification=false but vouch_person_name is null, ask for mention.
          nextStep = ConversationStep.AWAITING_VOUCH_MENTION;
          nextCollectorType = 'VOUCH_MENTION';
          nextStepTimeout = VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS;
        }
        break;
      case "END_CONVERSATION":
      case "USER_REQUESTED_STAFF": // Staff request means this interaction loop is done, staff will take over.
        nextStep = ConversationStep.IDLE;
        nextCollectorType = null;
        nextStepTimeout = null;
        conversationShouldContinue = false;
        break;
      // Add other non-clarification intents that are terminal or lead to specific non-general listeners here
      default: // For any other clear intent, go to general listening.
        nextStep = ConversationStep.GENERAL_LISTENING;
        nextCollectorType = 'GENERAL';
        nextStepTimeout = GENERAL_CLARIFICATION_TIMEOUT_MS * 3;
        break;
    }
  }
  
  // Update Database with the new conversation state
  // Consolidate all state updates related to the next step here.
  const newConversationState = {
      currentStep: nextStep,
      stepEntryTimestamp: new Date(),
      timeoutTimestamp: nextCollectorType && nextStepTimeout ? new Date(Date.now() + nextStepTimeout) : null,
      activeCollectorType: nextCollectorType,
      // Increment attemptCount only if we are moving TO AWAITING_CLARIFICATION or AWAITING_VOUCH_MENTION
      attemptCount: (nextStep === ConversationStep.AWAITING_CLARIFICATION || nextStep === ConversationStep.AWAITING_VOUCH_MENTION) ? attemptCount : 0, 
      lastLlmIntent: currentIntent,
      // applicationQuestionIndex and applicationAnswers are handled specifically within GUILD_APPLICATION_INTEREST logic below.
      // Do not reset them generically here unless appropriate for the determined nextStep.
  };
  // Preserve application progress if not explicitly ended or reset by current logic path.
  if (nextStep !== ConversationStep.AWAITING_APPLICATION_ANSWER && 
      currentIntent !== "GUILD_APPLICATION_INTEREST_CONCLUDE" && 
      currentIntent !== "GUILD_APPLICATION_CANCEL") {
      // If not actively in Q&A or concluding/cancelling it, don't wipe these fields by omitting them.
      // This means if they were set, they persist. If they were null, they remain null.
  } else if (nextStep === ConversationStep.AWAITING_APPLICATION_ANSWER) {
    // applicationQuestionIndex should be managed by the Q&A logic itself.
  } else {
    // If moving to IDLE from an application context, or other reset scenarios, clear them.
    newConversationState.applicationQuestionIndex = 0;
    newConversationState.applicationAnswers = {};
  }


  try {
      const updatePayload = { $set: { lastActivityAt: new Date() } };
      // Selectively apply conversationState fields to avoid overwriting parts managed by other processes (like ticket creation)
      for (const key in newConversationState) {
          if (newConversationState[key] !== undefined) { // only set if defined, to allow partial updates if needed in future
              updatePayload.$set[`conversationState.${key}`] = newConversationState[key];
          }
      }
      // If the loop determines conversation is over and channel should be idle, clear last processed message ID.
      if (nextStep === ConversationStep.IDLE && !conversationShouldContinue) {
        updatePayload.$set["conversationState.lastDiscordMessageIdProcessed"] = null;
      }

      await recruitmentCollection.updateOne({ userId: userId }, updatePayload);
      console.log(`[handleClarificationLoop] Updated DB state for ${userId} to: Step=${nextStep}, Collector=${nextCollectorType}, Intent=${currentIntent}, Attempts=${newConversationState.attemptCount}`);
  } catch (dbError) {
      console.error(`[handleClarificationLoop] Failed to update conversationState in DB for ${userId}`, dbError);
      // Not returning, as we might still be able to set up a collector or proceed.
  }

  // 3. Main logic based on LLM intent and clarification status
  console.log(`[handleClarificationLoop] Processing intent: ${currentIntent} for ${userId}, Requires Clarification: ${requiresClarification}, Next Step: ${nextStep}, Attempt Count: ${attemptCount}`);

  // Check for Max Clarification Attempts FIRST
  if (nextStep === ConversationStep.AWAITING_CLARIFICATION && attemptCount >= MAX_CLARIFICATION_ATTEMPTS) {
    console.log(`[handleClarificationLoop] Max clarification attempts reached for ${userId}.`);
    const staffMessage = `User ${member.user.tag} (channel: <#${channel.id}>) reached max clarification attempts. Last intent was '${currentIntent}'. Please assist.`;
    await notifyStaff(guild, staffMessage, "MAX_CLARIFICATION_REACHED");
    try {
        const sentStaffNotifMsg = await channel.send("I'm still having trouble understanding. I've notified a staff member to come and help you out!");
        await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, sentStaffNotifMsg.content, sentStaffNotifMsg.id, finalLlmResponseForThisTurn);
        // conversationHistoryForLLM.push({ role: "assistant", content: sentStaffNotifMsg.content }); // Already logged by logBotMsgToHistory
        // Set state to IDLE as staff will take over.
        await recruitmentCollection.updateOne({ userId: userId }, { $set: { 
            "conversationState.currentStep": ConversationStep.IDLE, 
            "conversationState.activeCollectorType": null, 
            "conversationState.timeoutTimestamp": null,
            "conversationState.lastDiscordMessageIdProcessed": null // Staff taking over, clear last processed ID
        } });
    } catch (sendError) { console.error("Failed to send max attempts message or log it", sendError); }
    return; // End of loop for this user interaction.
  }

  // Main switch for intents - This runs if not maxed out on clarification, or if clarification not needed.
  switch (currentIntent) {
    case "UNCLEAR_INTENT": 
    case "GENERAL_QUESTION":
    case "USER_PROVIDED_INFORMATION": // Generic information provided by user
      if (nextStep === ConversationStep.AWAITING_CLARIFICATION) {
        console.log(`[handleClarificationLoop] Setting up CLARIFICATION collector for ${userId}. Attempt ${attemptCount + 1}`);
        // Message asking for clarification was already sent at the top of this function.
        const clarificationCollector = channel.createMessageCollector({
          filter: (m) => m.author.id === userId && m.channel.id === channelId,
          time: nextStepTimeout, 
          max: 1,
        });

        clarificationCollector.on("collect", async (m) => {
          console.log(`[ClarificationCollector] Collected: "${m.content}" from ${userId} in channel ${m.channel.name}`);
          await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, m.content, m.id); // Log user message
          conversationHistoryForLLM.push({ role: "user", content: m.content });

          const followUpLlmResponse = await processUserMessageWithLLM(m.content, conversationHistoryForLLM, member.user.username, userId);
          await handleClarificationLoop(member, channel, followUpLlmResponse, conversationHistoryForLLM, recruitmentCollection, messageHistoryCollection, guild, attemptCount + 1, m.id);
        });

        clarificationCollector.on("end", async (collected, reason) => {
          const latestUserData = await recruitmentCollection.findOne({ userId: userId });
          if (reason === "time" && collected.size === 0 && latestUserData?.conversationState?.activeCollectorType === 'CLARIFICATION') { 
            console.log(`[ClarificationCollector] Timed out for ${userId}.`);
            try {
                const timeoutMsgContent = "It looks like you've been quiet for a bit. If you're still there and need help, just send a message! Otherwise, this channel might be archived later.";
                const sentTimeoutMsg = await channel.send(timeoutMsgContent);
                await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, timeoutMsgContent, sentTimeoutMsg.id, null); 
                await recruitmentCollection.updateOne({ userId: userId }, { $set: { 
                    "conversationState.currentStep": ConversationStep.IDLE, 
                    "conversationState.activeCollectorType": null, 
                    "conversationState.timeoutTimestamp": null,
                    "conversationState.lastDiscordMessageIdProcessed": null // Timed out, clear last processed ID
                 } });
            } catch (sendError) { console.error("Failed to send clarification timeout message", sendError); }
          }
        });
      } else if (nextStep === ConversationStep.GENERAL_LISTENING && conversationShouldContinue) {
        console.log(`[handleClarificationLoop] Setting up GENERAL_LISTENING collector for ${userId} due to intent: ${currentIntent}.`);
        const generalListenerCollector = channel.createMessageCollector({
          filter: (m) => m.author.id === userId && m.channel.id === channelId,
          time: nextStepTimeout, // Use the determined timeout for general listening
          // No max: 1, listen until timeout or explicit stop for general conversation
        });

        generalListenerCollector.on("collect", async (m) => {
          console.log(`[GeneralListenerCollector] Collected: "${m.content}" from ${userId} in ${m.channel.name}`);
          generalListenerCollector.stop("newMessage"); // Stop this collector, new one will be made by HCL recursion
          
          await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, m.content, m.id);
          conversationHistoryForLLM.push({ role: "user", content: m.content });

          const followUpLlmResponse = await processUserMessageWithLLM(m.content, conversationHistoryForLLM, member.user.username, userId);
          await handleClarificationLoop(member, channel, followUpLlmResponse, conversationHistoryForLLM, recruitmentCollection, messageHistoryCollection, guild, 0, m.id); // Reset attemptCount for new general interaction
        });

        generalListenerCollector.on("end", async (collected, reason) => {
          const latestUserData = await recruitmentCollection.findOne({ userId: userId });
          if (reason === "time" && collected.size === 0 && latestUserData?.conversationState?.activeCollectorType === 'GENERAL') { 
            console.log(`[GeneralListenerCollector] Timed out for ${userId}.`);
            await recruitmentCollection.updateOne({ userId: userId }, { $set: { 
                "conversationState.currentStep": ConversationStep.IDLE, 
                "conversationState.activeCollectorType": null, 
                "conversationState.timeoutTimestamp": null,
                "conversationState.lastDiscordMessageIdProcessed": null 
            } });
          }
        });
      } else if (!conversationShouldContinue) {
          console.log(`[handleClarificationLoop] Conversation for ${userId} (intent: ${currentIntent}) concluded or handed off. No new collector from default case.`);
      }
      break;

    case "GUILD_APPLICATION_INTEREST":
      console.log(`[handleClarificationLoop] Intent: GUILD_APPLICATION_INTEREST for ${userId}.`);
      // The bot's response (LLM suggestion or fallback) was already sent at the top of the function.
      // Now, send the button to open a recruitment ticket.
      const ticketButton = new ButtonBuilder()
        .setCustomId('open_recruitment_ticket')
        .setLabel('📝 Open Recruitment Ticket')
        .setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(ticketButton);
      
      // The LLM response for this intent might already include a call to action.
      // We append the button for a clear action.
      const buttonMessageText = "If you'd like to formally apply to Wraiven, please click the button below. This will open a dedicated recruitment ticket for you.";
      
      try {
          const sentButtonMsg = await channel.send({ content: buttonMessageText, components: [row] });
          // Log this specific bot action (sending the button) separately from the LLM's general response if needed,
          // or consider the LLM response + this button as one interaction block.
          await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, buttonMessageText, sentButtonMsg.id, null); // No direct LLM obj for this part
          // conversationHistoryForLLM.push({ role: "assistant", content: buttonMessageText }); // Log if needed
          
          // State is already set to GENERAL_LISTENING by the logic block at the top.
          // This allows the user to either click the button OR say something else in the processing channel.
          console.log(`[handleClarificationLoop] Sent 'Open Recruitment Ticket' button to ${userId}. State set for general listening.`);
          
          // No new collector is set up here by the GUILD_APPLICATION_INTEREST case itself.
          // The GENERAL_LISTENING collector (if nextStep determined it) will be set up after the switch.

      } catch (error) {
          console.error(`[handleClarificationLoop] Error sending 'Open Recruitment Ticket' button for ${userId}:`, error);
          await notifyStaff(guild, `Failed to send 'Open Ticket' button to ${member.user.tag}. Error: ${error.message}`, "BUTTON_SEND_ERROR_HCL").catch(console.error);
          // Fallback to general listening if button send fails, error message already sent by LLM response block
      }
      // After offering the button, the bot goes into general listening in the *current* channel.
      // The `onInteractionCreate` handler will manage the ticket creation and subsequent state changes.
      // So, `conversationShouldContinue` remains true, and the general listener setup (if applicable based on nextStep) will occur.
      break;

    case "COMMUNITY_INTEREST_VOUCH":
      console.log(`[handleClarificationLoop] Intent: COMMUNITY_INTEREST_VOUCH for ${userId}.`);
      if (finalLlmResponseForThisTurn.vouch_person_name && !requiresClarification) {
        console.log(`[handleClarificationLoop] Vouch target: ${finalLlmResponseForThisTurn.vouch_person_name}. Initiating vouch process.`);
        await initiateVouchProcess(member, channel, finalLlmResponseForThisTurn.vouch_person_name, recruitmentCollection, messageHistoryCollection, guild);
        // initiateVouchProcess handles its own state. conversationShouldContinue is already false for this path.
      } else {
        // Vouch mentioned, but name is unclear (requires_clarification should be true from LLM, or nextStep is AWAITING_VOUCH_MENTION)
        // Bot should have sent a message asking for @mention (from LLM's suggested_bot_response)
        console.log(`[handleClarificationLoop] Setting up VOUCH_MENTION collector for ${userId}. Attempt ${attemptCount + 1}`);
        const vouchMentionCollector = channel.createMessageCollector({
          filter: (m) => m.author.id === userId && m.channel.id === channelId,
          time: nextStepTimeout, // VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS
          max: 1,
        });

        vouchMentionCollector.on("collect", async (m) => {
          console.log(`[VouchMentionCollector] Collected: "${m.content}" from ${userId}`);
          await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, m.content, m.id);
          conversationHistoryForLLM.push({ role: "user", content: m.content });

          // Reprocess with LLM to extract mention or confirm intent with new info.
          const vouchLlmResponse = await processUserMessageWithLLM(m.content, conversationHistoryForLLM, member.user.username, userId);
          await handleClarificationLoop(member, channel, vouchLlmResponse, conversationHistoryForLLM, recruitmentCollection, messageHistoryCollection, guild, attemptCount + 1, m.id);
        });

        vouchMentionCollector.on("end", async (collected, reason) => {
          const latestUserData = await recruitmentCollection.findOne({ userId: userId });
          if (reason === "time" && collected.size === 0 && latestUserData?.conversationState?.activeCollectorType === 'VOUCH_MENTION') {
            console.log(`[VouchMentionCollector] Timed out for ${userId}.`);
            try {
                const sentTimeoutMsg = await channel.send("Didn't hear back about the vouch. If you still need one, or want to do something else, just let me know!");
                await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, sentTimeoutMsg.content, sentTimeoutMsg.id, null);
                await recruitmentCollection.updateOne({ userId: userId }, { $set: { 
                    "conversationState.currentStep": ConversationStep.IDLE, 
                    "conversationState.activeCollectorType": null, 
                    "conversationState.timeoutTimestamp": null,
                    "conversationState.lastDiscordMessageIdProcessed": null
                } });
            } catch (sendError) { console.error("Failed to send vouch mention timeout message", sendError); }
          }
        });
      }
      break;

    case "USER_REQUESTED_STAFF":
        console.log(`[handleClarificationLoop] User ${userId} requested staff assistance.`);
        const staffNotification = `User ${member.user.tag} (channel: <#${channel.id}>) has requested staff assistance. Last LLM intent: ${finalLlmResponseForThisTurn?.intent || 'N/A'}.`;
        await notifyStaff(guild, staffNotification, "USER_REQUESTED_STAFF_HCL");
        try {
            const sentMsg = await channel.send("Okay, I've notified the staff. Someone should be with you shortly!");
            await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channel.id, sentMsg.content, sentMsg.id, finalLlmResponseForThisTurn);
            // State already set to IDLE, and conversationShouldContinue is false.
        } catch(e){console.error("Error sending staff notification confirmation", e);}
        break;

    case "END_CONVERSATION":
        console.log(`[handleClarificationLoop] User ${userId} or LLM indicated end of conversation.`);
        // Bot might have already sent a goodbye message via finalLlmResponseForThisTurn.suggested_bot_response.
        // State already set to IDLE, and conversationShouldContinue is false.
        // Ensure last processed ID is cleared if we are truly ending.
        await recruitmentCollection.updateOne({userId}, {$set: {"conversationState.lastDiscordMessageIdProcessed": null}}).catch(console.error);
        break;

    default:
      // This case handles intents that were clear (requiresClarification = false)
      // but don't have specific complex logic like VOUCH or APPLICATION_INTEREST.
      // For these, if conversationShouldContinue is true, a GENERAL_LISTENING collector will be set up by the logic
      // that follows this switch statement.
      console.log(`[handleClarificationLoop] Intent '${currentIntent}' for ${userId} is clear and doesn't require specific collector setup here. Will proceed to general listening if configured.`);
      // Ensure if we fall here, nextStep is likely GENERAL_LISTENING as per the logic at the top of HCL.
      if (nextStep !== ConversationStep.GENERAL_LISTENING && conversationShouldContinue) {
          console.warn(`[ClarifyLoop-${userId}] Intent ${currentIntent} was clear, but nextStep was ${nextStep} instead of GENERAL_LISTENING. Review logic. Forcing GENERAL_LISTENING.`);
          // This is a safeguard. The logic at the top should correctly set nextStep.
          // Forcing GENERAL_LISTENING if no other specific action was taken and conversation should continue.
          // This ensures the bot doesn't go silent if an intent is known but has no specific handler to create a collector.
          const generalListenerCollector = channel.createMessageCollector({
            filter: (m) => m.author.id === userId && m.channel.id === channelId,
            time: GENERAL_CLARIFICATION_TIMEOUT_MS * 3, 
          });
    
          generalListenerCollector.on("collect", async (m) => {
            console.log(`[GeneralListenerCollector-DefaultCase] Collected: "${m.content}" from ${userId} in ${m.channel.name}`);
            generalListenerCollector.stop("newMessage");
            await logBotMsgToHistory(messageHistoryCollection, recruitmentCollection, userId, channelId, m.content, m.id);
            conversationHistoryForLLM.push({ role: "user", content: m.content });
            const followUpLlmResponse = await processUserMessageWithLLM(m.content, conversationHistoryForLLM, member.user.username, userId);
            await handleClarificationLoop(member, channel, followUpLlmResponse, conversationHistoryForLLM, recruitmentCollection, messageHistoryCollection, guild, 0, m.id);
          });
    
          generalListenerCollector.on("end", async (collected, reason) => {
            const latestUserData = await recruitmentCollection.findOne({ userId: userId });
            if (reason === "time" && collected.size === 0 && latestUserData?.conversationState?.activeCollectorType === 'GENERAL') {
                console.log(`[GeneralListenerCollector-DefaultCase] Timed out for ${userId}.`);
                await recruitmentCollection.updateOne({ userId: userId }, { $set: { 
                    "conversationState.currentStep": ConversationStep.IDLE, 
                    "conversationState.activeCollectorType": null, 
                    "conversationState.timeoutTimestamp": null,
                    "conversationState.lastDiscordMessageIdProcessed": null 
                } });
            }
          });
      } else if (!conversationShouldContinue) {
        console.log(`[handleClarificationLoop] Conversation for ${userId} (intent: ${currentIntent}) has ended or been handed off. No new collector from default case.`);
      }
      break;
  }
  // Final check: if conversationShouldContinue is true, but no specific collector was set up by the switch cases,
  // AND nextCollectorType is GENERAL (determined by the if/else block at the beginning of HCL),
  // then set up the general listener. This has been largely integrated into the switch cases for clarity.
  // The UNCLEAR_INTENT/GENERAL_QUESTION case explicitly sets up a general listener if appropriate.
  console.log(`[ClarifyLoop-${userId}] End of handleClarificationLoop. Final nextStep=${nextStep}, nextCollectorType=${nextCollectorType}, conversationShouldContinue=${conversationShouldContinue}`);

}

/**
 * Main event handler for when a new member joins the guild.
 */
export default function onGuildMemberAdd(client, database) {
  client.on(Events.GuildMemberAdd, async (member) => {
    console.log(`[Event: GuildMemberAdd] User ${member.user.tag} (ID: ${member.id}) joined guild ${member.guild.name}.`);
    
    if (member.user.bot) {
        console.log(`[Event: GuildMemberAdd] User ${member.user.tag} is a bot. Ignoring.`);
        return;
    }

    // Account Age Restriction Check
    // if (MIN_ACCOUNT_AGE_DAYS > 0) {
    //     const kickedForAge = await handleAccountAgeRestriction(member);
    //     if (kickedForAge) {
    //         console.log(`[Event: GuildMemberAdd] User ${member.user.tag} was kicked due to account age. Processing stopped.`);
    //         return;
    //     }
    // }

    const recruitmentCollection = database.collection("recruitment");
    let userData = await recruitmentCollection.findOne({ userId: member.id });

    if (userData) {
        // User has joined before
        console.log(`[Event: GuildMemberAdd] User ${member.user.tag} is a rejoining member.`);
        // Update joinTimestamp to reflect new join, but keep original if needed under a different field.
        // For now, just update it.
        await recruitmentCollection.updateOne({ userId: member.id }, { $set: { joinTimestamp: new Date(), "conversationState.currentStep": ConversationStep.IDLE } });
        userData = await recruitmentCollection.findOne({ userId: member.id }); // Refresh userData
        await processRejoiningUser(member, userData, recruitmentCollection);
    } else {
        // New user
        console.log(`[Event: GuildMemberAdd] User ${member.user.tag} is a new member.`);
        await processNewUser(member, database);
    }
  });
}
