import { Events } from "discord.js";

export default function interactionCreate(client, database) {
  client.on(Events.MessageCreate, async (message) => {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Check if the message is in a processing channel
    const processingChannelPattern = /^processing-/;
    if (
      message.channel.name &&
      processingChannelPattern.test(message.channel.name)
    ) {
      const userId = message.author.id;
      const username = message.author.username;
      const sanitizedContent = message.content.trim();

      console.log("from onMessageCreate");

      if (!sanitizedContent) {
        console.log(
          "Message is empty or contains only whitespace. Skipping storage."
        );
        return; // Skip storing invalid messages
      }

      console.log(`Sanitized message from ${username}: "${sanitizedContent}"`);

      const recruitmentCollection = database.collection("recruitment");

      // Fetch the primary document for the channel
      const existingEntry = await recruitmentCollection.findOne({ userId });

      if (existingEntry) {
        // Merge new message into the `messageHistory`
        await recruitmentCollection.updateOne(
          { userId }, // Find by channelId to maintain one document per channel
          {
            $set: {
              username: existingEntry.username, // Keep the primary user's username consistent
              userId: existingEntry.userId, // Keep the primary user's ID consistent
            },
            $push: {
              messageHistory: {
                userId,
                username,
                role: "user",
                content: sanitizedContent,
                timestamp: new Date().toISOString(),
              },
            },
          }
        );
      } else {
        // If no entry exists, initialize a new document for the channel
        await recruitmentCollection.insertOne({
          userId,
          username,
          messageHistory: [
            {
              userId,
              username,
              role: "user",
              content: sanitizedContent,
              timestamp: new Date().toISOString(),
            },
          ],
          applicationStatus: "PENDING", // Default application status for new users
          role: "Outsider", // Default role for the primary user
        });
      }

      if (!message.guild) return; // DM or other

      // Check if this is a "processing" channel
      // In your DB you can see if `channelId` == message.channel.id
      const userData = await recruitmentCollection.findOne({
        channelId: message.channel.id,
      });
      if (!userData) return; // Not a tracked channel

      // Update lastActivityAt
      await recruitmentCollection.updateOne(
        { userId: userData.userId },
        { $set: { lastActivityAt: Date.now() } }
      );
    }
  });
}
