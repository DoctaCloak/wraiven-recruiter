import fs from "fs";
import path from "path";

import "dotenv/config";
import express from "express";
import { config } from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
} from "discord.js";

// Load environment variables
config();

const ROOT_DIR = process.cwd();

// Validate environment variables
const { DISCORD_TOKEN, PUBLIC_KEY } = process.env;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const username = encodeURIComponent("doctacloak");
const password = encodeURIComponent("lY6vNE59x0irLdFH");

const uri = `mongodb+srv://${username}:${password}@housevalier.hrmke.mongodb.net/?retryWrites=true&w=majority&appName=HouseValier`;

const MONGO_CLIENT = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let database;

async function run() {
  try {
    // The connect() method does not attempt a connection; instead it instructs
    // the driver to connect using the settings provided when a connection
    // is required.
    await MONGO_CLIENT.connect();

    // Provide the name of the database and collection you want to use.
    // If the database and/or collection do not exist, the driver and Atlas
    // will create them automatically when you first write data.
    const databaseName = "HouseValier";

    // Create references to the database and collection in order to run
    // operations on them.
    database = MONGO_CLIENT.db(databaseName);

    // Send a ping to confirm a successful connection
    await MONGO_CLIENT.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}

run().catch(console.dir);

if (!DISCORD_TOKEN || !PUBLIC_KEY) {
  console.error("DISCORD_TOKEN and PUBLIC_KEY are required");
  process.exit(1);
}

// Load functions dynamically
// const FUNCTION_FOLDERS = fs.readdirSync(
//   path.resolve(ROOT_DIR, "app/functions")
// );

// for (const folder of FUNCTION_FOLDERS) {
//   const functionFiles = fs.readdirSync(
//     path.resolve(ROOT_DIR, "app/functions", folder)
//   );

//   for (const file of functionFiles) {
//     try {
//       const module = await import(
//         path.resolve(ROOT_DIR, "app/functions", folder, file)
//       );

//       if (typeof module.default === "function") {
//         module.default(client);
//       }
//     } catch (error) {
//       console.error(`Error loading function file ${file}:`, error);
//     }
//   }
// }

// Create a new client instance
/*
 * he GatewayIntentBits.Guilds intents option is necessary for the discord.js client to work as you expect it to,
 * as it ensures that the caches for guilds, channels, and roles are populated and available for internal use.
 *
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent, // Required to access message content
  ],
});

client.commands = new Collection();

const COMMANDS_FOLDER = path.join(ROOT_DIR, "app/commands");
const commandFolders = fs.readdirSync(COMMANDS_FOLDER);

for (const commandSubfolder of commandFolders) {
  const commandsPath = path.join(COMMANDS_FOLDER, commandSubfolder);

  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const { default: command } = await import(`${filePath}`);

    // Set a new item in the Collection with the key as the command anme and hte value as the exported module
    if ("data" in command && "execute" in command) {
      client.commands.set(command.data.name, command);
    } else {
      console.log(
        `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
      );
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "There was an error while executing this command!",
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: "There was an error while executing this command!",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

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

client.on(Events.GuildMemberAdd, async (member) => {
  const guild = member.guild;
  const recruitmentCollection = database.collection("recruitment");

  // Lookup user by userId (Discord unique ID)
  const userId = member.user.id;
  const userData = await recruitmentCollection.findOne({ userId });

  if (userData) {
    // Re-engage existing user
    console.log(`User ${member.user.tag} rejoined the server.`);
    const { username, applicationStatus, role, messageHistory } = userData;

    // Apply stored role
    const storedRole = guild.roles.cache.find((r) => r.name === role);
    if (storedRole && !member.roles.cache.has(storedRole.id)) {
      try {
        await member.roles.add(storedRole);
        console.log(`Reassigned role "${role}" to ${member.user.tag}`);
      } catch (error) {
        console.error(
          `Error reassigning role "${role}" to ${member.user.tag}:`,
          error
        );
      }
    }

    // Re-engage with a personalized message in the channel
    const existingChannel = guild.channels.cache.find(
      (channel) => channel.id === userData.channelId
    );

    let channel;
    if (existingChannel) {
      channel = existingChannel;
    } else {
      // Recreate channel if it doesn't exist
      const category = guild.channels.cache.find(
        (channel) => channel.type === 4 && channel.name === "City Gates"
      );
      const channelName = `processing-${member.user.username}`;
      channel = await guild.channels.create({
        name: channelName,
        type: 0, // Text channel
        parent: category ? category.id : null,
      });
      await recruitmentCollection.updateOne(
        { userId },
        { $set: { channelId: channel.id } }
      );

      // Set permissions for the channel
      const permissionOverwrites = [
        {
          id: guild.id, // Default role (everyone)
          deny: [PermissionsBitField.Flags.ViewChannel], // Deny access for everyone
        },
        {
          id: member.id, // New member
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ];

      // Define roles that should have access
      const recruiterRole = guild.roles.cache.find(
        (role) => role.name === "Recruiter"
      );
      const botRole = guild.roles.cache.find(
        (role) => role.name === "House Valier Bot"
      );

      const outsiderRole = guild.roles.cache.find(
        (role) => role.name.toUpperCase() === "OUTSIDER"
      );

      // Add Recruiter role permissions if it exists
      if (recruiterRole) {
        permissionOverwrites.push({
          id: recruiterRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
          ],
        });
      }

      // Add House Valier Bot role permissions if it exists
      if (botRole) {
        permissionOverwrites.push({
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

      await channel.permissionOverwrites.set(permissionOverwrites);

      console.log(`Channel "${channelName}" created for ${member.user.tag}`);

      // Send a DM with the channel link
      const channelLink = `https://discord.com/channels/${guild.id}/${channel.id}`;
      await member.send(
        `Welcome to the server, ${member.user.username}! Please proceed to your private channel here: ${channelLink}`
      );
    }

    // Send personalized welcome back message
    await channel.send(
      `Hey welcome back, ${member.user.username}! ${
        messageHistory?.length
          ? "Are you here to continue playing with CJ again, or is your visit this time different?"
          : "Let us know how we can help you this time!"
      }`
    );
  } else {
    // New user logic
    console.log(`New user ${member.user.tag} joined the server.`);

    // Assign Outsider role
    const outsiderRole = guild.roles.cache.find(
      (role) => role.name === "Outsider"
    );
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

    // Initialize user in the database
    try {
      await recruitmentCollection.updateOne(
        { userId },
        {
          $set: {
            userId, // Unique Discord user ID
            username: member.user.username, // Track username
            channelId: null, // Channel will be created below
            messageHistory: [], // Empty history for new users
            applicationStatus: ACCESS_STATUS.PENDING, // Default guild application status
            communityStatus: COMMUNITY_STATUS.PENDING, // Default community status
            role: outsiderRole ? "Outsider" : null, // Set default role
          },
        },
        { upsert: true } // Create the document if it doesn't exist
      );
      console.log(`Initialized database entry for ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Error initializing database entry for ${member.user.tag}:`,
        error
      );
    }

    // Create channel for the user
    const category = guild.channels.cache.find(
      (channel) => channel.type === 4 && channel.name === "City Gates"
    );
    const channelName = `processing-${member.user.username}`;
    const channel = await guild.channels.create({
      name: channelName,
      type: 0, // Text channel
      parent: category ? category.id : null,
    });

    // Update the database with the channel ID
    await recruitmentCollection.updateOne(
      { userId },
      { $set: { channelId: `processing-${channel.id}` } }
    );

    // Send welcome message
    await channel.send(
      `Hello, ${member.user.username}, welcome to House Valier!`
    );
    await channel.send(
      "What is your purpose for joining the House Valier Discord channel?"
    );
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  const guild = member.guild;

  console.log(`User ${member.user.tag} left or was removed from the server.`);

  try {
    // Fetch audit logs to check for kick
    const auditLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: "MEMBER_KICK",
    });

    const kickLog = auditLogs.entries.first();

    if (kickLog) {
      const { target, executor, reason, createdTimestamp } = kickLog;

      // Ensure the kick log is recent and matches the removed member
      const timeSinceKick = Date.now() - createdTimestamp;
      if (target.id === member.user.id && timeSinceKick < 5000) {
        console.log(
          `User ${member.user.tag} was kicked by ${executor.tag} for reason: ${
            reason || "No reason provided."
          }`
        );

        // Update database to reflect the kick
        const recruitmentCollection = db.collection("recruitment");
        await recruitmentCollection.updateOne(
          { userId: member.user.id },
          {
            $set: {
              applicationStatus: "DENIED",
              kickedBy: executor.tag,
              kickReason: reason || "No reason provided",
            },
          }
        );

        // Optional: Notify an admin channel
        const adminChannel = guild.channels.cache.find(
          (channel) => channel.name === "admin-logs" // Replace with your admin log channel
        );
        if (adminChannel) {
          await adminChannel.send(
            `🚨 User **${member.user.tag}** was kicked by **${
              executor.tag
            }**. Reason: ${reason || "No reason provided"}`
          );
        }

        return; // Exit after handling the kick
      }
    }

    // If no kick log was found or the user wasn't kicked, assume they left voluntarily
    console.log(`User ${member.user.tag} left voluntarily.`);

    // Find the "Outsider" role
    const outsiderRole = guild.roles.cache.find(
      (role) => role.name === "Outsider"
    );

    if (!outsiderRole) {
      console.error("Outsider role not found.");
      return; // Exit if the role doesn't exist
    }

    // Check if the user had the "Outsider" role
    const hadOutsiderRole = member.roles.cache.has(outsiderRole.id);

    if (hadOutsiderRole) {
      console.log(
        `${member.user.tag} had the Outsider role, checking for their processing channel...`
      );

      // Find the user's processing channel
      const channelName = `processing-${member.user.username}`;
      const processingChannel = guild.channels.cache.find(
        (channel) => channel.name === channelName
      );

      // If the channel exists, delete it
      if (processingChannel) {
        try {
          await processingChannel.delete();
          console.log(
            `Deleted processing channel: ${channelName} for ${member.user.tag}`
          );
        } catch (error) {
          console.error(`Failed to delete channel ${channelName}:`, error);
        }
      } else {
        console.log(`No processing channel found for ${member.user.tag}.`);
      }
    } else {
      console.log(
        `${member.user.tag} did not have the Outsider role. No action taken.`
      );
    }
  } catch (error) {
    console.error(
      `Error handling guildMemberRemove for ${member.user.tag}:`,
      error
    );
  }
});

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

    // // Sort `messageHistory` by timestamp
    // await recruitmentCollection.updateOne(
    //   { channel.id },
    //   {
    //     $push: {
    //       messageHistory: {
    //         $each: [],
    //         $sort: { timestamp: 1 },
    //       },
    //     },
    //   }
    // );
  }
});

// When the client is ready, run this code (only once).
// The distinction between `client: Client<boolean>` and `readyClient: Client<true>` is important for TS developers
client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready!  \nLogged in as ${readyClient.user.tag}`);
});

client.on(Events.GuildBanAdd, async (ban) => {
  const { user, guild } = ban;

  console.log(`User ${user.tag} was banned from the server.`);

  try {
    // Fetch audit logs to check for the ban
    const auditLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: "MEMBER_BAN_ADD",
    });

    const banLog = auditLogs.entries.first();

    if (banLog) {
      const { target, executor, reason } = banLog;

      if (target.id === user.id) {
        console.log(
          `User ${user.tag} was banned by ${executor.tag} for reason: ${
            reason || "No reason provided."
          }`
        );

        // Update database to reflect the ban
        const recruitmentCollection = db.collection("recruitment");
        await recruitmentCollection.updateOne(
          { userId: user.id },
          {
            $set: {
              banStatus: true,
              applicationStatus: "DENIED",
              kickedBy: executor.tag,
              kickReason: reason || "Banned",
            },
          }
        );

        // Optional: Notify an admin channel
        const adminChannel = guild.channels.cache.find(
          (channel) => channel.name === "admin-logs"
        );
        if (adminChannel) {
          await adminChannel.send(
            `🚨 User **${user.tag}** was banned by **${
              executor.tag
            }**. Reason: ${reason || "No reason provided"}`
          );
        }
      }
    }
  } catch (error) {
    console.error(`Error handling guildBanAdd for ${user.tag}:`, error);
  }
});

// Log in to Discord
client.login(DISCORD_TOKEN);

// Create an Express app
const app = express();

app.use(express.json()); // Middleware for parsing JSON requests

// Get port, or default to 3000
const PORT = process.env.PORT || 3001;

// Start server
app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
