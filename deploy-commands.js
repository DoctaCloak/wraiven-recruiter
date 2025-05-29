import fs from "fs";
import path from "node:path";
import { REST, Routes } from "discord.js";
import { config } from "dotenv"; // Using the simpler dotenv import and call

config(); // Load .env from the current working directory (e.g., recruiter/.env)

const { APP_ID, DISCORD_TOKEN, GUILD_ID } = process.env;

// Validate essential environment variables
if (!APP_ID || !DISCORD_TOKEN || !GUILD_ID) {
  console.error("Error: Missing essential environment variables (APP_ID, DISCORD_TOKEN, or GUILD_ID).");
  console.error("Please ensure your .env file is correctly set up in the root of the 'recruiter' application directory.");
  process.exit(1); // Exit if essential vars are missing
}

const commands = [];

// process.cwd() will be /usr/src/app in Docker, which is the root of the recruiter app
const commandsPath = path.join(process.cwd(), "app/commands"); 

console.log(`[DeployCommands] Looking for command files in: ${commandsPath}`);

let commandFiles = [];
try {
    commandFiles = fs
        .readdirSync(commandsPath)
        .filter((file) => file.endsWith(".js"));
} catch (error) {
    console.error(`[DeployCommands] Error reading commands directory at ${commandsPath}:`, error);
    process.exit(1);
}

if (commandFiles.length === 0) {
    console.warn(`[DeployCommands] No command files found in ${commandsPath}. Nothing to register.`);
} else {
    console.log(`[DeployCommands] Found command files: ${commandFiles.join(', ')}`);
}

// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  try {
    // Dynamically import the command module
    const commandModule = await import(`file://${filePath}`);
    // Adjust if your command modules export differently (e.g., commandModule.commandData if not default)
    const command = commandModule.default || commandModule.command; 

    if (command && command.data && typeof command.data.toJSON === 'function') {
      commands.push(command.data.toJSON());
      console.log(`[DeployCommands] Successfully loaded command from ${file}`);
    } else {
      console.warn(
        `[WARNING] The command at ${filePath} is missing a required "data" property with a toJSON method, or the module structure is unexpected.`
      );
    }
  } catch (error) {
    console.error(`[ERROR] Failed to load command at ${filePath}:`, error);
  }
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(DISCORD_TOKEN);

// and deploy your commands!
(async () => {
  if (commands.length === 0) {
    console.log("[DeployCommands] No valid commands were loaded. Skipping deployment to Discord.");
    return;
  }
  try {
    console.log(
      `[DeployCommands] Started refreshing ${commands.length} application (/) commands for guild ${GUILD_ID}.`
    );

    // The put method is used to fully refresh all commands in the guild with the current set
    const data = await rest.put(
      Routes.applicationGuildCommands(APP_ID, GUILD_ID),
      { body: commands }
    );

    console.log(
      `[DeployCommands] Successfully reloaded ${data.length} application (/) commands.`
    );
  } catch (error) {
    console.error("[DeployCommands] Error during command deployment to Discord:", error);
  }
})();
