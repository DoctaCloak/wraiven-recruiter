import { PermissionsBitField, ChannelType } from "discord.js";
import fs from 'fs';
import path from 'path';

// Load configuration
const configPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Configuration - consider moving to a config file or environment variables
const FRIEND_ROLE_NAME = config.ROLES.FRIEND;
const VOUCH_REACTION_TIME_LIMIT = config.TIMERS.VOUCH_REACTION_TIME_LIMIT_HOURS * 60 * 60 * 1000;
// const STAFF_NOTIFICATION_CHANNEL_ID = "YOUR_STAFF_CHANNEL_ID_HERE"; // No longer using direct ID
const STAFF_NOTIFICATION_CATEGORY_NAME = config.CATEGORIES.STAFF_NOTIFICATIONS;
const STAFF_NOTIFICATION_CHANNEL_NAME = config.CHANNELS.STAFF_NOTIFICATIONS;

/**
 * Notifies staff by sending a message to a specific staff channel 
 * found by category and channel name.
 * @param {import('discord.js').Guild} guild The guild object.
 * @param {string} messageContent The message to send.
 * @param {string} eventType A string categorizing the event (e.g., VOUCH_DENIED, APPLICATION_STARTED).
 */
export async function notifyStaff(guild, messageContent, eventType) {
  console.log(`[STAFF NOTIFICATION] Event: ${eventType} | Guild: ${guild.name} | Message: ${messageContent}`);
  try {
    const category = guild.channels.cache.find(c => c.name === STAFF_NOTIFICATION_CATEGORY_NAME && c.type === ChannelType.GuildCategory);

    if (!category) {
        console.warn(`[notifyStaff] Staff notification category "${STAFF_NOTIFICATION_CATEGORY_NAME}" not found.`);
        return;
    }

    // Ensure category.children is a manager, then find the channel
    const staffChannel = category.children.cache.find(ch => ch.name === STAFF_NOTIFICATION_CHANNEL_NAME && ch.type === ChannelType.GuildText);

    if (staffChannel) { // staffChannel is implicitly a GuildText channel due to the filter
      await staffChannel.send(`**Recruiter Bot Alert | ${eventType}**\n>>> ${messageContent}`);
      console.log(`[notifyStaff] Sent notification to #${STAFF_NOTIFICATION_CHANNEL_NAME} in ${STAFF_NOTIFICATION_CATEGORY_NAME}`);
    } else {
      console.warn(`[notifyStaff] Staff channel "${STAFF_NOTIFICATION_CHANNEL_NAME}" not found in category "${STAFF_NOTIFICATION_CATEGORY_NAME}".`);
    }
  } catch (error) {
    console.error("[notifyStaff] Error sending staff notification to Discord channel:", error);
  }
}

/**
 * Initiates the vouch process for a new member.
 * - Grants the voucher temporary access to the new member's processing channel.
 * - Sends a message to the channel asking the voucher to confirm.
 * - Sets up a reaction collector to await the voucher's response.
 *
 * @param {import('discord.js').GuildMember} newMember - The new member who is being vouched for.
 * @param {import('discord.js').GuildMember} voucherMember - The existing member who is vouching.
 * @param {import('discord.js').TextChannel} processingChannel - The private channel for the new member.
 * @param {object} llmResponse - The response object from the LLM, containing intent and entities.
 * @param {import('mongodb').Collection} recruitmentCollection - The MongoDB collection for recruitment data.
 * @param {import('mongodb').Collection} messageHistoryCollection - The MongoDB collection for message history.
 */
export async function initiateVouchProcess(
  newMember,
  voucherMember,
  processingChannel,
  llmResponse, 
  recruitmentCollection,
  messageHistoryCollection
) {
  console.log(
    `[VouchProcess] Initiating for ${newMember.user.tag} by ${voucherMember.user.tag} in #${processingChannel.name}`
  );
  const guild = newMember.guild;
  const ConversationStep = { // Define locally for this utility or pass as arg if preferred
    IDLE: 'IDLE',
    VOUCH_PROCESS_ACTIVE: 'VOUCH_PROCESS_ACTIVE',
  };

  try {
    await processingChannel.permissionOverwrites.edit(voucherMember.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true, 
    });
    console.log(
      `[VouchProcess] Granted ${voucherMember.user.tag} access to #${processingChannel.name}`
    );

    const vouchRequestMessage = await processingChannel.send({
      content: 
        `Hi ${voucherMember}! 👋\n\n` +
        `${newMember} has joined and mentioned they know you. They're interested in joining the Wraiven community!\n\n` +
        `Could you please confirm if you can vouch for them? React with 👍 (thumbs up) to this message to confirm, or 👎 (thumbs down) if you cannot. \n` +
        `You have 24 hours to respond. If you have any questions, feel free to ask them here.\n\n` +
        `_Original statement from ${newMember.user.username}: "${llmResponse.entities?.original_vouch_text || 'User mentioned you'}"_`,
      allowedMentions: { users: [voucherMember.id, newMember.id] }, 
    });

    await vouchRequestMessage.react('👍');
    await vouchRequestMessage.react('👎');

    console.log(
      `[VouchProcess] Sent vouch request message to #${processingChannel.name}`
    );

    const filter = (reaction, user) => {
      console.log(`[VouchProcess DEBUG] Reaction received: Emoji Name: "${reaction.emoji.name}", Emoji ID: ${reaction.emoji.id}, User ID: ${user.id}, Expected Voucher ID: ${voucherMember.id}`);
      return ['👍', '👎'].includes(reaction.emoji.name) && user.id === voucherMember.id;
    };

    const collector = vouchRequestMessage.createReactionCollector({
      filter,
      max: 1, 
      time: VOUCH_REACTION_TIME_LIMIT, 
    });

    // Update conversation state to VOUCH_PROCESS_ACTIVE
    await recruitmentCollection.updateOne(
      { userId: newMember.id }, 
      { $set: { 
          "conversationState.currentStep": ConversationStep.VOUCH_PROCESS_ACTIVE,
          "conversationState.activeCollectorType": 'VOUCH_REACTION',
          "conversationState.vouchInitiatorId": voucherMember.id, // Store who is being asked to vouch
          "conversationState.stepEntryTimestamp": new Date(),
          "conversationState.timeoutTimestamp": new Date(Date.now() + VOUCH_REACTION_TIME_LIMIT)
        } 
      }
    );

    collector.on("collect", async (reaction, user) => {
      console.log(
        `[VouchProcess] Collected reaction: ${reaction.emoji.name} from ${user.tag}`
      );
      let channelDeleted = false;

      if (reaction.emoji.name === '👍') {
        await processingChannel.send(
          `🎉 ${voucherMember.user.tag} has vouched for ${newMember.user.tag}!`
        );
        
        const friendRole = guild.roles.cache.find(role => role.name === FRIEND_ROLE_NAME);
        if (friendRole) {
          try {
            await newMember.roles.add(friendRole);
            await processingChannel.send(`${newMember} has been given the "${FRIEND_ROLE_NAME}" role.`);
            console.log(`[VouchProcess] Assigned "${FRIEND_ROLE_NAME}" role to ${newMember.user.tag}`);
            
            // DM User then delete channel
            try {
                await newMember.send(`🎉 Congratulations, ${newMember.user.username}! You\'ve been vouched for by ${voucherMember.user.tag} and welcomed into the Wraiven community with the "${FRIEND_ROLE_NAME}" role!`);
                console.log(`[VouchProcess] Sent DM to ${newMember.user.tag} about successful vouch.`);
            } catch (dmError) {
                console.error(`[VouchProcess] Failed to DM ${newMember.user.tag} about vouch success:`, dmError);
                await processingChannel.send(`(Could not DM ${newMember} directly, but they have been given the role!)`);
            }
            // Channel is about to be deleted, so its ID should not persist in the active record.
            await recruitmentCollection.updateOne(
              { userId: newMember.id }, 
              { $set: { 
                  communityStatus: "VOUCH_ACCEPTED", 
                  role: friendRole.name, 
                  vouchedBy: voucherMember.id, 
                  channelId: null, 
                  "conversationState.currentStep": ConversationStep.IDLE,
                  "conversationState.stepEntryTimestamp": new Date(),
                  "conversationState.activeCollectorType": null,
                  "conversationState.timeoutTimestamp": null,
                  "conversationState.vouchInitiatorId": null
                } 
              }
            );
            await processingChannel.delete(`Vouch accepted for ${newMember.user.tag}.`);
            channelDeleted = true;
            console.log(`[VouchProcess] Deleted processing channel for ${newMember.user.tag} after successful vouch.`);

          } catch (roleError) {
            console.error(`[VouchProcess] Error assigning Friend role:`, roleError);
            await processingChannel.send(
              `I tried to assign the "${FRIEND_ROLE_NAME}" role but encountered an error. Please notify a staff member.`
            );
            await notifyStaff(guild, `Error assigning "${FRIEND_ROLE_NAME}" role to ${newMember.user.tag} (${newMember.id}) after vouch by ${voucherMember.user.tag}. Error: ${roleError.message}`, "VOUCH_ROLE_ASSIGN_ERROR");
          }
        } else {
          console.warn(`[VouchProcess] "${FRIEND_ROLE_NAME}" role not found!`);
          await processingChannel.send(
            `The "${FRIEND_ROLE_NAME}" role was not found. Please ask a staff member to create it and assign it manually for now.`
          );
          await notifyStaff(guild, `VOUCH_ACCEPTED for ${newMember.user.tag}, but "${FRIEND_ROLE_NAME}" role not found. Manual assignment needed.`, "VOUCH_ROLE_NOT_FOUND");
        }
      } else if (reaction.emoji.name === '👎') {
        await processingChannel.send(
          `Okay, ${voucherMember.user.tag} has indicated they cannot vouch for ${newMember.user.tag} at this time. This channel will now be closed. A recruiter will follow up with ${newMember.user.tag} if necessary.`
        );
        console.log(`[VouchProcess] ${voucherMember.user.tag} denied vouch for ${newMember.user.tag}`);
        await recruitmentCollection.updateOne(
            { userId: newMember.id }, 
            { $set: { 
                communityStatus: "VOUCH_DENIED", 
                vouchedBy: voucherMember.id, 
                channelId: null, 
                "conversationState.currentStep": ConversationStep.IDLE,
                "conversationState.stepEntryTimestamp": new Date(),
                "conversationState.activeCollectorType": null,
                "conversationState.timeoutTimestamp": null,
                "conversationState.vouchInitiatorId": null
              } 
            }
        );
        await notifyStaff(guild, `${voucherMember.user.tag} denied vouch for ${newMember.user.tag} (${newMember.id}). Processing channel deleted.`, "VOUCH_DENIED");
        await processingChannel.delete(`Vouch denied for ${newMember.user.tag}.`);
        channelDeleted = true;
        console.log(`[VouchProcess] Deleted processing channel for ${newMember.user.tag} after vouch denial.`);
      }

      if (!channelDeleted) {
        // Optional: Clean up voucher permissions if channel wasn't deleted (e.g. error during role assignment)
        // await processingChannel.permissionOverwrites.delete(voucherMember.id);
        // console.log(`[VouchProcess] Revoked ${voucherMember.user.tag} access from #${processingChannel.name}`);
      }
    });

    collector.on("end", async (collected, reason) => {
      if (reason === "time" && collected.size === 0) {
        console.log(
          `[VouchProcess] Vouch request for ${newMember.user.tag} by ${voucherMember.user.tag} timed out.`
        );
        // Check if channel still exists before trying to send a message or delete
        const channelExists = guild.channels.cache.get(processingChannel.id);
        if (channelExists) {
            await processingChannel.send(
              `The vouch request for ${newMember.user.tag} (via ${voucherMember.user.tag}) timed out. This channel will now be closed. A recruiter will follow up.`
            );
            await recruitmentCollection.updateOne(
                { userId: newMember.id }, 
                { $set: { 
                    communityStatus: "VOUCH_TIMEOUT", 
                    channelId: null, 
                    "conversationState.currentStep": ConversationStep.IDLE,
                    "conversationState.stepEntryTimestamp": new Date(),
                    "conversationState.activeCollectorType": null,
                    "conversationState.timeoutTimestamp": null,
                    "conversationState.vouchInitiatorId": null
                  } 
                }
            );
            await notifyStaff(guild, `Vouch request for ${newMember.user.tag} (${newMember.id}) by ${voucherMember.user.tag} timed out. Processing channel deleted.`, "VOUCH_TIMEOUT");
            await processingChannel.delete(`Vouch timed out for ${newMember.user.tag}.`);
            console.log(`[VouchProcess] Deleted processing channel for ${newMember.user.tag} after vouch timeout.`);
        } else {
            console.log(`[VouchProcess] Channel for ${newMember.user.tag} already deleted when vouch timed out.`);
            // Ensure DB is updated even if channel was gone
            await recruitmentCollection.updateOne(
                { userId: newMember.id }, 
                { $set: { 
                    communityStatus: "VOUCH_TIMEOUT", 
                    channelId: null, 
                    "conversationState.currentStep": ConversationStep.IDLE, // Ensure state is IDLE
                    "conversationState.stepEntryTimestamp": new Date(),
                    "conversationState.activeCollectorType": null,
                    "conversationState.timeoutTimestamp": null,
                    "conversationState.vouchInitiatorId": null
                    } 
                }
            ).catch(err => console.error("[VouchProcess] DB update error on timeout for already deleted channel:", err));
        }
      }
      // No need to clean up perms if channel is deleted
    });

  } catch (error) {
    console.error("[VouchProcess] Error in initiateVouchProcess:", error);
    if (guild.channels.cache.get(processingChannel.id)) {
        await processingChannel.send(
          "An unexpected error occurred while trying to process the vouch. Please notify a staff member."
        ).catch(e => console.error("Failed to send error message to processing channel:", e));
    }
    await notifyStaff(guild, `Unexpected error in initiateVouchProcess for new member ${newMember.user.tag} (ID: ${newMember.id}), voucher ${voucherMember.user.tag}. Error: ${error.message}`, "VOUCH_SYSTEM_ERROR");
  }
} 