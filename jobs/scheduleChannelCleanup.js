// scheduleChannelCleanup.js
import { CronJob } from "cron";

/**
 * Schedules a daily cleanup job that deletes "processing" channels
 * if the user hasn't interacted within the last 3 days.
 *
 * @param {Client} client - The Discord.js client.
 * @param {Db} database - The MongoDB database instance.
 * @param {string} guildId - The ID of your server.
 */
export default function scheduleProcessingChannelCleanup(
  client,
  database,
  guildId
) {
  // Run every day at 2 AM.
  // (Cron format: second, minute, hour, day-of-month, month, day-of-week)
  const job = new CronJob("0 2 * * *", async () => {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.error(`Guild with ID ${guildId} not found.`);
        return;
      }

      const recruitmentCollection = database.collection("recruitment");

      // Define the 1 day threshold in milliseconds
      const THREE_DAYS_MS = 1 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - THREE_DAYS_MS;

      // Find all users whose lastActivityAt (or joinedAt) is older than 3 days,
      // and who still have a `channelId` set.
      const staleUsers = await recruitmentCollection
        .find({
          channelId: { $ne: null },
          // If you track 'lastActivityAt', use that; otherwise 'joinedAt'
          $or: [
            { lastActivityAt: { $lt: cutoff } },
            { lastActivityAt: { $exists: false } }, // never updated
          ],
        })
        .toArray();

      for (const userData of staleUsers) {
        const channelId = userData.channelId;
        const channel = guild.channels.cache.get(channelId);

        if (channel) {
          // Delete or archive the channel
          await channel.delete(
            `Inactive for over 3 days (user: ${userData.username}).`
          );
          console.log(
            `Deleted channel #${channel.name} for user ${userData.username}.`
          );

          // Update DB to nullify the channelId so we don't try to delete again
          await recruitmentCollection.updateOne(
            { userId: userData.userId },
            { $set: { channelId: null } }
          );
        }
      }
    } catch (error) {
      console.error(`Error running channel cleanup job: `, error);
    }
  });

  // Start the scheduled job
  job.start();
}
