import { PermissionsBitField } from "discord.js";

// Configuration - consider moving to a config file or environment variables
const FRIEND_ROLE_NAME = "Friend"; // The name of the role to assign upon successful vouch
const VOUCH_REACTION_TIME_LIMIT = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

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
 */
export async function initiateVouchProcess(
  newMember,
  voucherMember,
  processingChannel,
  llmResponse, // We might use entities from here for the message
  recruitmentCollection // Needed for updating DB status
) {
  console.log(
    `[VouchProcess] Initiating for ${newMember.user.tag} by ${voucherMember.user.tag} in #${processingChannel.name}`
  );

  try {
    // 1. Grant voucherMember access to the processingChannel
    await processingChannel.permissionOverwrites.edit(voucherMember.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true, // Good to have so they see context
    });
    console.log(
      `[VouchProcess] Granted ${voucherMember.user.tag} access to #${processingChannel.name}`
    );

    // 2. Send notification message to the voucher in the processingChannel
    const vouchRequestMessage = await processingChannel.send({
      content: 
        `Hi ${voucherMember}! 👋\n\n` +
        `${newMember} has joined and mentioned they know you. They're interested in joining the Wraiven community!\n\n` +
        `Could you please confirm if you can vouch for them? React with 👍 (thumbs up) to this message to confirm, or 👎 (thumbs down) if you cannot. \n` +
        `You have 24 hours to respond. If you have any questions, feel free to ask them here.\n\n` +
        `_Original statement from ${newMember.user.username}: "${llmResponse.entities?.original_vouch_text || 'User mentioned you'}"_`,
      allowedMentions: { users: [voucherMember.id, newMember.id] }, // Ensure voucher is pinged
    });

    // Add reactions for easy clicking
    await vouchRequestMessage.react('👍');
    await vouchRequestMessage.react('👎');

    console.log(
      `[VouchProcess] Sent vouch request message to #${processingChannel.name}`
    );

    // 3. Set up reaction collector
    const filter = (reaction, user) => {
      console.log(`[VouchProcess DEBUG] Reaction received: Emoji Name: "${reaction.emoji.name}", Emoji ID: ${reaction.emoji.id}, User ID: ${user.id}, Expected Voucher ID: ${voucherMember.id}`);
      return ['👍', '👎'].includes(reaction.emoji.name) && user.id === voucherMember.id;
    };

    const collector = vouchRequestMessage.createReactionCollector({
      filter,
      max: 1, // Collect only one reaction from the voucher
      time: VOUCH_REACTION_TIME_LIMIT, 
    });

    collector.on("collect", async (reaction, user) => {
      console.log(
        `[VouchProcess] Collected reaction: ${reaction.emoji.name} from ${user.tag}`
      );
      const guild = newMember.guild; // Or voucherMember.guild

      if (reaction.emoji.name === '👍') {
        // VOUCH ACCEPTED
        await processingChannel.send(
          `🎉 ${voucherMember.user.tag} has vouched for ${newMember.user.tag}!`
        );
        
        const friendRole = guild.roles.cache.find(role => role.name === FRIEND_ROLE_NAME);
        if (friendRole) {
          try {
            await newMember.roles.add(friendRole);
            await processingChannel.send(`${newMember} has been given the "${FRIEND_ROLE_NAME}" role.`);
            console.log(`[VouchProcess] Assigned "${FRIEND_ROLE_NAME}" role to ${newMember.user.tag}`);
            // Update DB
            await recruitmentCollection.updateOne(
              { userId: newMember.id }, 
              { $set: { communityStatus: "VOUCH_ACCEPTED", role: friendRole.name, vouchedBy: voucherMember.id } }
            );
          } catch (roleError) {
            console.error(`[VouchProcess] Error assigning Friend role:`, roleError);
            await processingChannel.send(
              `I tried to assign the "${FRIEND_ROLE_NAME}" role but encountered an error. Please notify a staff member.`
            );
          }
        } else {
          console.warn(`[VouchProcess] "${FRIEND_ROLE_NAME}" role not found!`);
          await processingChannel.send(
            `The "${FRIEND_ROLE_NAME}" role was not found. Please ask a staff member to create it and assign it manually for now.`
          );
        }
      } else if (reaction.emoji.name === '👎') {
        // VOUCH DENIED
        await processingChannel.send(
          `Okay, ${voucherMember.user.tag} has indicated they cannot vouch for ${newMember.user.tag} at this time. A recruiter will follow up with ${newMember.user.tag}.`
        );
        console.log(`[VouchProcess] ${voucherMember.user.tag} denied vouch for ${newMember.user.tag}`);
        // Update DB
        await recruitmentCollection.updateOne(
            { userId: newMember.id }, 
            { $set: { communityStatus: "VOUCH_DENIED", vouchedBy: voucherMember.id } }
        );
        // TODO: Notify recruiters/staff
      }

      // Optional: Clean up voucher permissions after action or timeout
      // await processingChannel.permissionOverwrites.delete(voucherMember.id);
      // console.log(`[VouchProcess] Revoked ${voucherMember.user.tag} access from #${processingChannel.name}`);
    });

    collector.on("end", async (collected, reason) => {
      if (reason === "time" && collected.size === 0) {
        console.log(
          `[VouchProcess] Vouch request for ${newMember.user.tag} by ${voucherMember.user.tag} timed out.`
        );
        await processingChannel.send(
          `The vouch request for ${newMember.user.tag} (via ${voucherMember.user.tag}) timed out. A recruiter will follow up.`
        );
        // Update DB
         await recruitmentCollection.updateOne(
            { userId: newMember.id }, 
            { $set: { communityStatus: "VOUCH_TIMEOUT" } }
        );
        // TODO: Notify recruiters/staff
      }
      // Optional: Clean up voucher permissions if not done in "collect"
      // This ensures permissions are cleaned up even on timeout if you want that behavior.
      // Consider if you want to remove access if they never reacted.
      // await processingChannel.permissionOverwrites.delete(voucherMember.id);
      // console.log(`[VouchProcess] Revoked ${voucherMember.user.tag} access from #${processingChannel.name} (on collector end)`);
    });

  } catch (error) {
    console.error("[VouchProcess] Error in initiateVouchProcess:", error);
    await processingChannel.send(
      "An unexpected error occurred while trying to process the vouch. Please notify a staff member."
    );
  }
} 