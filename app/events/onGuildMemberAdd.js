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
          logs: [{timestamp: new Date(), event: "New user processed"}]
        },
      },
      { upsert: true }
    );
    console.log(`Initialized database entry for ${member.user.tag}`);
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

    const llmResponse = await processUserMessageWithLLM(
      message.content, 
      member.user.id,
      conversationHistoryForLLM, 
      channel.id
    );
    console.log("[RecruiterApp] LLM Response Received:", JSON.stringify(llmResponse, null, 2));

    async function logBotMsgToHistory(msgContent, llmRespObj = null) {
        if (!msgContent) return;
        try {
            const logEntry = {
                userId: member.user.id,
                channelId: channel.id,
                author: "bot",
                content: msgContent,
                timestamp: new Date()
            };
            if (llmRespObj) logEntry.llm_response_object = llmRespObj;
            await messageHistoryCollection.insertOne(logEntry);
            await recruitmentCollection.updateOne(
              { userId: member.user.id }, 
              { $set: { lastActivityAt: new Date() } }
            );
        } catch (e) { console.error("[RecruiterApp] DB Error logging bot message:", e); }
    }
    
    let botResponseMessageContent; 

    if (llmResponse && llmResponse.intent) {
      switch (llmResponse.intent) {
        case "COMMUNITY_INTEREST_VOUCH":
          console.log(`[RecruiterApp] Intent: COMMUNITY_INTEREST_VOUCH, Entities:`, llmResponse.entities);
          
          const vouchPersonName = llmResponse.entities?.vouch_person_name;
          let voucherMember; 

          if (vouchPersonName) {
            voucherMember = guild.members.cache.find(m => 
              m.user.username.toLowerCase() === vouchPersonName.toLowerCase() || 
              m.displayName.toLowerCase() === vouchPersonName.toLowerCase() ||
              m.id === vouchPersonName.replace(/<@!?(\d+)>/g, '$1')
            );
          }

          if (voucherMember) {
            console.log(`[RecruiterApp] VOUCH: Found potential voucher on first attempt: ${voucherMember.user.tag}`);
            botResponseMessageContent = llmResponse.suggested_bot_response || `Thanks for letting me know you know ${voucherMember.user.tag}! I'll start the vouch process.`;
            await channel.send(botResponseMessageContent);
            await logBotMsgToHistory(botResponseMessageContent, llmResponse); 
            
            await initiateVouchProcess(member, voucherMember, channel, llmResponse, recruitmentCollection, messageHistoryCollection);
            botResponseMessageContent = null; 
          } else {
            let clarificationMessageText = "";
            if (vouchPersonName) {
                console.log(`[RecruiterApp] VOUCH: Could not find voucher member by name/ID: ${vouchPersonName} from initial LLM response.`);
                clarificationMessageText = `I see you mentioned ${vouchPersonName}, but I couldn't find them in the server. Could you please @mention them directly in your next message?`;
            } else { 
                console.log("[RecruiterApp] VOUCH: vouch_person_name was null or unclear from LLM. Asking for @mention.");
                if (llmResponse.requires_clarification && llmResponse.suggested_bot_response && llmResponse.suggested_bot_response.includes("@mention")) {
                    clarificationMessageText = llmResponse.suggested_bot_response;
                } else if (llmResponse.requires_clarification && llmResponse.suggested_bot_response) {
                    clarificationMessageText = llmResponse.suggested_bot_response;
                } else {
                    clarificationMessageText = `I understand you want to play with friends! To connect you, could you please @mention one of your friends in the ${GUILD_NAME} guild in your next message?`; // Used GUILD_NAME
                }
            }
            await channel.send(clarificationMessageText);
            await logBotMsgToHistory(clarificationMessageText, llmResponse); 
            botResponseMessageContent = null; 

            const mentionFilter = m => m.author.id === member.id && m.channel.id === channel.id;
            const mentionCollector = channel.createMessageCollector({ filter: mentionFilter, max: 1, time: VOUCH_MENTION_CLARIFICATION_TIMEOUT_MS }); // Used config timer

            mentionCollector.on('collect', async (mentionMessage) => {
              console.log(`[RecruiterApp] VOUCH: Collected follow-up message for vouch: "${mentionMessage.content}"`);
              await messageHistoryCollection.insertOne({
                  userId: member.id, channelId: channel.id, author: "user", 
                  content: mentionMessage.content, timestamp: new Date(mentionMessage.createdTimestamp)
              });
              await recruitmentCollection.updateOne({ userId: member.id }, { $set: { lastActivityAt: new Date() } });

              const mentionedVoucherName = mentionMessage.content; 
              const mentionedVoucherMember = guild.members.cache.find(m => 
                m.id === mentionedVoucherName.replace(/<@!?(\d+)>/g, '$1') || 
                m.user.username.toLowerCase() === mentionedVoucherName.toLowerCase() || 
                m.displayName.toLowerCase() === mentionedVoucherName.toLowerCase()
              );

              if (mentionedVoucherMember) {
                console.log(`[RecruiterApp] VOUCH: Found potential voucher from @mention: ${mentionedVoucherMember.user.tag}`);
                const currentLlmResponseForVouch = {
                    ...llmResponse, 
                    entities: {
                        ...llmResponse.entities,
                        vouch_person_name: mentionedVoucherMember.user.tag, 
                        original_vouch_text: llmResponse.entities?.original_vouch_text || mentionMessage.content
                    }
                };
                const followUpAck = `Thanks! I found ${mentionedVoucherMember.user.tag}. Starting the vouch process now.`;
                await channel.send(followUpAck);
                await logBotMsgToHistory(followUpAck, currentLlmResponseForVouch); 

                await initiateVouchProcess(member, mentionedVoucherMember, channel, currentLlmResponseForVouch, recruitmentCollection, messageHistoryCollection);
              } else {
                console.log(`[RecruiterApp] VOUCH: Still could not find voucher from follow-up message: "${mentionMessage.content}"`);
                const noVoucherFoundMsg = "Sorry, I still couldn't identify a valid member from your message. A recruiter will need to assist you with the vouch process.";
                await channel.send(noVoucherFoundMsg);
                await logBotMsgToHistory(noVoucherFoundMsg);
                await notifyStaff(guild, `User ${member.user.tag} attempted vouch with '${mentionMessage.content}' but voucher was not found. Manual assistance needed in channel #${channel.name}.`, "VOUCH_CLARIFY_FAIL");
              }
            });

            mentionCollector.on('end', async (collectedMessages, reason) => {
              if (reason === 'time' && collectedMessages.size === 0) {
                const timeoutMsg = "You didn't provide an @mention in time. If you still need help with a vouch, please ping a recruiter.";
                await channel.send(timeoutMsg).catch(console.error);
                await logBotMsgToHistory(timeoutMsg);
              }
            });
          }
          break;

        case "GUILD_APPLICATION_INTEREST":
          console.log(`[RecruiterApp] Intent: GUILD_APPLICATION_INTEREST, Entities:`, llmResponse.entities);
          botResponseMessageContent = llmResponse.suggested_bot_response || `Thanks for your interest in applying to ${GUILD_NAME}! Let me get you some information.`; // Used GUILD_NAME
          await channel.send(botResponseMessageContent);
          break;

        case "GENERAL_QUESTION":
          console.log(`[RecruiterApp] Intent: GENERAL_QUESTION, Entities:`, llmResponse.entities);
          botResponseMessageContent = llmResponse.suggested_bot_response || "That's a good question!";
          await channel.send(botResponseMessageContent);
          await logBotMsgToHistory(botResponseMessageContent, llmResponse);
          break;

        default: 
          console.log(`[RecruiterApp] Intent: ${llmResponse.intent} (processing in default/clarification path)`);
          botResponseMessageContent = llmResponse.suggested_bot_response;
          
          if (!botResponseMessageContent) {
            console.warn(
              "[RecruiterApp] No suggested_bot_response from LLM or LLM failed for default case."
            );
            botResponseMessageContent =
              "I'm having a little trouble understanding that. A guild officer will be with you shortly to help.";
            await channel.send(botResponseMessageContent);
            await logBotMsgToHistory(botResponseMessageContent, llmResponse);
          } else if (llmResponse.requires_clarification) {
            console.log("[RecruiterApp] LLM requires clarification, initiating clarification loop.");
            // Send the first clarification question from the initial LLM response
            await channel.send(botResponseMessageContent);
            // Log this first bot query before starting the loop
            await logBotMsgToHistory(botResponseMessageContent, llmResponse); 

            // History for the loop should include the bot's first clarification question
            const historyForLoop = [...conversationHistoryForLLM, { role: "assistant", content: botResponseMessageContent }];

            // Call the new clarification loop. It will handle collecting the user's next message.
            // Pass the user's *original* message.content as the first "userMessageContent" for the loop to process again 
            // if the LLM needs to re-evaluate it based on its own clarification question.
            // However, since we are *about* to collect a *new* message from the user in the loop,
            // we can pass an empty string or a marker for the first userMessageContent to handleClarificationLoop,
            // as it will immediately set up a collector for the user's actual response to botResponseMessageContent.
            // Let's make the loop directly collect the response to the botResponseMessageContent.
            
            // The handleClarificationLoop will set up its own collector for the user's response
            // to the botResponseMessageContent that was just sent.
            // We pass the history *including* the bot query that was just sent.
            // The userMessageContent for the first call to the loop will be the user's *next* message.
            
            // Simpler: The bot has asked its question (botResponseMessageContent).
            // The loop will create a collector for the user's answer to *that* question.
            // So, the userMessageContent to kick off the loop for the *first iteration* is effectively what the *new* collector will get.
            // The history passed to the loop should be up to and including the bot's question.
            
            const initialClarificationFilter = m => m.author.id === member.id && m.channel.id === channel.id;
            const initialClarificationCollectorForLoop = channel.createMessageCollector({ filter: initialClarificationFilter, max: 1, time: GENERAL_CLARIFICATION_TIMEOUT_MS });

            initialClarificationCollectorForLoop.on('collect', async (clarificationMessage) => {
                // Now we have the user's response to the first clarification question.
                // conversationHistoryForLLM already contains the user's first message.
                // historyForLoop contains user's first message + bot's first clarification question.
                await handleClarificationLoop(
                    member,
                    channel,
                    clarificationMessage.content, // This is the user's answer to the first clarification query
                    historyForLoop, // Contains history up to the bot's first clarification query
                    recruitmentCollection,
                    messageHistoryCollection,
                    guild,
                    logBotMsgToHistory,
                    1 // First attempt *within* the dedicated loop
                );
            });

            initialClarificationCollectorForLoop.on('end', async (collectedMsgs, reason) => {
                if (reason === 'time' && collectedMsgs.size === 0) {
                    const timeoutClarMsg = "It looks like you didn't provide a clarification in time. If you still need assistance, please type your query again or ping a recruiter.";
                    if(!channel.deleted) await channel.send(timeoutClarMsg).catch(console.error);
                    await logBotMsgToHistory(timeoutClarMsg);
                }
            });

          } else {
            // No clarification needed from the first LLM response, but it was a default/unclear intent.
            // This path means llmResponse.requires_clarification was false.
            await channel.send(botResponseMessageContent); 
            await logBotMsgToHistory(botResponseMessageContent, llmResponse);
          }
          break; // End of default case for the initial collector
      }
    } else {
      console.warn(
        "[RecruiterApp] No intent from LLM or LLM response was malformed."
      );
      botResponseMessageContent =
        "I'm currently having some trouble processing requests. A guild officer will be with you shortly.";
      await channel.send(botResponseMessageContent);
      await logBotMsgToHistory(botResponseMessageContent); 
    }
  });

  collector.on("end", async (collected, reason) => {
    if (reason === "time" && collected.size === 0) { 
      console.log(
        `User ${member.user.tag} did not respond within the time limit.`
      );
      const timeoutMsg = "It looks like you might be busy. Feel free to respond when you're ready, or a recruiter will check in with you later.";
      if (channel && !channel.deleted) { 
        try {
            await channel.send(timeoutMsg);
            await logBotMsgToHistory(timeoutMsg);
        } catch (e) {
            console.error(`Error sending timeout message to channel ${channel?.name}:`, e);
        }
      }
    }
  });
}

async function handleClarificationLoop(
  member,
  channel,
  userMessageContent, // The content of the user's message that needs clarification or is a clarification
  currentConversationHistory, // Array of {role, content} for LLM
  recruitmentCollection,
  messageHistoryCollection,
  guild, // Pass guild explicitly for actions like notifyStaff and member lookups
  logBotMsgToHistory, // Pass the helper function
  attemptCount
) {
  console.log(`[ClarificationLoop attempt #${attemptCount}] Processing message: "${userMessageContent}"`);

  // 1. Log the current user's message (if it's not the very first dummy call)
  if (attemptCount > 0) { // Avoid double logging the first message if handled by initial collector
    try {
      await messageHistoryCollection.insertOne({
        userId: member.user.id,
        channelId: channel.id,
        author: "user",
        content: userMessageContent,
        timestamp: new Date(), // Consider passing message.createdTimestamp if available
      });
      await recruitmentCollection.updateOne(
        { userId: member.user.id },
        { $set: { lastActivityAt: new Date() } }
      );
    } catch (dbError) {
      console.error(
        `[ClarificationLoop] Error saving user message for ${member.user.tag}:`,
        dbError
      );
    }
  }

  // 2. Update conversation history for this turn (if messageContent is new)
  // The currentConversationHistory passed in should already include messages up to the one *before* userMessageContent
  const updatedHistoryForLLM = [
    ...currentConversationHistory,
    { role: "user", content: userMessageContent }
  ];

  // 3. Call LLM
  const llmResponse = await processUserMessageWithLLM(
    userMessageContent, // Though context is in history, send current utterance too
    member.user.id,
    updatedHistoryForLLM, 
    channel.id
  );
  console.log(`[ClarificationLoop attempt #${attemptCount}] LLM Response:`, JSON.stringify(llmResponse, null, 2));

  // 4. Log LLM's direct response object (useful for debugging)
  try {
    await messageHistoryCollection.insertOne({
        userId: member.user.id,
        channelId: channel.id,
        author: "bot_llm_response_obj",
        content: "LLM Response Object",
        llm_response_object: llmResponse,
        timestamp: new Date()
    });
  } catch(e){ console.error("[ClarificationLoop] DB Error logging LLM response object:", e); }

  // 5. Logic based on llmResponse
  if (llmResponse && llmResponse.requires_clarification && attemptCount < MAX_CLARIFICATION_ATTEMPTS) {
    const botClarificationQuery = llmResponse.suggested_bot_response || "I need a bit more information. Could you please tell me more?";
    await channel.send(botClarificationQuery);
    await logBotMsgToHistory(botClarificationQuery, llmResponse);

    const nextAttemptFilter = m => m.author.id === member.id && m.channel.id === channel.id;
    const nextCollector = channel.createMessageCollector({ filter: nextAttemptFilter, max: 1, time: GENERAL_CLARIFICATION_TIMEOUT_MS });

    nextCollector.on('collect', async (nextMessage) => {
      // Important: Add the bot's clarification question to history before user's next reply for LLM context
      const historyWithBotQuery = [...updatedHistoryForLLM, { role: "assistant", content: botClarificationQuery }];
      await handleClarificationLoop(
        member,
        channel,
        nextMessage.content,
        historyWithBotQuery, // Pass history including the bot's last question
        recruitmentCollection,
        messageHistoryCollection,
        guild,
        logBotMsgToHistory,
        attemptCount + 1
      );
    });

    nextCollector.on('end', async (collectedMsgs, reason) => {
      if (reason === 'time' && collectedMsgs.size === 0) {
        const timeoutMsg = `[ClarificationLoop attempt #${attemptCount}] It looks like you didn't provide a response. If you still need assistance, please type your query again or ping a recruiter.`;
        if (!channel.deleted) await channel.send(timeoutMsg).catch(console.error);
        await logBotMsgToHistory(timeoutMsg);
      }
    });

  } else if (llmResponse && llmResponse.requires_clarification && attemptCount >= MAX_CLARIFICATION_ATTEMPTS) {
    const maxAttemptsMsg = "I've asked for clarification a few times but I'm still not sure how to help. A staff member will be with you shortly.";
    if (!channel.deleted) await channel.send(maxAttemptsMsg);
    await logBotMsgToHistory(maxAttemptsMsg, llmResponse);
    await notifyStaff(guild, `User ${member.user.tag} in channel #${channel.name} reached max clarification attempts. LLM still requires clarification. Manual assistance needed. Last user message: "${userMessageContent}"`, "MAX_CLARIFICATION_ATTEMPTS_REACHED");
  
  } else if (llmResponse && llmResponse.intent) {
    // Intent is considered clear, or no more clarification needed/allowed
    console.log(`[ClarificationLoop attempt #${attemptCount}] Intent determined: ${llmResponse.intent}. Processing action.`);
    let finalBotResponse;

    // !!! This switch block is MOVED and ADAPTED from the old clarificationCollector !!!
    switch (llmResponse.intent) {
        case "GUILD_APPLICATION_INTEREST":
            console.log(`[ClarificationLoop->Switch] User (${member.user.tag}) expressed GUILD_APPLICATION_INTEREST.`);
            finalBotResponse = llmResponse.suggested_bot_response || `Great! It sounds like you're interested in formally applying to join ${GUILD_NAME}. Let's start the process.`;
            if (!channel.deleted) await channel.send(finalBotResponse);
            await logBotMsgToHistory(finalBotResponse, llmResponse);

            await recruitmentCollection.updateOne(
            { userId: member.id },
            { 
                $set: { 
                communityStatus: "APPLICATION_STARTED", 
                applicationIntent: llmResponse.intent,
                applicationDetails: llmResponse.entities,
                updatedAt: new Date()
                },
                $push: { 
                logs: { 
                    timestamp: new Date(), 
                    event: "Application process started after clarification loop.",
                    llmResponse: llmResponse
                } 
                }
            }
            );
            await notifyStaff(
            guild, 
            `User ${member.user.tag} (${member.id}) has expressed interest in applying to the guild in channel #${channel.name}.`,
            "GUILD_APPLICATION_STARTED"
            );

            const firstQuestion = "To begin, could you please tell us about your primary in-game character name, class, and level?";
            if (!channel.deleted) await channel.send(firstQuestion);
            await logBotMsgToHistory(firstQuestion, {type: "APPLICATION_QUESTION_1"});
            
            const nextStepsMsg = "Once you've answered, a recruiter will review your initial interest. You can also use `/apply` to submit a full application if available.";
            if (!channel.deleted) await channel.send(nextStepsMsg);
            await logBotMsgToHistory(nextStepsMsg);
            break;

        case "COMMUNITY_INTEREST_VOUCH":
            console.log("[RecruiterApp] Clarified intent: COMMUNITY_INTEREST_VOUCH. Attempting to start vouch process.");
            const clarifiedVouchPersonName = llmResponse.entities?.vouch_person_name;
            let clarifiedVoucherMember;

            if (clarifiedVouchPersonName) {
            clarifiedVoucherMember = guild.members.cache.find(m =>
                m.id === clarifiedVouchPersonName.replace(/<@!?(\d+)>/g, '$1') ||
                m.user.username.toLowerCase() === clarifiedVouchPersonName.toLowerCase() ||
                m.displayName.toLowerCase() === clarifiedVouchPersonName.toLowerCase()
            );
            }

            if (clarifiedVoucherMember) {
            finalBotResponse = llmResponse.suggested_bot_response || `Thanks for clarifying! I found ${clarifiedVoucherMember.user.tag}. Starting the vouch process now.`;
            if (!channel.deleted) await channel.send(finalBotResponse);
            await logBotMsgToHistory(finalBotResponse, llmResponse);
            
            await initiateVouchProcess(member, clarifiedVoucherMember, channel, llmResponse, recruitmentCollection, messageHistoryCollection);
            } else {
            finalBotResponse = llmResponse.suggested_bot_response || `You mentioned wanting a vouch for ${clarifiedVouchPersonName || 'someone'}, but I still couldn't identify them. Please ensure they are a member of this server. A recruiter can assist you.`;
            if (!channel.deleted) await channel.send(finalBotResponse);
            await logBotMsgToHistory(finalBotResponse, llmResponse);
            await notifyStaff(guild, `User ${member.user.tag} attempted vouch with current message for '${clarifiedVouchPersonName || 'unknown'}' but voucher not found after clarification loop. Manual assistance needed in channel #${channel.name}. Last user message: "${userMessageContent}"`, "VOUCH_CLARIFY_FAIL_FINAL_LOOP");
            }
            break;
        
        // It's good practice to handle UNCLEAR_INTENT explicitly even if requires_clarification became false.
        case "UNCLEAR_INTENT": 
            console.log("[ClarificationLoop->Switch] Intent is UNCLEAR_INTENT, but requires_clarification is false. Treating as default.");
            finalBotResponse = llmResponse.suggested_bot_response || "Thanks for providing more information. A recruiter will review this and be with you if further steps are needed.";
            if (!channel.deleted) await channel.send(finalBotResponse);
            await logBotMsgToHistory(finalBotResponse, llmResponse);
            break;

        default: 
            finalBotResponse = llmResponse.suggested_bot_response || "Thanks for that information! A recruiter will review this and be with you if further steps are needed.";
            if (!channel.deleted) await channel.send(finalBotResponse);
            await logBotMsgToHistory(finalBotResponse, llmResponse);
            console.log("[ClarificationLoop->Switch] Clarified intent was: ", llmResponse.intent || "Unknown/Default Handling");
            // Potentially notify staff or log if an unexpected intent is processed here that should have specific handling
            break;
    }
  } else {
    // Fallback if llmResponse is null or doesn't have .intent (should be rare)
    console.warn("[ClarificationLoop] LLM response was missing, malformed, or intent could not be processed. Notifying staff.");
    const errMsg = "I'm having some trouble understanding your request right now. A staff member has been notified and will assist you shortly.";
    if (!channel.deleted) await channel.send(errMsg);
    await logBotMsgToHistory(errMsg, llmResponse); // Log even if llmResponse is partial/null
    await notifyStaff(guild, `User ${member.user.tag} in channel #${channel.name} encountered an issue where the LLM response was problematic after clarification loop. Manual assistance needed. Last user message: "${userMessageContent}"`, "LLM_RESPONSE_ERROR_FINAL_LOOP");
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
