import { Events, PermissionsBitField } from "discord.js";
import { getAccountRestrictionEmbed } from "./utils/onGuildMemberAdd.js";
import { processUserMessageWithLLM } from "../utils/llm_utils.js";
import { initiateVouchProcess } from "../utils/discord_actions.js";

/********************************************
 * CONSTANTS & CONFIG
 ********************************************/
const MIN_ACCOUNT_AGE_DAYS = 14;
const MIN_ACCOUNT_AGE_MS = MIN_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000;

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

/**
 * Example role map.
 */
const rolesMap = new Map();
rolesMap.set("RECRUITER", "Recruiter");
rolesMap.set("BOT", "Wraiven Bot");


/********************************************
 * HELPER FUNCTIONS
 ********************************************/

/**
 * Kicks the user if their account is younger than MIN_ACCOUNT_AGE_DAYS.
 * Returns true if the user was kicked (so we can stop the flow), false otherwise.
 */
async function handleAccountAgeRestriction(member) {
  const accountCreationTime = member.user.createdTimestamp; // ms since epoch
  const accountAge = Date.now() - accountCreationTime;

  if (accountAge < MIN_ACCOUNT_AGE_MS) {
    try {
      await member.send({
        embeds: [getAccountRestrictionEmbed(member.user)],
      });
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
 * Ensures we have (or create) a "City Gates" category.
 * Returns the category channel, or null if creation fails.
 */
async function ensureCityGatesCategory(guild) {
  // channel.type === 4 -> Category in Discord.js v14
  let category = guild.channels.cache.find(
    (ch) => ch.type === 4 && ch.name === "City Gates"
  );

  if (!category) {
    try {
      category = await guild.channels.create({
        name: "City Gates",
        type: 4,
      });
      console.log(`Created "City Gates" category successfully.`);
    } catch (error) {
      console.error(`Unable to create "City Gates" category: `, error);
      return null;
    }
  }

  return category;
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
 * Ensures the user's "processing" channel exists and permissions are correct.
 * Returns the channel. Creates it if needed; updates perms if it exists.
 */
async function ensureUserProcessingChannel(
  member,
  channelId,
  recruitmentCollection
) {
  const guild = member.guild;

  // 1) Find or create the "City Gates" category
  const cityGatesCategory = await ensureCityGatesCategory(guild);

  // 2) See if we already have a channel ID in DB
  let channel = channelId ? guild.channels.cache.get(channelId) : null;

  if (!channel) {
    // Channel doesn't exist—create a new one
    const channelName = `processing-${member.user.username}`;
    channel = await guild.channels.create({
      name: channelName,
      type: 0, // text channel
      parent: cityGatesCategory ? cityGatesCategory.id : null,
    });

    // Save the new channel ID in DB
    await recruitmentCollection.updateOne(
      { userId: member.user.id },
      { $set: { channelId: channel.id } }
    );

    console.log(`Created channel "${channelName}" for ${member.user.tag}`);
  } else {
    console.log(
      `Using existing channel (#${channel.name}) for ${member.user.tag}`
    );
  }

  // 3) Set or update permission overwrites (always ensure the correct perms)
  const permissionOverwrites = buildProcessingChannelPermissions(member, guild);
  await channel.permissionOverwrites.set(permissionOverwrites);

  // 4) Return the channel reference
  return channel;
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
  const { role, channelId, messageHistory } = userData;

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
      messageHistory?.length
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

  // Attempt to assign "Outsider" role
  const outsiderRole = guild.roles.cache.find((r) => r.name === "Outsider");
  if (outsiderRole && !member.roles.cache.has(outsiderRole.id)) {
    try {
      await member.roles.add(outsiderRole);
      console.log(`Assigned "Outsider" role to ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Error assigning "Outsider" role to ${member.user.tag}:`,
        error
      );
    }
  }

  // Initialize user in DB
  try {
    await recruitmentCollection.updateOne(
      { userId },
      {
        $set: {
          userId,
          username: member.user.username,
          channelId: null,
          messageHistory: [],
          applicationStatus: ACCESS_STATUS.PENDING,
          communityStatus: COMMUNITY_STATUS.PENDING,
          role: outsiderRole ? outsiderRole.name : null,
          joinedAt: Date.now(),
        },
      },
      { upsert: true }
    );
    console.log(`Initialized database entry for ${member.user.tag}`);
  } catch (error) {
    console.error(`Error initializing DB entry for ${member.user.tag}:`, error);
  }

  // Ensure (create) the user's processing channel
  const channel = await ensureUserProcessingChannel(
    member,
    null, // no channelId since brand-new
    recruitmentCollection
  );

  // DM them the link
  const channelLink = `https://discord.com/channels/${guild.id}/${channel.id}`;
  try {
    await member.send(
      `Hello **${member.user.username}**, welcome to Wraiven!
` +
        `Your private channel is ready: ${channelLink}`
    );
  } catch (dmError) {
    console.error(`Failed to DM ${member.user.tag}:`, dmError);
  }

  // Post a welcome message in their channel
  await channel.send(
    `Hello, **${member.user.username}**, welcome to Wraiven!`
  );
  await channel.send(
    "What is your purpose for joining the Wraiven Discord channel?"
  );

  // Collect the user's first message in response
  const filter = (m) => m.author.id === member.id;
  const collector = channel.createMessageCollector({
    filter,
    max: 1, // Collect only one message for this initial interaction
    time: 5 * 60 * 1000, // 5 minutes
  });

  collector.on("collect", async (message) => {
    console.log(
      `Collected response from ${member.user.tag}: "${message.content}"`
    );

    // 1. Store the user's message in messageHistory
    try {
      await recruitmentCollection.updateOne(
        { userId: member.user.id },
        {
          $push: {
            messageHistory: {
              author: "user",
              content: message.content,
              timestamp: message.createdTimestamp,
            },
          },
          $set: { lastActivityAt: Date.now() } // Update last activity timestamp
        }
      );
    } catch (dbError) {
      console.error(
        `Error updating message history with user message for ${member.user.tag}:`,
        dbError
      );
      // Potentially send an error message or alert, but continue for now
    }

    // 2. Fetch updated conversation history for the LLM
    let conversationHistory = [];
    try {
      const userData = await recruitmentCollection.findOne({ userId: member.user.id });
      if (userData && userData.messageHistory) {
        conversationHistory = userData.messageHistory.map((histMessage) => ({
          author: histMessage.author, // Assumes DB stores 'user' or 'bot'
          content: histMessage.content,
        }));
      }
    } catch (dbError) {
      console.error(
        `Error fetching conversation history for ${member.user.tag}:`,
        dbError
      );
      // LLM will proceed without history if this fails
    }

    // 3. Call the LLM (mock for now)
    const llmResponse = await processUserMessageWithLLM(
      message.content,
      member.user.id,
      conversationHistory
    );
    console.log("[RecruiterApp] LLM Response Received:", JSON.stringify(llmResponse, null, 2));

    // 4. Bot acts based on LLM output
    let botResponseMessageContent;
    let performedComplexAction = false; // Flag to see if a specific intent handler took over

    if (llmResponse && llmResponse.intent) {
      switch (llmResponse.intent) {
        case "COMMUNITY_INTEREST_VOUCH":
          console.log(`[RecruiterApp] Intent: COMMUNITY_INTEREST_VOUCH, Entities:`, llmResponse.entities);
          
          const vouchPersonName = llmResponse.entities?.vouch_person_name;
          let voucherMember; 

          if (vouchPersonName) {
            const guild = member.guild;
            voucherMember = guild.members.cache.find(m => 
              m.user.username.toLowerCase() === vouchPersonName.toLowerCase() || 
              m.displayName.toLowerCase() === vouchPersonName.toLowerCase() ||
              m.id === vouchPersonName.replace(/<@!?(\d+)>/g, '$1')
            );
          }

          if (voucherMember) {
            // Found voucher on first try
            console.log(`[RecruiterApp] VOUCH: Found potential voucher on first attempt: ${voucherMember.user.tag}`);
            // Send the LLM's response now that we know we have a valid voucher to reference
            let initialVouchResponse = llmResponse.suggested_bot_response || `Thanks for letting me know you know ${voucherMember.user.tag}! I'll start the vouch process.`;
            await channel.send(initialVouchResponse);
            // Log this specific message to history, then nullify botResponseMessageContent before calling initiateVouchProcess
            // as initiateVouchProcess will handle further distinct messages.
            try {
                await recruitmentCollection.updateOne(
                  { userId: member.user.id },
                  {
                    $push: { messageHistory: { author: "bot", content: initialVouchResponse, timestamp: Date.now() } },
                    $set: { lastActivityAt: Date.now() }
                  }
                );
            } catch (dbError) { console.error("[RecruiterApp] VOUCH: DB error logging initial vouch ack:", dbError); }
            
            await initiateVouchProcess(member, voucherMember, channel, llmResponse, recruitmentCollection);
            botResponseMessageContent = null; // Vouch process handles its own messages from here
          } else {
            // Voucher not found or not specified clearly by LLM, ask for @mention
            let clarificationMessageText = "";
            if (vouchPersonName) { // LLM provided a name, but we couldn't find them
                console.log(`[RecruiterApp] VOUCH: Could not find voucher member by name/ID: ${vouchPersonName} from initial LLM response.`);
                clarificationMessageText = `I see you mentioned ${vouchPersonName}, but I couldn't find them in the server. Could you please @mention them directly in your next message?`;
            } else { // LLM likely set vouch_person_name to null (e.g., for "friends")
                console.log("[RecruiterApp] VOUCH: vouch_person_name was null or unclear from LLM. Asking for @mention.");
                // Use suggested_bot_response if it already asks for clarification, or a default.
                if (llmResponse.requires_clarification && llmResponse.suggested_bot_response && llmResponse.suggested_bot_response.includes("@mention")) {
                    clarificationMessageText = llmResponse.suggested_bot_response; // LLM already crafted a good clarification request
                } else if (llmResponse.requires_clarification && llmResponse.suggested_bot_response) {
                    // If LLM wants clarification but didn't specifically ask for @mention, use its general clarification.
                    clarificationMessageText = llmResponse.suggested_bot_response;
                } else {
                    clarificationMessageText = "I understand you want to play with friends! To connect you, could you please @mention one of your friends in the guild in your next message?";
                }
            }
            await channel.send(clarificationMessageText);
            // This clarification message is the one we want in history for this step.
            botResponseMessageContent = clarificationMessageText; 

            // Set up a new collector for the @mention
            const mentionFilter = m => m.author.id === member.id;
            const mentionCollector = channel.createMessageCollector({ filter: mentionFilter, max: 1, time: 2 * 60 * 1000 }); // 2 minutes for @mention

            mentionCollector.on('collect', async (mentionMessage) => {
              console.log(`[RecruiterApp] VOUCH: Collected follow-up message for vouch: "${mentionMessage.content}"`);
              // Log the user's @mention attempt to history
              try {
                await recruitmentCollection.updateOne(
                  { userId: member.user.id },
                  {
                    $push: { messageHistory: { author: "user", content: mentionMessage.content, timestamp: mentionMessage.createdTimestamp } },
                    $set: { lastActivityAt: Date.now() }
                  }
                );
              } catch (dbError) { console.error("[RecruiterApp] VOUCH: DB error logging @mention response:", dbError); }

              const mentionedVoucherName = mentionMessage.content; 
              const guild = member.guild;
              const mentionedVoucherMember = guild.members.cache.find(m => 
                m.id === mentionedVoucherName.replace(/<@!?(\d+)>/g, '$1') || // Primarily check for actual mention ID
                m.user.username.toLowerCase() === mentionedVoucherName.toLowerCase() || 
                m.displayName.toLowerCase() === mentionedVoucherName.toLowerCase()
              );

              if (mentionedVoucherMember) {
                console.log(`[RecruiterApp] VOUCH: Found potential voucher from @mention: ${mentionedVoucherMember.user.tag}`);
                // We need to pass an llmResponse-like object to initiateVouchProcess.
                const followUpLlmResponse = {
                    ...llmResponse, 
                    entities: {
                        ...llmResponse.entities,
                        vouch_person_name: mentionedVoucherMember.user.tag, 
                        original_vouch_text: llmResponse.entities?.original_vouch_text || mentionMessage.content
                    }
                };
                // Send a specific ack before starting vouch process, then log it.
                const followUpAck = `Thanks! I found ${mentionedVoucherMember.user.tag}. Starting the vouch process now.`;
                await channel.send(followUpAck);
                try {
                    await recruitmentCollection.updateOne(
                      { userId: member.user.id },
                      {
                        $push: { messageHistory: { author: "bot", content: followUpAck, timestamp: Date.now() } },
                        $set: { lastActivityAt: Date.now() }
                      }
                    );
                } catch (dbError) { console.error("[RecruiterApp] VOUCH: DB error logging followUpAck:", dbError); }

                await initiateVouchProcess(member, mentionedVoucherMember, channel, followUpLlmResponse, recruitmentCollection);
              } else {
                console.log(`[RecruiterApp] VOUCH: Still could not find voucher from follow-up message: "${mentionMessage.content}"`);
                const noVoucherFoundMsg = "Sorry, I still couldn't identify a valid member from your message. A recruiter will need to assist you with the vouch process.";
                await channel.send(noVoucherFoundMsg);
                try {
                    await recruitmentCollection.updateOne(
                      { userId: member.user.id },
                      {
                        $push: { messageHistory: { author: "bot", content: noVoucherFoundMsg, timestamp: Date.now() } },
                        $set: { lastActivityAt: Date.now() }
                      }
                    );
                } catch (dbError) { console.error("[RecruiterApp] VOUCH: DB error logging noVoucherFoundMsg:", dbError); }
                // TODO: Notify recruiters
              }
            });

            mentionCollector.on('end', (collectedMessages, reason) => {
              if (reason === 'time' && collectedMessages.size === 0) {
                const timeoutMsg = "You didn't provide an @mention in time. If you still need help with a vouch, please ping a recruiter.";
                channel.send(timeoutMsg).catch(console.error);
                // Log timeout message to history
                recruitmentCollection.updateOne(
                    { userId: member.user.id },
                    {
                      $push: { messageHistory: { author: "bot", content: timeoutMsg, timestamp: Date.now() } },
                      $set: { lastActivityAt: Date.now() }
                    }
                ).catch(dbError => console.error("[RecruiterApp] VOUCH: DB error logging mention timeout msg:", dbError));
              }
            });
          }
          performedComplexAction = true;
          break;

        case "GUILD_APPLICATION_INTEREST":
          console.log(`[RecruiterApp] Intent: GUILD_APPLICATION_INTEREST, Entities:`, llmResponse.entities);
          botResponseMessageContent = llmResponse.suggested_bot_response || "Thanks for your interest in applying! Let me get you some information.";
          // Future: guide through application questions or link to application form.
          await channel.send(botResponseMessageContent);
          performedComplexAction = true; // Mark that we handled this intent specifically
          break;

        case "GENERAL_QUESTION":
          console.log(`[RecruiterApp] Intent: GENERAL_QUESTION, Entities:`, llmResponse.entities);
          botResponseMessageContent = llmResponse.suggested_bot_response || "That's a good question!";
          // Future: try to answer from a knowledge base or use LLM to generate answer.
          await channel.send(botResponseMessageContent);
          performedComplexAction = true;
          break;

        // Add more cases for other intents as needed
        // case "SOCIAL_GREETING":
        // case "UNCLEAR_INTENT":
        // case "OTHER":

        default:
          console.log(`[RecruiterApp] Intent: ${llmResponse.intent} (using default response)`);
          botResponseMessageContent = llmResponse.suggested_bot_response;
          if (!botResponseMessageContent) {
            console.warn(
              "[RecruiterApp] No suggested_bot_response from LLM or LLM failed for default case."
            );
            botResponseMessageContent =
              "I'm having a little trouble understanding that. A guild officer will be with you shortly to help.";
          }
          await channel.send(botResponseMessageContent);
          break;
      }
    } else {
      console.warn(
        "[RecruiterApp] No intent from LLM or LLM response was malformed."
      );
      botResponseMessageContent =
        "I'm currently having some trouble processing requests. A guild officer will be with you shortly.";
      await channel.send(botResponseMessageContent);
    }

    // 5. Store bot's response in messageHistory, only if a complex action didn't already send one
    //    OR if a complex action sent one, it should also handle its own history logging.
    //    For now, the switch cases send messages, so we log the `botResponseMessageContent` used.
    if (botResponseMessageContent) { // Ensure there is a message to log (and it wasn't nulled out by a complex handler)
      try {
        await recruitmentCollection.updateOne(
          { userId: member.user.id },
          {
            $push: {
              messageHistory: {
                author: "bot",
                content: botResponseMessageContent,
                timestamp: Date.now(),
              },
            },
            $set: { lastActivityAt: Date.now() } // Update last activity timestamp
          }
        );
      } catch (dbError) {
        console.error(
          `Error updating message history with bot response for ${member.user.tag}:`,
          dbError
        );
      }
    }
  });

  collector.on("end", (collected, reason) => {
    if (reason === "time" && collected.size === 0) { // Ensure no message was collected before timeout message
      console.log(
        `User ${member.user.tag} did not respond within the time limit.`
      );
      // Optionally, send a follow-up message or alert a recruiter
      channel
        .send(
          "It looks like you might be busy. Feel free to respond when you're ready, or a recruiter will check in with you later."
        )
        .catch(console.error);
    }
  });
}

/********************************************
 * MAIN EVENT HANDLER (exported)
 ********************************************/
export default function onGuildMemberAdd(client, database) {
  client.on(Events.GuildMemberAdd, async (member) => {
    // Optional: account-age check
    // const wasKicked = await handleAccountAgeRestriction(member);
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
