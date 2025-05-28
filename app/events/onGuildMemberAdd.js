import { Events, PermissionsBitField } from "discord.js";
import { getAccountRestrictionEmbed } from "./utils/onGuildMemberAdd.js";

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
      `Hello **${member.user.username}**, welcome to Wraiven!\n` +
        `Your private channel is ready: ${channelLink}`
    );
  } catch (dmError) {
    console.error(`Failed to DM ${member.user.tag}:`, dmError);
  }

  // Post a welcome message in their channel
  await channel.send(
    `Hello, **${member.user.username}**, welcome to House Valier!`
  );
  await channel.send(
    "What is your purpose for joining the House Valier Discord channel?"
  );
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
