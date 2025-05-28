import fs from "fs";
import path from "node:path";

import { REST, Routes } from "discord.js";
import { config } from "dotenv";

config();
const { APP_ID, DISCORD_TOKEN, GUILD_ID } = process.env;

// const { clientId, guildId, token } = require("./config.json");

const commands = [];

const ROOT_DIR = process.cwd();

// Path to the commands directory
const commandsPath = path.join(ROOT_DIR, "app/commands");
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js"));

// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  // Dynamically import the command module
  // Ensure your Node version supports top-level await or run this in an async function if not.
  const commandModule = await import(`file://${filePath}`);
  const command = commandModule.default; // Adjust if your command modules export differently

  if (command && "data" in command && "execute" in command) {
    commands.push(command.data.toJSON());
  } else {
    console.log(
      `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
    );
  }
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(DISCORD_TOKEN);

// and deploy your commands!
(async () => {
  try {
    console.log(
      `Started refreshing ${commands.length} application (/) commands.`
    );

    // The put method is used to fully refresh all commands in the guild with the current set
    const data = await rest.put(
      Routes.applicationGuildCommands(APP_ID, GUILD_ID),
      { body: commands }
    );

    console.log(
      `Successfully reloaded ${data.length} application (/) commands.`
    );
  } catch (error) {
    // And of course, make sure you catch and log any errors!
    console.error(error);
  }
})();
