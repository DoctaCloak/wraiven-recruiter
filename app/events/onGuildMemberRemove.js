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

      if (userData && userData.channelId) {
        const processingChannelId = userData.channelId;
        console.log(`[Member Left] User ${member.user.tag} had a processing channel ID: ${processingChannelId}`);

        const channel = member.guild.channels.cache.get(processingChannelId);

        if (channel) {
          try {
            await channel.delete(`Processing channel for user ${member.user.tag} who left.`);
            console.log(`[Member Left] Successfully deleted processing channel ${channel.name} (ID: ${processingChannelId}) for user ${member.user.tag}.`);
          } catch (deleteError) {
            console.error(`[Member Left] Failed to delete channel ${processingChannelId} for user ${member.user.tag}:`, deleteError);
            // Optionally, still try to update the DB to prevent retries if channel is just inaccessible
          }
        }
         else {
          console.log(`[Member Left] Processing channel ID ${processingChannelId} for user ${member.user.tag} was not found (already deleted or invalid ID).`);
        }

        // Update the database to remove the channelId or mark as deleted, regardless of successful deletion (to prevent retries on non-existent channels)
        try {
          await recruitmentCollection.updateOne(
            { userId }, 
            { $set: { channelId: null, communityStatus: "LEFT_SERVER", applicationStatus: "LEFT_SERVER" } } // Or some other status like channelDeleted: true
          );
          console.log(`[Member Left] Updated database for ${member.user.tag}, removing channel ID.`);
        } catch (dbUpdateError) {
          console.error(`[Member Left] Failed to update database for ${member.user.tag} after channel processing:`, dbUpdateError);
        }

      } else {
        console.log(`[Member Left] No processing channel was associated with ${member.user.tag} in the database.`);
      }
    } catch (error) {
      console.error(`[Member Left] Error processing guildMemberRemove event for ${member.user.tag}:`, error);
    }
  });
} 