import { Events } from "discord.js";

/**
 * Handles the event when a guild member leaves or is removed.
 * - Checks if the member had a processing channel associated with them.
 * - If so, deletes the channel and updates the database.
 */
export default function onGuildMemberRemove(client, database) {
  client.on(Events.GuildMemberRemove, async (member) => {
    console.log(`[Member Left] ${member.user.tag} (ID: ${member.id}) left or was removed from the guild ${member.guild.name}.`);

    const recruitmentCollection = database.collection("recruitment");
    const userId = member.id;

    try {
      const userData = await recruitmentCollection.findOne({ userId });

      if (userData) {
        let channelsToDelete = [];
        if (userData.channelId) {
            channelsToDelete.push({ id: userData.channelId, type: "Processing Channel" });
        }
        if (userData.ticketChannelId) {
            channelsToDelete.push({ id: userData.ticketChannelId, type: "Recruitment Ticket" });
        }

        if (channelsToDelete.length > 0) {
            console.log(`[Member Left] User ${member.user.tag} had associated channels.`);
            for (const chInfo of channelsToDelete) {
                const channel = member.guild.channels.cache.get(chInfo.id);
                if (channel) {
                    try {
                        await channel.delete(`${chInfo.type} for user ${member.user.tag} who left.`);
                        console.log(`[Member Left] Successfully deleted ${chInfo.type} ${channel.name} (ID: ${chInfo.id}) for user ${member.user.tag}.`);
                    } catch (deleteError) {
                        console.error(`[Member Left] Failed to delete ${chInfo.type} (ID: ${chInfo.id}) for user ${member.user.tag}:`, deleteError);
                    }
                } else {
                    console.log(`[Member Left] ${chInfo.type} (ID: ${chInfo.id}) for user ${member.user.tag} was not found (already deleted or invalid ID).`);
                }
            }

            // Update the database to remove channel IDs and set status
            try {
              const updateQuery = {
                $set: {
                  communityStatus: "LEFT_SERVER",
                  applicationStatus: "LEFT_SERVER", // Or more specific like "APPLICATION_CANCELLED_LEFT_SERVER"
                  channelId: null, // Ensure processing channel ID is nulled
                  ticketChannelId: null, // Ensure ticket channel ID is nulled
                  "conversationState.currentStep": "IDLE", // Reset conversation state
                  "conversationState.activeCollectorType": null,
                  "conversationState.timeoutTimestamp": null
                }
              };
              await recruitmentCollection.updateOne({ userId }, updateQuery);
              console.log(`[Member Left] Updated database for ${member.user.tag}, removing channel IDs and setting status.`);
            } catch (dbUpdateError) {
              console.error(`[Member Left] Failed to update database for ${member.user.tag} after channel processing:`, dbUpdateError);
            }
        } else {
            console.log(`[Member Left] No processing or ticket channel was associated with ${member.user.tag} in the database.`);
             // Still update status if user record exists but no channels were linked
            try {
                await recruitmentCollection.updateOne(
                    { userId }, 
                    { $set: { 
                        communityStatus: "LEFT_SERVER", 
                        applicationStatus: "LEFT_SERVER",
                        "conversationState.currentStep": "IDLE",
                        "conversationState.activeCollectorType": null,
                        "conversationState.timeoutTimestamp": null
                    } }
                );
                console.log(`[Member Left] Updated status for ${member.user.tag} (no channels found).`);
            } catch (dbUpdateError) {
                console.error(`[Member Left] Failed to update status for ${member.user.tag} (no channels found):`, dbUpdateError);
            }
        }
      } else {
        console.log(`[Member Left] No data found for ${member.user.tag} in the database.`);
      }
    } catch (error) {
      console.error(`[Member Left] Error processing guildMemberRemove event for ${member.user.tag}:`, error);
    }
  });
} 