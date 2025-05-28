import { config } from "dotenv";

import scheduleProcessingChannelCleanup from "../../jobs/scheduleChannelCleanup.js";

config();

const { GUILD_ID } = process.env;

export default function onReady(client, database) {
  client.once("ready", () => {
    // Replace with your actual guild/server ID
    scheduleProcessingChannelCleanup(client, database, GUILD_ID);

    console.log(`Bot is ready, and channel cleanup job is scheduled.`);
  });
}
